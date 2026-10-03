import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceEvent } from "../bus";
import { tempDir } from "../testing/temp-dir";
import { type AcpHostSession, startAcp } from "./host";
import { AcpMirror, mirrorPath } from "./mirror";
import type { AcpSignal } from "./normalize";
import { AcpSession, type AcpSessionSink } from "./session";

/**
 * 一个 ACP 会话的协议侧语义（ACP 设计 §5.4–§5.7），对假 ACP Agent（真子进程），
 * 出口换成记录器：信号、事件、被取消的审批各记一份。
 */

const NODE = "11111111-2222-4333-8444-555555555555";
const sessions: AcpSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.terminate()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Recorder extends AcpSessionSink {
  readonly signals: { signal: AcpSignal; raw?: unknown }[];
  readonly events: WorkspaceEvent[];
  readonly cancelledIds: string[];
}

function recorder(): Recorder {
  const signals: { signal: AcpSignal; raw?: unknown }[] = [];
  const events: WorkspaceEvent[] = [];
  const cancelledIds: string[] = [];
  return {
    signals,
    events,
    cancelledIds,
    signal: (signal, raw) => signals.push({ signal, raw }),
    publish: (event) => events.push(event),
    cancelled: (pendingId) => cancelledIds.push(pendingId),
    transcriptPath: (_id, mirror) => mirror,
  };
}

async function open(
  options: { resume?: string; dataDir?: string } = {},
): Promise<{ session: AcpSession; sink: Recorder; dataDir: string }> {
  const dataDir = options.dataDir ?? tempDir("armadra-acp-session-");
  if (options.dataDir === undefined) dirs.push(dataDir);
  const sink = recorder();
  const session = new AcpSession({
    rowId: "row-1",
    generation: 1,
    nodeId: NODE,
    workspaceId: "ws",
    agentId: "claude",
    sink,
    mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
    resumeSessionId: options.resume,
  });
  const host: AcpHostSession = await startAcp({
    program: process.execPath,
    args: [fakeAcpAgentPath()],
    cwd: tmpdir(),
    ...(options.resume === undefined
      ? {}
      : { resume: { sessionId: options.resume, method: "load" } }),
    ...session.callbacks(),
  });
  session.opened(host);
  sessions.push(session);
  return { session, sink, dataDir };
}

async function until<T>(read: () => T, ready: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const kinds = (sink: Recorder) =>
  sink.signals.map((item) => item.signal.signal);
const turns = (sink: Recorder) =>
  sink.events.filter((event) => event.type === "acp.turn");

describe("an ACP session", () => {
  it("says opened, then prompt / turn around each turn, mirror before event", async () => {
    const { session, sink } = await open();
    expect(sink.signals[0]?.signal).toMatchObject({
      signal: "opened",
      sessionId: session.acpSessionId,
    });
    const turnId = session.prompt("hi");
    expect(turnId).toBe("1-1");
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(kinds(sink)).toEqual(["opened", "prompt", "turn"]);
    expect(turns(sink)[0]).toMatchObject({
      sessionId: "row-1",
      nodeId: NODE,
      turnId,
      stopReason: "end_turn",
    });
    // 每一帧 acp.update 发出时它已经在镜像里了：读回来的就是这一轮。
    const read = new AcpMirror(session.mirrorPath!).read();
    expect(read.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    const updates = sink.events.filter((event) => event.type === "acp.update");
    expect(
      updates.map(
        (event) =>
          (event as { update: { sessionUpdate: string } }).update.sessionUpdate,
      ),
    ).toEqual(["user_message_chunk", "agent_message_chunk", "usage_update"]);
  });

  it("queues prompts: one turn at a time", async () => {
    const { session, sink } = await open();
    session.prompt("one");
    session.prompt("two");
    expect(session.busy).toBe(true);
    await until(
      () => turns(sink).length,
      (count) => count === 2,
    );
    expect(kinds(sink)).toEqual(["opened", "prompt", "turn", "prompt", "turn"]);
    expect(session.busy).toBe(false);
  });

  it("holds a permission as blocked, and answers it with the agent's own option", async () => {
    const { session, sink } = await open();
    session.prompt("[permission]");
    const asked = await until(
      () => sink.signals.find((item) => item.signal.signal === "permission"),
      (item) => item !== undefined,
    );
    const pendingId = (asked!.signal as { pendingId: string }).pendingId;
    expect(asked!.raw).toMatchObject({
      protocol: "acp",
      toolCall: { toolCallId: "call-1" },
    });
    expect(session.pending().map((item) => item.pendingId)).toEqual([
      pendingId,
    ]);
    expect(session.owns(pendingId)).toBe(true);
    // 不认识的选项：不答。
    expect(session.answer(pendingId, "bogus")).toBe(false);
    expect(session.answer(pendingId, "allow")).toBe(true);
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(kinds(sink)).toContain("permissionSettled");
    expect(sink.cancelledIds).toEqual([]);
    expect(session.pending()).toEqual([]);
  });

  it("settles every pending approval as cancelled when the turn is cancelled", async () => {
    const { session, sink } = await open();
    session.prompt("[permission]");
    const asked = await until(
      () => sink.signals.find((item) => item.signal.signal === "permission"),
      (item) => item !== undefined,
    );
    const pendingId = (asked!.signal as { pendingId: string }).pendingId;
    await session.cancel();
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(sink.cancelledIds).toEqual([pendingId]);
    expect(turns(sink)[0]).toMatchObject({ stopReason: "cancelled" });
    // 已经结束的那条再答不进去。
    expect(session.answer(pendingId, "allow")).toBe(false);
  });

  it("settles a pending approval as cancelled when the adapter goes away", async () => {
    const { session, sink } = await open();
    session.prompt("[permission]");
    const asked = await until(
      () => sink.signals.find((item) => item.signal.signal === "permission"),
      (item) => item !== undefined,
    );
    const pendingId = (asked!.signal as { pendingId: string }).pendingId;
    await session.terminate();
    await until(
      () => sink.cancelledIds.length,
      (count) => count === 1,
    );
    expect(sink.cancelledIds).toEqual([pendingId]);
    expect(session.alive).toBe(false);
    expect(() => session.prompt("again")).toThrow(/not running/);
  });

  it("writes the replay of a load into an empty mirror only, and never publishes it", async () => {
    const dataDir = tempDir("armadra-acp-replay-");
    dirs.push(dataDir);
    // 镜像空着（从终端驱动切过来）：回放写进去，页面看得到之前的对话。
    const first = await open({ resume: "fake-7", dataDir });
    expect(first.session.resumed).toBe(true);
    expect(
      first.sink.events.filter((event) => event.type === "acp.update"),
    ).toEqual([]);
    const mirror = new AcpMirror(mirrorPath(dataDir, NODE, "fake-7"));
    expect(mirror.read().entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    await first.session.terminate();
    // 镜像里已经有了：再接回一次不重复写。
    await open({ resume: "fake-7", dataDir });
    expect(mirror.read().entries).toHaveLength(2);
    expect(join(dataDir, "acp")).toBeTruthy();
  });
});
