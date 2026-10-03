/**
 * `HostApi.runners`: ama's `task(agent=<id>)` as a node on the canvas
 * (completion architecture §5.3, contract §15.5).
 *
 * One runner per agent id the core launches — the built-ins and every
 * `custom:*` entry (`canvas help` lists them). With a host, ama runs no
 * external CLI of its own (its D17), so these are the only way a coordinator
 * hands work to claude or codex — and the user sees every one of them on the
 * board.
 *
 *   * `start` = `open-agent --agent <id> --task <prompt> --task-id <id>`: the
 *     core builds the node, links it, launches it and queues the task; the
 *     same `--task-id` answers the same node (ama retrying after a crash
 *     starts nothing twice).
 *   * `wait()` loops the `wait` verb until `done` or `failed`; `blocked` and
 *     `needsInput` only update ama's status line — **the runner never answers
 *     an approval**, a person does, on the canvas or in the member's terminal.
 *   * `send` = `send --to <node>` (queued like any other delivery); `stop` and
 *     an aborted `signal` = `interrupt` — the node stays on the board.
 *
 * The result text is the member's `task:<id>:result` post (the instruction is
 * appended to every prompt), else its `context summary`.
 *
 * Not here: `ama` itself as a runner. ama files a runner whose id is `ama`
 * under its own sub-session type and never calls it (its `runner === "ama"`
 * short-circuit), so `task(agent="ama")` stays ama's own sub-agent.
 */

import { randomUUID } from "node:crypto";
import type {
  HostApi,
  HostRunner,
  RunnerHandle,
  SubagentEvent,
  SubagentRunRequest,
} from "@armadra/agent/host";
import type { JsonValue } from "../../hook-client/json.js";
import { type ControlAnswer, callContext, callControl } from "./client.js";

/** The built-ins a runner is registered for (not `ama`: see the header). */
export const BUILTIN_RUNNER_IDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
] as const;

/** Seconds one `wait` call holds; the HTTP budget adds a margin. */
export const WAIT_TIMEOUT_SECONDS = 30;
const WAIT_BUDGET_MS = (WAIT_TIMEOUT_SECONDS + 15) * 1000;
/** Consecutive unanswered `wait` calls before the task is given up. */
export const MAX_UNREACHABLE = 10;
const RETRY_MS = 2000;
/** The status-line key; one per task. */
const STATUS_KEY = "armadra-task";

type PermissionMode = SubagentRunRequest["mode"];

/** ama's permission mode → the canvas CLI's (§5.3's table). */
export function canvasMode(mode: PermissionMode): string {
  switch (mode) {
    case "plan":
      return "plan";
    case "auto-edit":
      return "auto-edit";
    case "auto":
    case "full-auto":
      return "full-auto";
    default:
      return "default";
  }
}

/** The idempotency key: ama's task id is per session, the board's is global. */
export function taskKey(sessionId: string, taskId: string | undefined): string {
  const clean = (value: string): string =>
    value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  const session = clean(sessionId) || "session";
  const task = clean(taskId ?? "") || randomUUID().slice(0, 13);
  return `${session}:${task}`.slice(0, 100);
}

/** The post key a round's result comes back under. */
export function resultKeyFor(key: string, round: number): string {
  return round <= 1 ? `task:${key}:result` : `task:${key}:result:${round}`;
}

/** The line appended to every prompt: how the member reports back. */
export function resultInstruction(
  coordinatorNodeId: string,
  key: string,
): string {
  return (
    `When done, report the result with: armadra-hook canvas post --to ${coordinatorNodeId} ` +
    `--key ${key} --body '<result; file paths>' (or the canvas_post tool). ` +
    `完成后用这个键回报结果。`
  );
}

export interface RunnerDeps {
  readonly coordinatorNodeId: string;
  readonly sessionId: () => string;
  readonly control: typeof callControl;
  readonly context: typeof callContext;
  readonly setStatus: (key: string, text?: string) => void;
  readonly log: HostApi["log"];
  /** Retry pause after an unanswered call; tests shorten it. */
  readonly retryMs?: number;
}

interface WaitAnswer {
  status: "running" | "done" | "failed" | "blocked" | "needsInput";
  since: string;
  events: {
    type: string;
    state?: string;
    key?: string;
    body?: string;
  }[];
  approvalId?: string;
  reason?: string;
  result?: { text: string };
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
} as unknown as Awaited<ReturnType<RunnerHandle["wait"]>>["usage"];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function refusalText(answer: ControlAnswer): string {
  if (answer.kind === "refused") return `${answer.message} (${answer.code})`;
  if (answer.kind === "unreachable") return answer.error;
  return "";
}

/** One canvas member: the handle ama holds for the task. */
class CanvasTask implements RunnerHandle {
  private since = "";
  private round = 1;
  private turns = 0;
  private lastState = "";

  constructor(
    readonly id: string,
    private readonly runnerId: string,
    private readonly key: string,
    private readonly request: SubagentRunRequest,
    private readonly deps: RunnerDeps,
  ) {}

  async send(text: string): Promise<void> {
    this.round += 1;
    const body = `${text}\n\n${resultInstruction(
      this.deps.coordinatorNodeId,
      resultKeyFor(this.key, this.round),
    )}`;
    const answer = await this.deps.control("send", {
      to: this.id,
      body,
      key: `task:${this.key}:send:${this.round}`.slice(0, 128),
    });
    if (answer.kind !== "ok") throw new Error(refusalText(answer));
  }

  async stop(): Promise<void> {
    // Only the turn stops; the node stays where a person can see it.
    await this.deps.control("interrupt", { to: this.id });
  }

  async wait(): Promise<Awaited<ReturnType<RunnerHandle["wait"]>>> {
    const signal = this.request.signal;
    let unreachable = 0;
    try {
      for (;;) {
        if (signal.aborted) {
          await this.stop().catch(() => undefined);
          return this.finish("aborted", "The task was stopped.", true);
        }
        const answer = await this.deps.control(
          "wait",
          {
            task: this.key,
            node: this.id,
            ...(this.since === "" ? {} : { since: this.since }),
            timeout: String(WAIT_TIMEOUT_SECONDS),
          },
          WAIT_BUDGET_MS,
        );
        if (answer.kind === "unreachable") {
          unreachable += 1;
          if (unreachable >= MAX_UNREACHABLE) {
            return this.finish("failed", answer.error, true);
          }
          await sleep(this.deps.retryMs ?? RETRY_MS, signal);
          continue;
        }
        unreachable = 0;
        if (answer.kind === "refused") {
          return this.finish("failed", refusalText(answer), true);
        }
        const body = answer.body.result as WaitAnswer | undefined;
        if (body === undefined || typeof body.status !== "string") {
          return this.finish("failed", "wait answered no status", true);
        }
        this.since = body.since;
        this.report(body);
        switch (body.status) {
          case "done": {
            const text =
              body.result?.text ??
              (await this.deps.context("summary", { node: this.id })) ??
              "";
            return this.finish("completed", text, false);
          }
          case "failed":
            return this.finish(
              "failed",
              `The canvas member did not finish (${body.reason ?? "failed"}).`,
              true,
            );
          default:
            continue;
        }
      }
    } finally {
      this.deps.setStatus(this.statusKey());
    }
  }

  private statusKey(): string {
    return `${STATUS_KEY}:${this.key}`;
  }

  /** Status line and progress events; `blocked` is shown, never answered. */
  private report(answer: WaitAnswer): void {
    if (answer.status === "blocked") {
      this.deps.setStatus(
        this.statusKey(),
        `${this.request.taskId ?? "task"}: 等人审批 / awaiting approval`,
      );
    } else if (answer.status === "needsInput") {
      this.deps.setStatus(
        this.statusKey(),
        `${this.request.taskId ?? "task"}: 等人回复 / awaiting input`,
      );
    } else {
      this.deps.setStatus(this.statusKey());
    }
    for (const event of answer.events) {
      const mapped = this.eventOf(event);
      if (mapped === undefined) continue;
      try {
        this.request.onEvent(mapped);
      } catch {
        // A listener's failure is not the task's.
      }
    }
  }

  private eventOf(
    event: WaitAnswer["events"][number],
  ): SubagentEvent | undefined {
    if (event.type === "status" && typeof event.state === "string") {
      const previous = this.lastState;
      this.lastState = event.state;
      if (event.state === "working" && previous !== "working") {
        this.turns += 1;
        return { type: "turn", turn: this.turns };
      }
      return undefined;
    }
    if (event.type === "post" && typeof event.body === "string") {
      return { type: "text", delta: `${event.body}\n` };
    }
    return undefined;
  }

  private finish(
    status: "completed" | "failed" | "aborted",
    text: string,
    isError: boolean,
  ): Awaited<ReturnType<RunnerHandle["wait"]>> {
    return {
      text,
      usage: ZERO_USAGE,
      stopReason: status === "completed" ? "end_turn" : status,
      isError,
      status,
      ...(this.request.taskId === undefined
        ? {}
        : { taskId: this.request.taskId }),
      sessionRef: { runner: this.runnerId, sessionId: this.id },
    } as Awaited<ReturnType<RunnerHandle["wait"]>>;
  }
}

function describeRunner(agentId: string): string {
  return agentId.startsWith("custom:")
    ? `Canvas node running the custom agent ${agentId.slice(7)}; the user sees and can steer it on the board.`
    : `Canvas node running ${agentId} (its own login, model and permissions); the user sees and can steer it on the board.`;
}

/** The runner for one agent id. */
export function canvasRunner(agentId: string, deps: RunnerDeps): HostRunner {
  return {
    id: agentId,
    description: describeRunner(agentId),
    async start(request: SubagentRunRequest): Promise<RunnerHandle> {
      const key = taskKey(deps.sessionId(), request.taskId);
      const prompt = `${request.prompt}\n\n${resultInstruction(
        deps.coordinatorNodeId,
        resultKeyFor(key, 1),
      )}`;
      const shortId = request.taskId ?? key.slice(-8);
      const args: Record<string, JsonValue> = {
        agent: agentId,
        task: prompt,
        "task-id": key,
        name: `${agentId.replace(/^custom:/, "")} · ${shortId}`.slice(0, 80),
        ...(request.model === undefined ? {} : { model: request.model }),
      };
      const mode = canvasMode(request.mode);
      let answer = await deps.control("open-agent", {
        ...args,
        ...(mode === "default" ? {} : { "permission-mode": mode }),
      });
      // A CLI without that mode: fall back to its default, which is never
      // wider than full-auto or auto-edit. `plan` is the one mode whose
      // fallback would be wider, so it is not retried.
      if (
        answer.kind === "refused" &&
        answer.code === "permission_mode_unsupported" &&
        mode !== "plan"
      ) {
        deps.log("info", `${agentId} has no ${mode} mode; using its default`);
        answer = await deps.control("open-agent", args);
      }
      if (answer.kind !== "ok") throw new Error(refusalText(answer));
      const result = answer.body.result as { id?: unknown } | undefined;
      if (typeof result?.id !== "string") {
        throw new Error("open-agent answered no node id");
      }
      if (request.resume !== undefined) {
        deps.log(
          "info",
          `canvas runners do not resume a session; ${agentId} starts fresh`,
        );
      }
      return new CanvasTask(result.id, agentId, key, request, deps);
    },
  };
}

/** The `custom:*` ids the core lists in `canvas help`. */
export async function customAgentIds(
  control: typeof callControl = callControl,
): Promise<string[]> {
  const answer = await control("help", {});
  if (answer.kind !== "ok") return [];
  const agents = (answer.body.result as { agents?: unknown } | undefined)
    ?.agents;
  return Array.isArray(agents)
    ? agents.filter(
        (id): id is string =>
          typeof id === "string" && /^custom:[A-Za-z0-9._-]{1,64}$/.test(id),
      )
    : [];
}

/**
 * Registers the built-in runners now and the custom ones once the core has
 * listed them. Answers the unregister function; a runtime without
 * `HostApi.runners` (older ama) gets nothing and keeps its own `task`.
 */
export function provideRunners(
  api: Pick<HostApi, "env" | "runners" | "session" | "ui" | "log">,
  overrides: Partial<RunnerDeps> = {},
): () => void {
  const runners = api.runners;
  const nodeId = api.env.ARMADRA_NODE_ID?.trim();
  if (runners === undefined || nodeId === undefined || nodeId === "") {
    return () => {};
  }
  const deps: RunnerDeps = {
    coordinatorNodeId: nodeId,
    sessionId: () => api.session.id(),
    control: callControl,
    context: callContext,
    setStatus: (key, text) => api.ui.setStatus(key, text),
    log: api.log,
    ...overrides,
  };
  const releases: (() => void)[] = [];
  let disposed = false;
  const provide = (id: string): void => {
    if (disposed) return;
    try {
      releases.push(runners.provide(canvasRunner(id, deps)));
    } catch (error) {
      api.log("warn", `could not provide the ${id} runner`, error);
    }
  };
  for (const id of BUILTIN_RUNNER_IDS) provide(id);
  void customAgentIds(deps.control)
    .then((ids) => {
      for (const id of ids) provide(id);
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    for (const release of releases.splice(0)) {
      try {
        release();
      } catch {
        // Already gone.
      }
    }
  };
}
