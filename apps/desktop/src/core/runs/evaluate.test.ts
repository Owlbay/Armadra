import { expect, it } from "vitest";
import {
  aggregateRun,
  considerReport,
  runnable,
  type CompletionEvidence,
  type TrustedReport,
} from "./evaluate";

const evidence: CompletionEvidence = {
  taskId: "task",
  runId: "run",
  deliveryId: "delivery",
  nodeId: "node",
  sessionId: "pty",
  generation: 3,
  baseline: 10,
  acknowledged: true,
  promptHash: "expected",
  inputRevision: 5,
  providerSessionId: "provider",
  turnStarted: true,
  state: "running",
};
const done: TrustedReport = {
  seq: 12,
  nodeId: "node",
  sessionId: "pty",
  generation: 3,
  stateSource: "hook",
  verified: true,
  providerSessionId: "provider",
  kind: "state",
  state: "done",
};

it("never releases dependencies from old done, stale bindings, unverified or observed evidence", () => {
  for (const report of [
    { ...done, seq: 10 },
    { ...done, generation: 2 },
    { ...done, sessionId: "old" },
    { ...done, stateSource: "observed" },
    { ...done, verified: false },
    { ...done, providerSessionId: "other" },
  ])
    expect(considerReport(evidence, report, 5)).toEqual({ kind: "ignore" });
  expect(considerReport({ ...evidence, acknowledged: false }, done, 5)).toEqual(
    { kind: "ignore" },
  );
  expect(considerReport({ ...evidence, turnStarted: false }, done, 5)).toEqual({
    kind: "ignore",
  });
  expect(considerReport(evidence, done, 5)).toEqual({ kind: "complete" });
});

it("requires this submitted prompt and blocks when other input has mixed into the round", () => {
  const start = {
    ...done,
    kind: "state" as const,
    state: "working",
    newTurn: true,
    promptHash: "expected",
  };
  expect(considerReport({ ...evidence, turnStarted: false }, start, 5)).toEqual(
    { kind: "start", providerSessionId: "provider" },
  );
  expect(
    considerReport(evidence, { ...start, promptHash: "foreign" }, 5),
  ).toEqual({ kind: "block", reason: "external_interference" });
  expect(considerReport(evidence, done, 6)).toEqual({
    kind: "block",
    reason: "external_interference",
  });
  expect(considerReport(evidence, start, undefined)).toEqual({
    kind: "block",
    reason: "completion_unknown",
  });
});

it("records failure and human waits distinctly, never treating done as code quality acceptance", () => {
  expect(considerReport(evidence, { ...done, errored: true }, 5)).toEqual({
    kind: "fail",
    reason: "agent_error",
  });
  expect(considerReport(evidence, { ...done, interrupted: true }, 5)).toEqual({
    kind: "fail",
    reason: "agent_interrupted",
  });
  expect(considerReport(evidence, { ...done, state: "blocked" }, 5)).toEqual({
    kind: "block",
    reason: "awaiting_approval",
  });
  expect(considerReport(evidence, { ...done, state: "waiting" }, 5)).toEqual({
    kind: "block",
    reason: "awaiting_input",
  });
});

it("only starts tasks after all successful dependencies and aggregates independent branches honestly", () => {
  expect(runnable(["completed", "completed"])).toBe(true);
  for (const state of [
    "pending",
    "starting",
    "delivering",
    "running",
    "blocked",
    "failed",
    "cancelled",
    "skipped",
  ])
    expect(runnable(["completed", state])).toBe(false);
  expect(aggregateRun(["completed", "completed"])).toBe("completed");
  expect(aggregateRun(["failed", "skipped"])).toBe("failed");
  expect(aggregateRun(["blocked", "running"])).toBe("running");
  expect(aggregateRun(["blocked", "pending"], false)).toBe("blocked");
  expect(aggregateRun(["cancelled", "completed"])).toBe("cancelled");
});
