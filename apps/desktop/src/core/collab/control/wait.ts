import type { DatabaseSync } from "node:sqlite";
import { type AgentStatus, getAgentStatus } from "../../agent/status";
import { evaluate } from "../../dependencies/evaluate";
import { type TaskRun, finishTask, taskRun } from "../../workflow/task-runs";
import { loadNode, type Caller } from "../nodes";
import { type Args, Refused } from "../refusals";
import { type CollabContext, nowDate } from "../service";
import { type Outcome, result } from "./outcome";
import { LAUNCH_FAILED_REASON } from "../send-queue";

/**
 * `wait` — 协调者的 runner 等一个画布成员把任务做完（补全架构 §5.3，契约
 * §15.5）。
 *
 * 长轮询：`--task <taskId> [--node <id>] [--since <游标>] [--timeout <秒>]`，
 * 答 `{ status, since, events[] }`。`status` 五值：
 *
 *   * `running`：还在做（或第一条任务还没投进去）；
 *   * `done`：成员 `post` 了 `task:<taskId>:result`（成员技能规定的回报），或者
 *     投递之后它这一轮干净地结束了；
 *   * `failed`：节点没了、投递没投成、这一轮出错或被中断；
 *   * `blocked`：成员停在一个权限请求上，带 `approvalId`。**只报告**——回答它
 *     是人的事，这个动词与 runner 都不替人回答；
 *   * `needsInput`：成员在等人回一个问题。
 *
 * `events` 是游标之后的两种东西：成员发出、键以 `task:<taskId>` 开头的 `post`
 * （`sequence` 递增，不漏不重），以及状态变化（游标记着上一次报出去的状态，
 * 变了才报一条）。没有新东西、状态也没变就等，最多 `--timeout` 秒，到点答
 * `running`（或当时的 `blocked` / `needsInput`）。
 *
 * 判「这一轮干净地结束」用的是依赖编排那一份（`dependencies/evaluate.ts`）：
 * 只认投递之后的结束。基准记在进程里（{@link trackers}）而不是库里：它是时序
 * 而不是状态，重启之后第一次观察重新取基准——最坏是等到成员的 `post`。
 */

export const WAIT_STATUSES = [
  "running",
  "done",
  "failed",
  "blocked",
  "needsInput",
] as const;
export type WaitStatus = (typeof WAIT_STATUSES)[number];

/** 缺省与最长的等待（秒）。 */
export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 60;
/** 等待中隔多久看一眼库。 */
export const WAIT_POLL_MS = 250;
/** 一次最多答几条 `post`。 */
export const MAX_WAIT_EVENTS = 32;

/**
 * 任务 id：协调者给的幂等键。`post --key` 上限 128 字，`task:` 与
 * `:result:<n>` 要放得下。
 */
export const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** 成员回报结果用的键前缀；后面可以再跟 `:<轮次>`。 */
export function resultKey(taskId: string): string {
  return `task:${taskId}:result`;
}

export function validTaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

/** 游标：上一次答到的 `post` 序号与上一次报出去的状态。 */
export interface WaitCursor {
  readonly post: number;
  readonly state: string;
}

export function parseCursor(raw: string | undefined): WaitCursor | undefined {
  if (raw === undefined || raw === "") return { post: 0, state: "" };
  const match = /^(\d{1,15})(?:-([A-Za-z]{1,16}))?$/.exec(raw);
  if (match === null) return undefined;
  return { post: Number(match[1]), state: match[2] ?? "" };
}

export function formatCursor(cursor: WaitCursor): string {
  return cursor.state === ""
    ? String(cursor.post)
    : `${cursor.post}-${cursor.state}`;
}

export type WaitEvent =
  | {
      readonly type: "post";
      readonly seq: number;
      readonly key: string;
      readonly body: string;
      readonly at: string;
    }
  | {
      readonly type: "status";
      readonly state: string;
      readonly at: string | null;
    };

export interface WaitAnswer {
  readonly status: WaitStatus;
  readonly since: string;
  readonly events: readonly WaitEvent[];
  readonly taskId: string;
  readonly nodeId: string;
  /** `blocked`：挂着的那条审批。 */
  readonly approvalId?: string;
  /**
   * `failed` / `blocked` / `needsInput` 的原因码。成员启动失败（自动重试一次
   * 之后）是 `launch_failed`（契约 §52）。
   */
  readonly reason?: string;
  /** `done` 且成员 post 了结果：那条正文。 */
  readonly result?: { readonly text: string; readonly key: string };
}

/** 「投递之后这一轮」的基准，每个任务一份。 */
interface Tracker {
  armed: boolean;
  baselineEventAt: string | null;
  observedBusy: boolean;
}

const trackers = new Map<string, Tracker>();

/** 用例之间换一份干净的。 */
export function resetWaitTrackers(): void {
  trackers.clear();
}

const BUSY_STATES: readonly string[] = ["working", "waiting", "blocked"];

interface PostRow {
  sequence: number;
  message_key: string;
  body: string;
  created_at: number;
}

/** 游标之后成员发出的、键属于这个任务的 `post`，最早的在前。 */
function postsAfter(
  database: DatabaseSync,
  nodeId: string,
  taskId: string,
  after: number,
): PostRow[] {
  // 不用 LIKE：任务 id 里的 `_` 是通配符。
  const prefix = `task:${taskId}`;
  return database
    .prepare(
      "SELECT sequence, message_key, body, created_at FROM agent_mailbox " +
        "WHERE source_node_id = ? AND sequence > ? " +
        "AND (message_key = ? OR substr(message_key, 1, ?) = ?) " +
        "ORDER BY sequence LIMIT ?",
    )
    .all(
      nodeId,
      after,
      prefix,
      prefix.length + 1,
      `${prefix}:`,
      MAX_WAIT_EVENTS,
    ) as unknown as PostRow[];
}

/** 协调者投给成员的最近一条（第一条任务或之后的 `send`）。 */
function latestDelivery(
  database: DatabaseSync,
  sourceNodeId: string,
  targetNodeId: string,
): { state: string; lastReason: string | null } | undefined {
  const row = database
    .prepare(
      "SELECT state, last_reason FROM agent_send_queue " +
        "WHERE source_node_id = ? AND target_node_id = ? " +
        "ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(sourceNodeId, targetNodeId) as
    | { state: string; last_reason: string | null }
    | undefined;
  return row === undefined
    ? undefined
    : { state: row.state, lastReason: row.last_reason };
}

function isResultKey(key: string, taskId: string): boolean {
  const base = resultKey(taskId);
  return key === base || key.startsWith(`${base}:`);
}

/**
 * 此刻的状态与游标之后的事件。不等、不写库（基准除外）：{@link wait} 决定要
 * 不要再等，{@link settle} 落结束。
 */
export function observe(
  database: DatabaseSync,
  run: TaskRun,
  cursor: WaitCursor,
): WaitAnswer {
  const base = { taskId: run.taskId, nodeId: run.nodeId };
  const events: WaitEvent[] = [];
  let postCursor = cursor.post;
  let found: { text: string; key: string } | undefined;
  for (const row of postsAfter(database, run.nodeId, run.taskId, cursor.post)) {
    const seq = Number(row.sequence);
    postCursor = Math.max(postCursor, seq);
    events.push({
      type: "post",
      seq,
      key: row.message_key,
      body: row.body,
      at: new Date(Number(row.created_at) * 1000).toISOString(),
    });
    if (isResultKey(row.message_key, run.taskId)) {
      found = { text: row.body, key: row.message_key };
    }
  }

  const node = loadNode(database, run.nodeId);
  const status =
    node === undefined ? undefined : getAgentStatus(database, run.nodeId);
  const state = status?.state ?? "";
  if (state !== cursor.state && state !== "") {
    events.push({ type: "status", state, at: status?.lastEventAt ?? null });
  }
  const since = formatCursor({ post: postCursor, state });
  const answer = (
    status: WaitStatus,
    extra: Partial<WaitAnswer> = {},
  ): WaitAnswer => ({ ...base, status, since, events, ...extra });

  if (found !== undefined) return answer("done", { result: found });
  if (node === undefined) {
    trackers.delete(run.taskId);
    return answer("failed", { reason: "nodeDeleted" });
  }

  const delivery = latestDelivery(database, run.coordinatorNodeId, run.nodeId);
  if (delivery !== undefined) {
    if (delivery.state === "queued" || delivery.state === "delivering") {
      // 还没投进去：这一轮还没开始，基准等投完再取。
      trackers.set(run.taskId, {
        armed: false,
        baselineEventAt: null,
        observedBusy: false,
      });
      return waiting(answer, status);
    }
    if (delivery.state === "cancelled" || delivery.state === "expired") {
      return answer("failed", {
        reason:
          delivery.lastReason ??
          `delivery${delivery.state[0]!.toUpperCase()}${delivery.state.slice(1)}`,
      });
    }
  }

  const tracker = trackers.get(run.taskId);
  if (tracker === undefined || !tracker.armed) {
    trackers.set(run.taskId, {
      armed: true,
      baselineEventAt: status?.lastEventAt ?? null,
      observedBusy:
        status?.state !== undefined && BUSY_STATES.includes(status.state),
    });
    return waiting(answer, status);
  }
  const verdict = evaluate(
    {
      condition: "current",
      observedBusy: tracker.observedBusy,
      baselineEventAt: tracker.baselineEventAt,
    },
    { exists: true, ...(status === undefined ? {} : { status }) },
  );
  switch (verdict.kind) {
    case "busy":
      tracker.observedBusy = true;
      return waiting(answer, status);
    case "satisfied":
      return answer("done");
    case "failed":
      return answer("failed", {
        reason:
          verdict.reason === "upstreamInterrupted"
            ? "turnInterrupted"
            : "turnFailed",
      });
    default:
      return waiting(answer, status);
  }
}

/** 还没结束：停在审批上、在等人回话，或者就是在做。 */
function waiting(
  answer: (status: WaitStatus, extra?: Partial<WaitAnswer>) => WaitAnswer,
  status: AgentStatus | undefined,
): WaitAnswer {
  if (status?.state === "blocked") {
    return answer("blocked", {
      reason: "approval",
      ...(status.pendingId === undefined
        ? {}
        : { approvalId: status.pendingId }),
    });
  }
  if (status?.state === "waiting") {
    return answer("needsInput", { reason: "question" });
  }
  return answer("running");
}

/**
 * 结束落库：`workflow_task_runs` 记一次结束（只记第一次），成员回报的那条
 * `post` 标成已收——runner 已经替协调者把它取走了，再让收件箱唤醒去提示一遍
 * 就是让协调者读第二遍。
 */
export function settle(
  database: DatabaseSync,
  answer: WaitAnswer,
  nowMs: number,
): void {
  if (answer.status !== "done" && answer.status !== "failed") return;
  trackers.delete(answer.taskId);
  finishTask(
    database,
    answer.taskId,
    answer.status,
    answer.status === "done"
      ? { text: answer.result?.text ?? null }
      : { reason: answer.reason ?? null },
    nowMs,
  );
  if (answer.result !== undefined) {
    const seq = answer.events
      .filter(
        (event): event is Extract<WaitEvent, { type: "post" }> =>
          event.type === "post" && event.key === answer.result?.key,
      )
      .map((event) => event.seq);
    for (const sequence of seq) {
      database
        .prepare(
          "UPDATE agent_mailbox SET acknowledged_at = ? WHERE sequence = ? AND acknowledged_at IS NULL",
        )
        .run(Math.floor(nowMs / 1000), sequence);
    }
  }
}

function readTimeout(args: Args): number {
  const raw = args.text("timeout");
  if (raw === undefined) {
    const counted = args.count(["timeout"]);
    if (counted === undefined) return DEFAULT_WAIT_SECONDS;
    return checkTimeout(counted);
  }
  const match = /^(\d{1,4})s?$/.exec(raw);
  if (match === null) {
    throw new Refused(
      400,
      "bad_request",
      `--timeout 是 0–${MAX_WAIT_SECONDS} 秒（如 30 或 30s）。`,
    );
  }
  return checkTimeout(Number(match[1]));
}

function checkTimeout(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) {
    throw new Refused(
      400,
      "bad_request",
      `--timeout 是 0–${MAX_WAIT_SECONDS} 秒（如 30 或 30s）。`,
    );
  }
  return seconds;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 动词本体。 */
export async function wait(
  context: CollabContext,
  caller: Caller,
  args: Args,
): Promise<Outcome> {
  const taskId = args.text("task") ?? args.text("task-id");
  if (taskId === undefined || !validTaskId(taskId)) {
    throw new Refused(
      400,
      "bad_request",
      "wait 需要 --task <任务 id>（1–100 个字母、数字或 . _ : -）。",
    );
  }
  const cursor = parseCursor(args.text("since"));
  if (cursor === undefined) {
    throw new Refused(
      400,
      "bad_request",
      "--since 是上一次 wait 答回来的 since 原样。",
    );
  }
  const timeout = readTimeout(args);
  const run = taskRun(context.database, taskId);
  if (run === undefined) {
    throw new Refused(404, "task_not_found", `没有任务 \`${taskId}\`。`);
  }
  // 只有起这个任务的那个协调者能等它：任务 id 不是授权。
  if (run.coordinatorNodeId !== caller.node.id) {
    throw new Refused(403, "forbidden", `任务 \`${taskId}\` 不是你起的。`);
  }
  const wanted = args.text("node");
  if (wanted !== undefined && wanted !== run.nodeId) {
    throw new Refused(
      409,
      "task_node_mismatch",
      `任务 \`${taskId}\` 在节点 ${run.nodeId} 上，不是 ${wanted}。`,
      { nodeId: run.nodeId },
    );
  }

  const deadline = Date.now() + timeout * 1000;
  let answer = observe(context.database, run, cursor);
  for (;;) {
    const final = answer.status === "done" || answer.status === "failed";
    const left = deadline - Date.now();
    if (final || answer.events.length > 0 || left <= 0) break;
    await sleep(Math.min(WAIT_POLL_MS, left));
    const current = taskRun(context.database, taskId) ?? run;
    answer = observe(context.database, current, cursor);
  }
  settle(context.database, answer, nowDate(context).getTime());
  return result(sentence(answer), answer);
}

function sentence(answer: WaitAnswer): string {
  switch (answer.status) {
    case "done":
      return answer.result === undefined
        ? "成员这一轮结束了，没有 post 结果；用 context summary 看它做了什么。"
        : "成员 post 了结果。";
    case "failed":
      // 契约 §52：成员的 CLI 自动重试过一次仍没起来，排给它的任务已经结算。
      if (answer.reason === LAUNCH_FAILED_REASON) {
        return "成员没能启动（已自动重试一次），任务没有投进去。";
      }
      return `任务没有做完（${answer.reason ?? "failed"}）。`;
    case "blocked":
      return "成员停在一个权限请求上，等人在画布或它的终端里回答；不要替人回答。";
    case "needsInput":
      return "成员在等人回一个问题。";
    default:
      return "成员还在做。";
  }
}
