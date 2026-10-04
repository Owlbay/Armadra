import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import {
  finishTask,
  rebindTask,
  recordTaskStart,
  reopenTask,
  taskPrompt,
  taskRowJson,
  taskRun,
  taskRunJson,
  taskRunsFor,
} from "./task-runs";

/** `workflow_task_runs` 的存取：`task_id` 幂等，结束只结束一次。 */

let fixture: AgentFixture;

beforeEach(() => {
  fixture = agentFixture();
});

afterEach(() => {
  fixture.close();
});

describe("task runs", () => {
  it("is idempotent on taskId and finishes once", () => {
    const first = recordTaskStart(fixture.database, {
      taskId: "t1",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n1",
      now: 1_000,
    });
    expect(first.inserted).toBe(true);
    const retry = recordTaskStart(fixture.database, {
      taskId: "t1",
      coordinatorNodeId: "lead",
      runnerId: "codex",
      nodeId: "n2",
      now: 2_000,
    });
    expect(retry).toMatchObject({ inserted: false, run: { nodeId: "n1" } });

    rebindTask(fixture.database, "t1", "n2", 3_000);
    expect(taskRun(fixture.database, "t1")).toMatchObject({
      nodeId: "n2",
      status: "running",
      startedAt: 3_000,
    });

    expect(
      finishTask(fixture.database, "t1", "done", { text: "ok" }, 4_000),
    ).toBe(true);
    expect(finishTask(fixture.database, "t1", "failed", null, 5_000)).toBe(
      false,
    );
    const run = taskRun(fixture.database, "t1");
    expect(run).toMatchObject({ status: "done", result: { text: "ok" } });
    expect(taskRunJson(run!)).toMatchObject({
      taskId: "t1",
      status: "done",
      endedAt: new Date(4_000).toISOString(),
    });
    expect(taskRunsFor(fixture.database, "lead")).toHaveLength(1);
    expect(taskRunsFor(fixture.database, "other")).toHaveLength(0);
  });

  it("keeps the task text through finish, rebind and reopen", () => {
    recordTaskStart(fixture.database, {
      taskId: "t2",
      coordinatorNodeId: "lead",
      runnerId: "claude",
      nodeId: "n1",
      now: 1_000,
      task: "审查 src/x",
    });
    expect(reopenTask(fixture.database, "t2", 1_500)).toBe(false);
    finishTask(
      fixture.database,
      "t2",
      "failed",
      { reason: "turnFailed" },
      2_000,
    );
    let run = taskRun(fixture.database, "t2")!;
    expect(run.result).toEqual({ reason: "turnFailed", task: "审查 src/x" });
    expect(taskRowJson(run)).toMatchObject({
      status: "failed",
      reason: "turnFailed",
      retryable: true,
    });
    expect(reopenTask(fixture.database, "t2", 3_000)).toBe(true);
    run = taskRun(fixture.database, "t2")!;
    expect(run).toMatchObject({
      status: "running",
      startedAt: 3_000,
      endedAt: null,
    });
    expect(taskPrompt(run)).toBe("审查 src/x");
    rebindTask(fixture.database, "t2", "n3", 4_000);
    expect(taskPrompt(taskRun(fixture.database, "t2")!)).toBe("审查 src/x");
    finishTask(fixture.database, "t2", "done", null, 5_000);
    expect(taskRun(fixture.database, "t2")!.result).toEqual({
      task: "审查 src/x",
    });
    expect(taskRowJson(taskRun(fixture.database, "t2")!)).toMatchObject({
      retryable: false,
      reason: null,
    });
  });
});
