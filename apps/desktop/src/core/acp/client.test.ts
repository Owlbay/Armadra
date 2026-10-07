import { tmpdir } from "node:os";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import {
  AcpError,
  type AcpPendingPermission,
  type AcpPermissionSettlement,
  AcpProcess,
} from "./client";
import type { AcpSessionNotification } from "./types";

/**
 * 传输层对 `@armadra/agent/acp` 的假 ACP Agent（真子进程）：并发请求、挂起的
 * `request_permission`、退出对账与 `--minimal` 降级。不起任何真 CLI。
 */

const started: AcpProcess[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((process_) => process_.terminate()));
});

interface Recorder {
  readonly updates: AcpSessionNotification[];
  readonly held: AcpPendingPermission[];
  readonly settled: { id: string; settlement: AcpPermissionSettlement }[];
  readonly waitHeld: () => Promise<AcpPendingPermission>;
}

function fake(minimal = false): { process: AcpProcess; record: Recorder } {
  const updates: AcpSessionNotification[] = [];
  const held: AcpPendingPermission[] = [];
  const settled: Recorder["settled"] = [];
  const waiters: ((pending: AcpPendingPermission) => void)[] = [];
  const process_ = AcpProcess.spawn({
    program: process.execPath,
    args: [fakeAcpAgentPath(), ...(minimal ? ["--minimal"] : [])],
    cwd: tmpdir(),
    onUpdate: (notification) => updates.push(notification),
    onPermission: (pending) => {
      held.push(pending);
      waiters.shift()?.(pending);
    },
    onPermissionSettled: (pending, settlement) =>
      settled.push({ id: pending.id, settlement }),
  });
  started.push(process_);
  return {
    process: process_,
    record: {
      updates,
      held,
      settled,
      waitHeld: () =>
        new Promise((resolve) => {
          const next = held[held.length - 1];
          if (next !== undefined && !settled.some((s) => s.id === next.id)) {
            resolve(next);
          } else {
            waiters.push(resolve);
          }
        }),
    },
  };
}

const text = (value: string) => [{ type: "text" as const, text: value }];

function messages(updates: AcpSessionNotification[], sessionId: string) {
  return updates
    .filter((n) => n.sessionId === sessionId)
    .map((n) => n.update)
    .flatMap((u) =>
      u.sessionUpdate === "agent_message_chunk" && u.content.type === "text"
        ? [u.content.text]
        : [],
    );
}

describe("AcpProcess", () => {
  it("answers concurrent requests on several sessions, each to its own caller", async () => {
    const { process: agent, record } = fake();
    await agent.client.initialize();
    const sessions = await Promise.all(
      [0, 1, 2].map(() => agent.client.newSession(tmpdir())),
    );
    const ids = sessions.map((s) => s.sessionId);
    expect(new Set(ids).size).toBe(3);

    const results = await Promise.all(
      ids.map((id, index) => agent.prompt(id, text(`hello ${index}`))),
    );
    expect(results.map((r) => r.stopReason)).toEqual([
      "end_turn",
      "end_turn",
      "end_turn",
    ]);
    ids.forEach((id, index) => {
      expect(messages(record.updates, id)).toEqual([`echo: hello ${index}`]);
    });
  });

  it("holds request_permission until a person answers with one of the agent's options", async () => {
    const { process: agent, record } = fake();
    await agent.client.initialize();
    const { sessionId } = await agent.client.newSession(tmpdir());

    const turn = agent.prompt(sessionId, text("[permission] write it"));
    const pending = await record.waitHeld();
    expect(pending.sessionId).toBe(sessionId);
    expect(pending.options.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]);
    expect(agent.pendingPermissions(sessionId)).toHaveLength(1);

    // 不是 Agent 给的选项：不认，仍挂着。
    expect(agent.answerPermission(pending.id, "made-up")).toBe(false);
    expect(agent.pendingPermissions()).toHaveLength(1);

    expect(agent.answerPermission(pending.id, "allow")).toBe(true);
    expect(agent.answerPermission(pending.id, "allow")).toBe(false);
    expect((await turn).stopReason).toBe("end_turn");
    expect(messages(record.updates, sessionId)).toEqual(["wrote note.txt"]);
    expect(agent.pendingPermissions()).toEqual([]);
    expect(record.settled).toEqual([
      {
        id: pending.id,
        settlement: {
          by: "answer",
          outcome: { outcome: "selected", optionId: "allow" },
        },
      },
    ]);
  });

  it("answers cancelled for a pending permission when the turn is cancelled", async () => {
    const { process: agent, record } = fake();
    await agent.client.initialize();
    const { sessionId } = await agent.client.newSession(tmpdir());

    const turn = agent.prompt(sessionId, text("[permission]"));
    const pending = await record.waitHeld();
    await agent.cancel(sessionId);

    expect((await turn).stopReason).toBe("cancelled");
    expect(agent.pendingPermissions()).toEqual([]);
    expect(record.settled).toEqual([
      {
        id: pending.id,
        settlement: { by: "cancelled", outcome: { outcome: "cancelled" } },
      },
    ]);
    // 被取消之后再答：不认。
    expect(agent.answerPermission(pending.id, "allow")).toBe(false);
  });

  it("cancels a slow turn with session/cancel", async () => {
    const { process: agent } = fake();
    await agent.client.initialize();
    const { sessionId } = await agent.client.newSession(tmpdir());
    const turn = agent.prompt(sessionId, text("[slow]"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await agent.cancel(sessionId);
    expect((await turn).stopReason).toBe("cancelled");
  });

  it("reconciles an exit it did not ask for: pending requests fail, pending permissions cancel", async () => {
    const exits: unknown[] = [];
    const { process: agent, record } = fake();
    await agent.client.initialize();
    const { sessionId } = await agent.client.newSession(tmpdir());
    const turn = agent.prompt(sessionId, text("[permission]")).then(
      () => undefined,
      (error: unknown) => error,
    );
    const pending = await record.waitHeld();
    void agent.exited.then((exit) => exits.push(exit));

    process.kill(agent.pid, "SIGKILL");
    const exit = await agent.exited;

    expect(exit.requested).toBe(false);
    expect(exit.signal ?? exit.code).toBeTruthy();
    expect(agent.alive).toBe(false);
    expect(await turn).toBeInstanceOf(Error);
    expect(exits).toHaveLength(1);
    expect(agent.pendingPermissions()).toEqual([]);
    expect(record.settled.map((s) => [s.id, s.settlement.by])).toEqual([
      [pending.id, "cancelled"],
    ]);
    // 退出之后的 cancel 什么也不做，不抛。
    await agent.cancel(sessionId);
  });

  it("terminate() closes stdin, the agent leaves on its own, and the exit is marked as requested", async () => {
    const { process: agent } = fake();
    await agent.client.initialize();
    const exit = await agent.terminate();
    expect(exit.requested).toBe(true);
    expect(agent.alive).toBe(false);
    // 再调一次答同一个结果。
    expect(await agent.terminate()).toEqual(exit);
  });

  it("--minimal: an agent that declares nothing still answers a turn", async () => {
    const { process: agent, record } = fake(true);
    const init = await agent.client.initialize();
    expect(agent.client.supportsLoad()).toBe(false);
    expect(agent.client.supportsResume()).toBe(false);
    expect(init.agentCapabilities?.sessionCapabilities).toBeUndefined();
    const created = await agent.client.newSession(tmpdir());
    expect(created.modes).toBeUndefined();
    await expect(
      agent.client.resumeSession(created.sessionId, tmpdir()),
    ).rejects.toThrow();
    const result = await agent.prompt(created.sessionId, text("hi"));
    expect(result.stopReason).toBe("end_turn");
    expect(messages(record.updates, created.sessionId)).toEqual(["echo: hi"]);
  });

  it("refuses to start a program that does not exist with acp_spawn_failed", () => {
    let thrown: unknown;
    try {
      started.push(
        AcpProcess.spawn({
          program: "/nonexistent/armadra-acp-agent",
          args: [],
          cwd: tmpdir(),
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AcpError);
    expect((thrown as AcpError).toJSON().code).toBe("acp_spawn_failed");
  });
});
