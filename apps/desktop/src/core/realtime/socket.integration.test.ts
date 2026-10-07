/**
 * `WS …/boards/{boardId}/sync` 对一个真的 core：升级前的拒绝、帧在线上的样子、
 * 切到实时之后旧写法被拒、Hello 报的能力，以及 core 退出时的物化。
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { listBoards } from "../canvas/boards";
import { loadBoard } from "../canvas/documents";
import { type RunningCore, run } from "../main";
import {
  type LoopbackSession,
  loopbackSession,
} from "../testing/loopback-session";
import { createWorkspace } from "../workspaces/table";
import { projectDoc, nodesOf } from "./doc";
import { REALTIME_CAPABILITY } from "./index";
import { MESSAGE_SYNC } from "./sync";
import { stickyNode } from "../canvas/nodes.fixture";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");

const running: RunningCore[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const core of running.splice(0)) await core.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function start(dataDir?: string): Promise<RunningCore> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "armadra-realtime-"));
  if (dataDir === undefined) directories.push(dir);
  const core = await run({
    argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dir],
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
      ARMADRA_SECRET_BACKEND: "file",
    },
    stdout: () => {},
  });
  running.push(core);
  return core;
}

function host(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `${tcp.host}:${tcp.port}`;
}

function board(core: RunningCore): { workspaceId: string; boardId: string } {
  const workspace = createWorkspace(core.db.database, {
    name: "rt",
    rootPath: realpathSync(core.dataDir),
  });
  const first = listBoards(core.db.database, workspace.id)[0];
  if (first === undefined) throw new Error("no board");
  return { workspaceId: workspace.id, boardId: first.id };
}

/**
 * 回环上的会话（契约 §3.2）：同步流和页面一样先换一张一次性票，经
 * `Sec-WebSocket-Protocol` 升级；HTTP 带 Bearer。
 */
const sessions = new Map<RunningCore, Promise<LoopbackSession>>();

function session(core: RunningCore): Promise<LoopbackSession> {
  let found = sessions.get(core);
  if (found === undefined) {
    found = loopbackSession(core, `http://${host(core)}`);
    sessions.set(core, found);
  }
  return found;
}

async function open(core: RunningCore, path: string): Promise<WebSocket> {
  const own = await session(core);
  const socket = new WebSocket(
    `ws://${host(core)}${path}`,
    [await own.wsProtocol()],
    { origin: own.origin },
  );
  socket.binaryType = "nodebuffer";
  sockets.push(socket);
  return new Promise((resolve_, reject) => {
    socket.once("open", () => resolve_(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`HTTP ${response.statusCode}`));
    });
  });
}

/** 把一条 socket 接到一份客户端文档上，直到 `settled` 为真。 */
function attach(socket: WebSocket, doc: Y.Doc): void {
  socket.on("message", (data: Buffer) => {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, doc, "remote");
    if (encoding.length(encoder) > 1)
      socket.send(encoding.toUint8Array(encoder));
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    socket.send(encoding.toUint8Array(encoder));
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  socket.send(encoding.toUint8Array(encoder));
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve_) => setTimeout(resolve_, 10));
  }
}

async function http(
  core: RunningCore,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const own = await session(core);
  const response = await fetch(`http://${host(core)}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...own.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

describe("同步流（真 core）", () => {
  it("升级前 404；切到实时后两个客户端互通，旧写法 409", async () => {
    const core = await start();
    const { workspaceId, boardId } = board(core);
    await expect(
      open(
        core,
        `/api/workspaces/${workspaceId}/boards/${crypto.randomUUID()}/sync`,
      ),
    ).rejects.toThrow(/404/);

    const hello = await http(core, "GET", "/api/identity/hello");
    expect((hello.body as { capabilities: string[] }).capabilities).toContain(
      REALTIME_CAPABILITY,
    );
    const before = await http(
      core,
      "GET",
      `/api/workspaces/${workspaceId}/boards/${boardId}/realtime`,
    );
    expect(before.body).toEqual({
      realtime: false,
      materializedSeq: 0,
      enabled: true,
    });

    const path = `/api/workspaces/${workspaceId}/boards/${boardId}/sync`;
    const a = new Y.Doc();
    const b = new Y.Doc();
    attach(await open(core, path), a);
    attach(await open(core, path), b);

    const note = stickyNode(boardId);
    a.transact(() => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(note)) {
        if (key !== "id" && key !== "boardId") map.set(key, value);
      }
      nodesOf(a).set(note.id, map);
    });
    await until(() => projectDoc(b, boardId).nodes.length === 1);
    expect(projectDoc(b, boardId).nodes[0]?.id).toBe(note.id);

    const after = await http(
      core,
      "GET",
      `/api/workspaces/${workspaceId}/boards/${boardId}/realtime`,
    );
    expect(after.body).toMatchObject({ realtime: true, enabled: true });

    const document = loadBoard(core.db.database, workspaceId, boardId);
    const put = await http(
      core,
      "PUT",
      `/api/workspaces/${workspaceId}/boards/${boardId}/document`,
      {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        clientId: "client-aaaaaaaa",
      },
    );
    expect(put.status).toBe(409);
    expect(put.body).toMatchObject({ code: "realtime_active" });
  });

  it("core 退出时物化，重启后表里就是文档", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "armadra-realtime-"));
    directories.push(dataDir);
    const core = await start(dataDir);
    const { workspaceId, boardId } = board(core);
    const doc = new Y.Doc();
    attach(
      await open(core, `/api/workspaces/${workspaceId}/boards/${boardId}/sync`),
      doc,
    );
    const note = stickyNode(boardId);
    doc.transact(() => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of Object.entries(note)) {
        if (key !== "id" && key !== "boardId") map.set(key, value);
      }
      nodesOf(doc).set(note.id, map);
    });
    await until(
      () =>
        Number(
          (
            core.db.database
              .prepare(
                "SELECT COUNT(*) AS n FROM board_updates WHERE board_id = ?",
              )
              .get(boardId) as { n: number }
          ).n,
        ) > 0,
    );
    running.splice(running.indexOf(core), 1);
    await core.stop();

    const again = await start(dataDir);
    expect(
      loadBoard(again.db.database, workspaceId, boardId).nodes.map(
        (node) => node.id,
      ),
    ).toEqual([note.id]);
  });
});
