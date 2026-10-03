import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { REALTIME_CLOSE, REALTIME_MESSAGE } from "@armadra/shared";

import { RealtimeClient, type ClientStatus, type SocketLike } from "./client";

/** 一个内存里的「core」：一份文档，说同一套帧。 */
class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: Uint8Array[] = [];
  closed: { code?: number } | null = null;
  constructor(readonly url: string) {}
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = { code };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(frame: Uint8Array) {
    this.onmessage?.({ data: frame.slice().buffer });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function kindOf(frame: Uint8Array): [number, number | null] {
  const decoder = decoding.createDecoder(frame);
  const type = decoding.readVarUint(decoder);
  return [type, type === 0 ? decoding.readVarUint(decoder) : null];
}

/** core 那一侧：处理客户端的帧，回它该回的。 */
function serve(server: Y.Doc, socket: FakeSocket): void {
  for (const frame of socket.sent.splice(0)) {
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type !== REALTIME_MESSAGE.sync) continue;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, REALTIME_MESSAGE.sync);
    syncProtocol.readSyncMessage(decoder, encoder, server, "client");
    if (encoding.length(encoder) > 1) {
      socket.deliver(encoding.toUint8Array(encoder));
    }
  }
}

function setup(options: { readOnly?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: (() => void)[] = [];
  const statuses: ClientStatus[] = [];
  const refusals: number[] = [];
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const client = new RealtimeClient({
    url: "ws://core/sync",
    doc,
    awareness,
    readOnly: options.readOnly,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onStatus: (status) => statuses.push(status),
    onRefused: (n) => refusals.push(n),
    setTimer: (run) => {
      timers.push(run);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return { client, doc, awareness, sockets, timers, statuses, refusals };
}

describe("…/sync 客户端（契约 §16.1）", () => {
  it("连上发 step1；收到 step2 算同步完", () => {
    const server = new Y.Doc();
    server.getMap("nodes").set("x", new Y.Map());
    const { client, doc, sockets, statuses } = setup();
    const socket = sockets[0]!;
    socket.open();
    expect(kindOf(socket.sent[0]!)).toEqual([0, 0]);
    expect(client.isSynced).toBe(false);

    serve(server, socket);
    expect(client.isSynced).toBe(true);
    expect(statuses).toEqual(["online"]);
    expect(doc.getMap("nodes").has("x")).toBe(true);
    client.destroy();
  });

  it("本地更新发出去；收到的远端更新不回发", () => {
    const server = new Y.Doc();
    const { client, doc, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();
    serve(server, socket);
    socket.sent.length = 0;

    doc.getMap("meta").set("k", "v");
    expect(socket.sent.map(kindOf)).toEqual([[0, 2]]);
    serve(server, socket);
    expect(server.getMap("meta").get("k")).toBe("v");

    socket.sent.length = 0;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, REALTIME_MESSAGE.sync);
    const other = new Y.Doc();
    other.getMap("meta").set("o", 1);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(other));
    socket.deliver(encoding.toUint8Array(encoder));
    expect(doc.getMap("meta").get("o")).toBe(1);
    expect(socket.sent).toEqual([]);
    client.destroy();
  });

  it("只读连接不发文档更新", () => {
    const { client, doc, sockets } = setup({ readOnly: true });
    const socket = sockets[0]!;
    socket.open();
    socket.sent.length = 0;
    doc.getMap("meta").set("k", "v");
    expect(socket.sent).toEqual([]);
    client.destroy();
  });

  it("断线：状态转离线，按退避重连，重连再走 step1", () => {
    const server = new Y.Doc();
    const { client, sockets, timers, statuses } = setup();
    sockets[0]!.open();
    serve(server, sockets[0]!);
    sockets[0]!.drop(REALTIME_CLOSE.goingAway);
    expect(statuses.at(-1)).toBe("offline");
    expect(timers).toHaveLength(1);

    timers.shift()!();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(kindOf(sockets[1]!.sent[0]!)).toEqual([0, 0]);
    serve(server, sockets[1]!);
    expect(statuses.at(-1)).toBe("online");
    client.destroy();
  });

  it("4403：转 forbidden，不再重连", () => {
    const { client, sockets, timers, statuses } = setup();
    sockets[0]!.open();
    sockets[0]!.drop(REALTIME_CLOSE.forbidden);
    expect(statuses.at(-1)).toBe("forbidden");
    expect(timers).toHaveLength(0);
    client.destroy();
  });

  it("没打开过就关了：记一次拒绝，交给上层复核", () => {
    const { client, sockets, refusals, statuses } = setup();
    sockets[0]!.drop(1006);
    expect(refusals).toEqual([1]);
    expect(statuses).toEqual([]);
    client.destroy();
  });

  it("awareness 只发自己那一份；destroy 先说一声离开", () => {
    const { client, awareness, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();
    socket.sent.length = 0;
    awareness.setLocalState({ deviceId: "d", name: "n", color: 2 });
    expect(socket.sent.map(kindOf)).toEqual([[1, null]]);

    socket.sent.length = 0;
    client.destroy();
    expect(socket.sent.map(kindOf)).toEqual([[1, null]]);
    expect(socket.closed?.code).toBe(1000);
    expect(client.status).toBe("closed");
  });
});
