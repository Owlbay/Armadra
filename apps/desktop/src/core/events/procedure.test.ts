/**
 * `workspaces.events`（契约 §35.4–§35.5），对着一台装配完整的 core：控制面上的
 * 订阅、断线后带 `lastEventId` 续订由 outbox 补齐、续不上的两种拒绝、授权收回、
 * 以及慢客户端的 `overflow` 与重订之后一帧不少。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { connectPeer, type Peer, type PeerEvent } from "../http/peer.fixture";
import { type RunningCore, run } from "../main";
import { prune } from "./outbox";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];
const peers: Peer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.socket.terminate();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const WORKSPACE = "ws";

async function start(): Promise<{ core: RunningCore; base: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-events-rpc-"));
  directories.push(dataDir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
      ARMADRA_LOOPBACK_OWNER: "1",
    },
    stdout: () => {},
  });
  running.push(core);
  core.db.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      WORKSPACE,
      "ws",
      "/tmp/ws",
      "2026-10-06T00:00:00Z",
      "2026-10-06T00:00:00Z",
    );
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return { core, base: `http://${tcp.host}:${tcp.port}` };
}

async function peer(base: string): Promise<Peer> {
  const made = await connectPeer(base);
  peers.push(made);
  return made;
}

function publish(core: RunningCore, nodeId: string, request: unknown = {}) {
  core.bus.emit("workspace.event", {
    workspaceId: WORKSPACE,
    event: {
      type: "agent.approval",
      nodeId,
      pendingId: nodeId,
      request,
    },
  });
}

/** 一个订阅收到的业务事件（去掉位置帧）的节点名。 */
function nodes(events: readonly PeerEvent[]): string[] {
  return events
    .filter((item) => item.event === "message")
    .map((item) => item.data as { type: string; nodeId?: string })
    .filter((data) => data.type !== "cursor")
    .map((data) => data.nodeId ?? "");
}

function lastId(events: readonly PeerEvent[]): string | undefined {
  return events.filter((item) => item.id !== undefined).at(-1)?.id;
}

describe("workspaces.events", () => {
  it("订上先收一帧位置帧，之后每个事件带 outbox 序号作 id", async () => {
    const { core, base } = await start();
    const client = await peer(base);
    const { id, response } = client.call("workspaces.events", {
      workspaceId: WORKSPACE,
    });
    const answer = await response;
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/event-stream");
    const first = await client.until(id, (events) => events.length >= 1);
    expect(first[0]?.data).toMatchObject({ type: "cursor" });
    publish(core, "a");
    publish(core, "b");
    const events = await client.until(id, (list) => nodes(list).length >= 2);
    expect(nodes(events)).toEqual(["a", "b"]);
    const ids = events.slice(1).map((item) => Number(item.id));
    expect(ids[1]).toBeGreaterThan(ids[0] ?? Infinity);
  });

  it("断开期间的事件在带 lastEventId 重订后由 outbox 补齐，和没断的一致", async () => {
    const { core, base } = await start();
    const steady = await peer(base);
    const steadyCall = steady.call("workspaces.events", {
      workspaceId: WORKSPACE,
    });
    const flaky = await peer(base);
    const flakyCall = flaky.call("workspaces.events", {
      workspaceId: WORKSPACE,
    });
    await steady.until(steadyCall.id, (list) => list.length >= 1);
    await flaky.until(flakyCall.id, (list) => list.length >= 1);
    publish(core, "1");
    const before = await flaky.until(
      flakyCall.id,
      (list) => nodes(list).length >= 1,
    );
    const resumeFrom = lastId(before);
    flaky.socket.terminate();
    for (const name of ["2", "3", "4"]) publish(core, name);
    // 别的工作空间的事件也推高了序号，不能让续订漏掉或重放。
    core.bus.emit("workspace.event", {
      workspaceId: "other",
      event: { type: "workspace.updated", workspaceId: "other" },
    });
    publish(core, "5");
    const back = await peer(base);
    const resumed = back.call(
      "workspaces.events",
      { workspaceId: WORKSPACE },
      { "last-event-id": resumeFrom ?? "" },
    );
    publish(core, "6");
    // 「6」可能在订阅之前就发了（进补发），也可能之后（走实时）：等齐五个事件
    // 与那一帧位置帧。
    const replayed = await back.until(
      resumed.id,
      (list) =>
        nodes(list).length >= 5 &&
        list.some((item) => (item.data as { type?: string }).type === "cursor"),
    );
    expect(nodes(replayed)).toEqual(["2", "3", "4", "5", "6"]);
    const all = await steady.until(
      steadyCall.id,
      (list) => nodes(list).length >= 6,
    );
    expect([...nodes(before), ...nodes(replayed)]).toEqual(nodes(all));
    // 位置帧只有一帧，在补发之后：它前面的序号都不比它大。
    const kinds = replayed.map((item) => (item.data as { type: string }).type);
    const at = kinds.indexOf("cursor");
    expect(kinds.lastIndexOf("cursor")).toBe(at);
    for (const item of replayed.slice(0, at)) {
      expect(Number(item.id)).toBeLessThanOrEqual(Number(replayed[at]?.id));
    }
  });

  it("位置掉出保留下限答 snapshot_required，比水位还新答 cursor_ahead", async () => {
    const { core, base } = await start();
    for (const name of ["1", "2", "3", "4"]) publish(core, name);
    prune(core.db.database, 1);
    const client = await peer(base);
    const old = await client.call(
      "workspaces.events",
      { workspaceId: WORKSPACE },
      { "last-event-id": "1" },
    ).response;
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ code: "snapshot_required" });
    const ahead = await client.call("workspaces.events", {
      workspaceId: WORKSPACE,
      cursor: 1_000_000,
    }).response;
    expect(ahead.status).toBe(409);
    expect(ahead.body).toMatchObject({ code: "cursor_ahead" });
    const missing = await client.call("workspaces.events", {
      workspaceId: "nope",
    }).response;
    expect(missing.status).toBe(404);
  });

  it("慢客户端：队列满了以 overflow 结束订阅，重订之后一帧不少", async () => {
    const { core, base } = await start();
    const client = await peer(base);
    const first = client.call("workspaces.events", { workspaceId: WORKSPACE });
    await client.until(first.id, (list) => list.length >= 1);
    // 停读：core 这一侧的缓冲很快过 1 MiB，之后进有界队列，满了就 overflow。
    client.socket.pause();
    const total = 3_000;
    const padding = "x".repeat(8_000);
    for (let index = 0; index < total; index += 1) {
      publish(core, String(index), { padding });
    }
    client.socket.resume();
    const ended = await client.until(
      first.id,
      (list) => list.some((item) => item.event === "error"),
      20_000,
    );
    const failure = ended.find((item) => item.event === "error");
    expect(failure?.data).toMatchObject({ code: "overflow" });
    const received = nodes(ended);
    expect(received.length).toBeLessThan(total);
    const again = client.call(
      "workspaces.events",
      { workspaceId: WORKSPACE },
      { "last-event-id": lastId(ended) ?? "" },
    );
    const rest = await client.until(
      again.id,
      (list) => received.length + nodes(list).length >= total,
      20_000,
    );
    expect([...received, ...nodes(rest)]).toEqual(
      Array.from({ length: total }, (_value, index) => String(index)),
    );
  }, 60_000);

  it("取消订阅：core 这一侧的监听随之释放", async () => {
    const { core, base } = await start();
    const client = await peer(base);
    const call = client.call("workspaces.events", { workspaceId: WORKSPACE });
    await client.until(call.id, (list) => list.length >= 1);
    const { eventStream } = await import("./index");
    expect(eventStream()?.subscriberCount(WORKSPACE)).toBe(1);
    client.abort(call.id);
    publish(core, "after");
    await new Promise((done) => setTimeout(done, 100));
    expect(eventStream()?.subscriberCount(WORKSPACE)).toBe(0);
  });
});
