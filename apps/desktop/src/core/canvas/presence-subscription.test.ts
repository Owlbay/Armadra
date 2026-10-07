/**
 * `boards.presence`（契约 §36.4），对着一台装配完整的 core：控制面上的在线订阅。
 * 订上就是登记、连接着就是续期、订阅结束（取消、断线）就是离开；每一项是这个
 * 客户端看到的在线表。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { connectPeer, type Peer, type PeerEvent } from "../http/peer.fixture";
import { type RunningCore, run } from "../main";
import { createWorkspace } from "../workspaces/table";
import { listBoards } from "./boards";
import { canvasPresence } from "./routes";

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

const A = "tab-aaaaaaaaaaaa";
const B = "tab-bbbbbbbbbbbb";

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "armadra-presence-rpc-"));
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
  const workspace = createWorkspace(core.db.database, {
    name: "presence",
    rootPath: dataDir,
  });
  const board = listBoards(core.db.database, workspace.id)[0]!;
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return {
    core,
    base: `http://${tcp.host}:${tcp.port}`,
    workspaceId: workspace.id,
    boardId: board.id,
  };
}

async function peer(base: string): Promise<Peer> {
  const made = await connectPeer(base);
  peers.push(made);
  return made;
}

interface Item {
  boardId: string;
  clients: { clientId: string; deviceName: string }[];
  lease: { clientId: string } | null;
  writable?: boolean;
  deviceKey?: string;
}

const items = (events: readonly PeerEvent[]): Item[] =>
  events
    .filter((event) => event.event === "message")
    .map((e) => e.data as Item);

async function waitFor(test: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("没等到");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("boards.presence", () => {
  it("订上先发一份自己的在线表（带 writable 与 deviceKey），别人来了再发一份", async () => {
    const { base, workspaceId, boardId } = await start();
    const first = await peer(base);
    const call = first.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: A,
      deviceName: "MacBook",
    });
    expect((await call.response).status).toBe(200);
    const opening = await first.until(call.id, (list) => list.length >= 1);
    expect(items(opening)[0]).toMatchObject({
      boardId,
      writable: true,
      lease: { clientId: A },
      clients: [{ clientId: A, deviceName: "MacBook" }],
    });
    expect(typeof items(opening)[0]!.deviceKey).toBe("string");

    // 另一个客户端经 HTTP 心跳进来：A 的订阅收到新的在线表。
    const second = await peer(base);
    const beat = await second.call("boards.heartbeat", {
      workspaceId,
      boardId,
      clientId: B,
      deviceName: "iPad",
      active: true,
    }).response;
    expect(beat.status).toBe(200);
    const seen = await first.until(call.id, (list) => list.length >= 2);
    expect(items(seen)[1]!.clients.map((client) => client.clientId)).toEqual([
      A,
      B,
    ]);
    expect(items(seen)[1]!.lease).toMatchObject({ clientId: A });
  });

  it("取消订阅就是离开：在线表摘掉它，租约释放", async () => {
    const { base, workspaceId, boardId } = await start();
    const client = await peer(base);
    const call = client.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: A,
    });
    await client.until(call.id, (list) => list.length >= 1);
    expect(canvasPresence()!.snapshot(boardId).clients).toHaveLength(1);
    client.abort(call.id);
    await waitFor(
      () => canvasPresence()!.snapshot(boardId).clients.length === 0,
    );
    expect(canvasPresence()!.snapshot(boardId).lease).toBeNull();
  });

  it("连接断了同样是离开，不必等 30 秒的心跳过期", async () => {
    const { base, workspaceId, boardId } = await start();
    const client = await peer(base);
    const call = client.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: A,
    });
    await client.until(call.id, (list) => list.length >= 1);
    client.socket.terminate();
    await waitFor(
      () => canvasPresence()!.snapshot(boardId).clients.length === 0,
    );
  });

  it("同一个客户端开着两条订阅：最后一条走了才算离开", async () => {
    const { base, workspaceId, boardId } = await start();
    const client = await peer(base);
    const one = client.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: A,
    });
    const two = client.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: A,
    });
    await client.until(one.id, (list) => list.length >= 1);
    await client.until(two.id, (list) => list.length >= 1);
    client.abort(one.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(canvasPresence()!.snapshot(boardId).clients).toHaveLength(1);
    client.abort(two.id);
    await waitFor(
      () => canvasPresence()!.snapshot(boardId).clients.length === 0,
    );
  });

  it("先决条件的拒绝是这次调用的错误：没有这块板、clientId 不合字符集", async () => {
    const { base, workspaceId, boardId } = await start();
    const client = await peer(base);
    const missing = await client.call("boards.presence", {
      workspaceId,
      boardId: "no-such-board",
      clientId: A,
    }).response;
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "not_found" });
    const bad = await client.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: "x",
    }).response;
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "bad_request" });
    expect(canvasPresence()!.snapshot(boardId).clients).toHaveLength(0);
  });

  it("实时板上两个订阅不会互相触发：事件数有界，主线程不被占满", async () => {
    const { core, base, workspaceId, boardId } = await start();
    // 实时板没有租约可分，`view` 里恒为空——从前每一拍心跳都为此白发一帧事件。
    canvasPresence()!.setRealtimeProbe(() => true);
    let frames = 0;
    core.bus.on("workspace.event", (frame) => {
      if (frame.event.type === "canvas.presence") frames += 1;
    });
    const first = await peer(base);
    const second = await peer(base);
    const one = first.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: A,
    });
    const two = second.call("boards.presence", {
      workspaceId,
      boardId,
      clientId: B,
    });
    await first.until(one.id, (list) => list.length >= 1);
    await second.until(two.id, (list) => list.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 两个客户端登记、各看见对方：几帧而已。互相触发的话这里是成千上万。
    expect(frames).toBeLessThan(10);
    expect(items(first.events.get(one.id) ?? []).length).toBeLessThan(6);
    // 事件循环还转得动：一次普通调用在时限内答出来。
    const answer = await first.call("boards.heartbeat", {
      workspaceId,
      boardId,
      clientId: A,
    }).response;
    expect(answer.status).toBe(200);
  });

  it("订阅只经控制面：经 HTTP 调答 405", async () => {
    const { base, workspaceId, boardId } = await start();
    const response = await fetch(`${base}/api/rpc/boards/presence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { workspaceId, boardId, clientId: A } }),
    });
    expect(response.status).toBe(405);
  });
});
