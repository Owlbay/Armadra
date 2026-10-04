import type { AgentState, CanvasEdge, CanvasNode } from "@armadra/shared";

import type { StatusTone } from "@/ui/status-pill";
import type { DispatchTask } from "./api";

/**
 * 分派抽屉的数据（设计系统 §5.4）：一个协调者、它分派出去的成员、汇总便签。
 *
 * 纯函数，输入是三份已有的数据——画布文档（节点与边）、`workflow_task_runs`
 * 的任务行（契约 §15.7）、Agent 状态（与 `AgentActivityNode` 同一份 hook
 * 流）——不另造状态。
 *
 *   * 成员 = 这个协调者的任务行（同一个节点只取最新一行）∪ 它经 `supervises`
 *     线驱动、但没有任务行的终端节点（`canvas_team` 建的）。节点已经不在画布
 *     上的任务不列。
 *   * 汇总 = 来源是这个协调者（输出到画板）或与它连着线的便签。
 */

export interface DispatchStatus {
  readonly tone: StatusTone;
  /** i18n 键。 */
  readonly label: string;
}

export interface DispatchMember {
  readonly nodeId: string;
  readonly title: string;
  readonly agentId: string;
  readonly status: DispatchStatus;
  /** 耗时（毫秒）；没有任务行时为 `null`。 */
  readonly elapsedMs: number | null;
  readonly taskId: string | null;
  readonly retryable: boolean;
}

export interface DispatchSummary {
  readonly nodeId: string;
  readonly title: string;
}

export interface DispatchModel {
  readonly lead: {
    readonly nodeId: string;
    readonly title: string;
    readonly agentId: string;
    readonly status: DispatchStatus | null;
  } | null;
  readonly members: readonly DispatchMember[];
  readonly summaries: readonly DispatchSummary[];
}

export interface DispatchInput {
  readonly coordinatorId: string | null;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly tasks: readonly DispatchTask[];
  readonly states: Readonly<Record<string, AgentState | undefined>>;
  readonly now: number;
}

const STATUS = {
  working: { tone: "working", label: "coordinator.status.working" },
  attention: { tone: "attention", label: "coordinator.status.attention" },
  done: { tone: "done", label: "coordinator.status.done" },
  failed: { tone: "failed", label: "coordinator.status.failed" },
  stopped: { tone: "paused", label: "coordinator.status.stopped" },
  idle: { tone: "idle", label: "coordinator.status.idle" },
} as const satisfies Record<string, DispatchStatus>;

function agentOf(node: CanvasNode): string {
  return node.data.kind === "terminal" ? (node.data.agent?.id ?? "") : "";
}

/** 只看 Agent 状态：没有任务行的成员与协调者自己。 */
function liveStatus(state: AgentState | undefined): DispatchStatus {
  if (state === "working") return STATUS.working;
  if (state === "blocked" || state === "waiting") return STATUS.attention;
  return STATUS.idle;
}

/** 任务行为主，`running` 时再细分「需要你」。 */
function taskStatus(
  task: DispatchTask,
  state: AgentState | undefined,
): DispatchStatus {
  switch (task.status) {
    case "done":
      return STATUS.done;
    case "failed":
      return STATUS.failed;
    case "stopped":
      return STATUS.stopped;
    default:
      return state === "blocked" || state === "waiting"
        ? STATUS.attention
        : STATUS.working;
  }
}

function elapsed(task: DispatchTask, now: number): number | null {
  const start = Date.parse(task.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = task.endedAt === null ? now : Date.parse(task.endedAt);
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function stickyTitle(node: CanvasNode): string {
  if (node.title.trim() !== "") return node.title;
  const content = node.data.kind === "sticky" ? node.data.content : "";
  return (
    content
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

export function buildDispatch(input: DispatchInput): DispatchModel {
  const { coordinatorId, nodes, edges, tasks, states, now } = input;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const leadNode = coordinatorId ? byId.get(coordinatorId) : undefined;
  if (!coordinatorId || !leadNode) {
    return { lead: null, members: [], summaries: [] };
  }

  const members: DispatchMember[] = [];
  const seen = new Set<string>();
  // 任务行按开始时刻从早到晚：抽屉里是分派的先后。
  const own = tasks
    .filter((task) => task.coordinatorNodeId === coordinatorId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const latest: DispatchTask[] = [];
  for (const task of own) {
    if (seen.has(task.nodeId)) continue;
    seen.add(task.nodeId);
    latest.push(task);
  }
  latest.reverse();
  for (const task of latest) {
    const node = byId.get(task.nodeId);
    if (!node) continue;
    members.push({
      nodeId: node.id,
      title: node.title,
      agentId: agentOf(node) || task.runnerId,
      status: taskStatus(task, states[node.id]),
      elapsedMs: elapsed(task, now),
      taskId: task.taskId,
      retryable: task.retryable && task.status !== "running",
    });
  }
  for (const edge of edges) {
    if (edge.source !== coordinatorId || edge.role !== "supervises") continue;
    if (seen.has(edge.target)) continue;
    const node = byId.get(edge.target);
    if (!node || node.type !== "terminal") continue;
    seen.add(node.id);
    members.push({
      nodeId: node.id,
      title: node.title,
      agentId: agentOf(node),
      status: liveStatus(states[node.id]),
      elapsedMs: null,
      taskId: null,
      retryable: false,
    });
  }

  const linked = new Set<string>();
  for (const edge of edges) {
    if (edge.source === coordinatorId) linked.add(edge.target);
    if (edge.target === coordinatorId) linked.add(edge.source);
  }
  const summaries: DispatchSummary[] = nodes
    .filter(
      (node) =>
        node.data.kind === "sticky" &&
        (node.data.source?.nodeId === coordinatorId || linked.has(node.id)),
    )
    .map((node) => ({ nodeId: node.id, title: stickyTitle(node) }));

  return {
    lead: {
      nodeId: leadNode.id,
      title: leadNode.title,
      agentId: agentOf(leadNode),
      status: states[leadNode.id] ? liveStatus(states[leadNode.id]) : null,
    },
    members,
    summaries,
  };
}

/** 节点头部「N 成员」的 N：与抽屉同一条规则，不读任务行时只数主从线。 */
export function memberCount(
  coordinatorId: string,
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  tasks: readonly DispatchTask[] = [],
): number {
  return buildDispatch({
    coordinatorId,
    nodes,
    edges,
    tasks,
    states: {},
    now: 0,
  }).members.length;
}
