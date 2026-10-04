import { describe, expect, it } from "vitest";

import type { WorkflowRunJson } from "./api";
import { doneNodes, nodeSteps } from "./node-steps";

function step(
  stepId: string,
  status: WorkflowRunJson["steps"][number]["status"],
  nodeId: string | null,
): WorkflowRunJson["steps"][number] {
  return {
    stepId,
    kind: "prompt",
    role: "dev",
    status,
    nodeId,
    startedAt: null,
    endedAt: null,
    reason: null,
    outputs: [],
    decision: null,
    note: null,
  } as WorkflowRunJson["steps"][number];
}

function run(
  status: WorkflowRunJson["status"],
  steps: WorkflowRunJson["steps"],
): WorkflowRunJson {
  return { id: status, status, steps } as WorkflowRunJson;
}

describe("nodeSteps", () => {
  it("numbers only the running steps of live runs, from one", () => {
    expect(
      nodeSteps([
        run("running", [
          step("a", "done", "n-a"),
          step("b", "running", "n-b"),
          step("c", "pending", null),
        ]),
        run("waiting", [step("x", "running", "n-x")]),
        run("succeeded", [step("y", "running", "n-y")]),
      ]),
    ).toEqual({ "n-b": 2, "n-x": 1 });
  });
});

describe("doneNodes", () => {
  it("marks finished role nodes of live runs, unless another step runs there", () => {
    expect(
      doneNodes([
        run("running", [
          step("a", "done", "n-a"),
          step("b", "running", "n-b"),
          step("c", "done", "n-b"),
          step("d", "failed", "n-d"),
        ]),
        run("succeeded", [step("y", "done", "n-y")]),
      ]),
    ).toEqual({ "n-a": true });
  });
});
