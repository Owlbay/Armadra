export const TASK_STATES = [
  "pending",
  "starting",
  "delivering",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type RunState =
  | "queued"
  | "running"
  | "blocked"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";
export const TERMINAL_TASKS: readonly string[] = [
  "completed",
  "failed",
  "cancelled",
  "skipped",
];
export interface CompletionEvidence {
  readonly taskId: string;
  readonly runId: string;
  readonly deliveryId: string;
  readonly nodeId: string;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly baseline: number;
  readonly sourceBaseline?: number;
  readonly acknowledged: boolean;
  readonly promptHash: string | null;
  readonly inputRevision: number | null;
  readonly providerSessionId: string | null;
  readonly turnStarted: boolean;
  readonly state: string;
}
export interface TrustedReport {
  readonly seq: number;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly sourceRevision?: number;
  readonly stateSource: string;
  readonly verified: boolean;
  readonly providerSessionId?: string | undefined;
  readonly kind: "state" | "session";
  readonly state?: string | undefined;
  readonly newTurn?: boolean | undefined;
  readonly promptHash?: string | undefined;
  readonly errored?: boolean | undefined;
  readonly interrupted?: boolean | undefined;
}
export type ReportVerdict =
  | { kind: "ignore" }
  | { kind: "start"; providerSessionId: string }
  | { kind: "complete" }
  | { kind: "block" | "fail"; reason: string };

/** Delivery ACK is necessary; matching trusted round + unchanged input prove attribution. */
export function considerReport(
  task: CompletionEvidence,
  report: TrustedReport,
  currentInputRevision: number | undefined,
): ReportVerdict {
  if (
    !task.acknowledged ||
    TERMINAL_TASKS.includes(task.state) ||
    report.seq <= task.baseline ||
    (report.sourceRevision !== undefined &&
      task.sourceBaseline !== undefined &&
      report.sourceRevision <= task.sourceBaseline) ||
    report.nodeId !== task.nodeId ||
    report.sessionId !== task.sessionId ||
    report.generation !== task.generation ||
    !report.verified ||
    !["hook", "extension"].includes(report.stateSource)
  )
    return { kind: "ignore" };
  if (
    task.providerSessionId &&
    task.providerSessionId !== report.providerSessionId
  )
    return { kind: "ignore" };
  if (currentInputRevision === undefined || task.inputRevision === null)
    return { kind: "block", reason: "completion_unknown" };
  if (currentInputRevision !== task.inputRevision)
    return { kind: "block", reason: "external_interference" };
  if (report.newTurn) {
    if (!report.promptHash || !report.providerSessionId)
      return { kind: "block", reason: "completion_unknown" };
    if (report.promptHash !== task.promptHash)
      return { kind: "block", reason: "external_interference" };
    return { kind: "start", providerSessionId: report.providerSessionId };
  }
  if (!task.turnStarted) return { kind: "ignore" };
  if (report.errored) return { kind: "fail", reason: "agent_error" };
  if (report.interrupted) return { kind: "fail", reason: "agent_interrupted" };
  if (report.state === "blocked")
    return { kind: "block", reason: "awaiting_approval" };
  if (report.state === "waiting")
    return { kind: "block", reason: "awaiting_input" };
  if (report.kind === "state" && report.state === "done")
    return { kind: "complete" };
  return { kind: "ignore" };
}
export function runnable(dependencies: readonly string[]): boolean {
  return dependencies.every((state) => state === "completed");
}
export function aggregateRun(
  states: readonly string[],
  hasRunnable = true,
): RunState {
  if (states.every((state) => state === "completed")) return "completed";
  if (states.every((state) => TERMINAL_TASKS.includes(state))) {
    if (states.includes("failed")) return "failed";
    if (states.includes("cancelled")) return "cancelled";
    return "failed";
  }
  if (
    states.some((state) =>
      ["starting", "delivering", "running"].includes(state),
    )
  )
    return "running";
  if (states.includes("blocked") && !hasRunnable) return "blocked";
  return "queued";
}
