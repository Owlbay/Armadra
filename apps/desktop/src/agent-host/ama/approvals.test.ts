import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, HostApi } from "@armadra/agent/host";
import type { Endpoint } from "../../hook-client/endpoint";
import { createBroker, installBroker, waitSeconds } from "./approvals";
import type { reportTo } from "./client";

/**
 * ama's approval broker: the hook client's request/answer files, so a person
 * can answer on the canvas (contract §5.5, §15.5). It never decides itself.
 */

let directory: string;
let endpoint: Endpoint;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "armadra-ama-broker-"));
  endpoint = { path: join(directory, "hook-endpoint.env") } as Endpoint;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const session = {
  id: () => "sess-1",
  file: () => undefined,
  cwd: () => "/work",
  model: () => undefined,
} as unknown as HostApi["session"];

const request: ApprovalRequest = {
  requestId: "r1",
  toolName: "bash",
  input: { command: "rm -rf build", secret: "file body" },
  reason: "mode",
};

function reporter(status = 204) {
  const seen: {
    payload: Record<string, unknown>;
    pendingId: string | undefined;
  }[] = [];
  const report = vi.fn(async (payload, options = {}) => {
    options.prepare?.(endpoint);
    seen.push({ payload, pendingId: options.pendingId });
    return { status, candidate: endpoint };
  }) as unknown as typeof reportTo;
  return { report, seen };
}

const pending = () => join(directory, "pending");

describe("the ama approval broker", () => {
  it("reports the request with a pending id and returns the canvas' answer", async () => {
    const { report, seen } = reporter();
    const broker = createBroker({
      nodeId: "node-1",
      seconds: 5,
      session,
      report,
    });
    const asked = broker.ask(request, new AbortController().signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const id = seen[0]!.pendingId!;
    expect(id.startsWith("node-1-")).toBe(true);
    expect(seen[0]!.payload).toMatchObject({
      hookEventName: "tool_approval_requested",
      provider: "ama",
      toolName: "bash",
    });
    // The tool's input never reaches the request file or the report.
    expect(JSON.stringify(seen[0]!.payload)).not.toContain("rm -rf");
    expect(readdirSync(pending())).toEqual([`${id}.json`]);

    // What the core's `answerApproval` does when a person answers.
    writeFileSync(join(pending(), `${id}.answer`), "allow");
    expect(await asked).toBe("allow");
    expect(readdirSync(pending())).toEqual([]);
  });

  it("steps aside when nobody answers in time, or the report was refused", async () => {
    const quiet = createBroker({
      nodeId: "node-1",
      seconds: 1,
      session,
      report: reporter().report,
    });
    const started = Date.now();
    expect(await quiet.ask(request, new AbortController().signal)).toBe(
      undefined,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(readdirSync(pending())).toEqual([]);

    const refused = createBroker({
      nodeId: "node-1",
      seconds: 5,
      session,
      report: reporter(403).report,
    });
    expect(await refused.ask(request, new AbortController().signal)).toBe(
      undefined,
    );
    expect(readdirSync(pending())).toEqual([]);
  });

  it("stops waiting when ama aborts the request", async () => {
    const broker = createBroker({
      nodeId: "node-1",
      seconds: 30,
      session,
      report: reporter().report,
    });
    const controller = new AbortController();
    const asked = broker.ask(request, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await asked).toBeUndefined();
  });

  it("is installed only where the core asked for canvas answers, with a terminal", () => {
    expect(waitSeconds({ ARMADRA_PERM_WAIT_SECS: "45" })).toBe(45);
    expect(waitSeconds({ ARMADRA_PERM_WAIT_SECS: "0" })).toBeUndefined();
    expect(waitSeconds({})).toBeUndefined();
    const api = (env: NodeJS.ProcessEnv, mode = "interactive") => ({
      env,
      mode,
      session,
      approvals: { setBroker: vi.fn() },
    });
    const on = api({ ARMADRA_NODE_ID: "n", ARMADRA_PERM_WAIT_SECS: "45" });
    expect(installBroker(on as never)).toBe(true);
    expect(on.approvals.setBroker).toHaveBeenCalledOnce();
    for (const off of [
      api({ ARMADRA_NODE_ID: "n" }),
      api({ ARMADRA_PERM_WAIT_SECS: "45" }),
      api({ ARMADRA_NODE_ID: "n", ARMADRA_PERM_WAIT_SECS: "45" }, "rpc"),
    ]) {
      expect(installBroker(off as never)).toBe(false);
      expect(off.approvals.setBroker).not.toHaveBeenCalled();
    }
  });
});
