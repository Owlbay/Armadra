/**
 * `WS …/boards/{boardId}/sync` 的帧（契约 §16.1）：`y-protocols` 的 sync
 * step1 / step2 / update 与 awareness，外层一个 varUint 的消息类型——与
 * `y-websocket` 同一套编码，页面可以直接用现成的 provider。
 *
 *   * `0` sync：子类型 `0` step1（状态向量）、`1` step2（缺的更新）、`2`
 *     update。step1 只读者也能发（它只问「我缺什么」）；step2 / update 是写，
 *     要 `canvas:write`，没有的人发来一帧就丢弃并以 4403 关流。
 *   * `1` awareness：光标、选区、在看哪个节点。只读者也能发——让别人看见自己在
 *     看是在线表一直有的语义。
 *   * `3` query awareness：回一份当前全部 awareness。
 *
 * 这里不认 socket：连接只要求一个能 `send` 与 `close` 的对端，测试用两个内存
 * 客户端直接对接（`sync.test.ts`）。
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_QUERY_AWARENESS = 3;

/** 没有写权限却发了写帧、或者写权限被收回。页面据此转只读，不重连。 */
export const CLOSE_FORBIDDEN = 4403;
/** 帧解不开或者更新应用失败。 */
export const CLOSE_BAD_FRAME = 4400;
/** 一帧超过上限。 */
export const CLOSE_TOO_LARGE = 1009;
/** core 正在退出或这块板被卸载。 */
export const CLOSE_GOING_AWAY = 1001;

/** 一帧的上限：比白板快照上限（8 MiB）再宽一倍，留给首个 step2。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface SyncPeer {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

/** 一块板上的共享状态：文档与 awareness。 */
export interface SyncRoom {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
}

export interface ConnectionOptions {
  /** 写入更新流时记的作者；本机壳是 owner（`""`）。 */
  readonly principalId: string;
  /** 现在还能不能写。每个写帧都问一次。 */
  readonly canWrite: () => boolean;
}

/**
 * 一条同步连接。`origin` 就是它自己：文档的 `update` 事件据此知道这条更新
 * 是谁写的、不必回发给谁。
 */
export class SyncConnection {
  readonly principalId: string;
  private readonly canWrite: () => boolean;
  /** 这条连接在 awareness 里登记过的 clientID，断开时一起清掉。 */
  readonly awarenessIds = new Set<number>();
  private closed = false;

  constructor(
    private readonly room: SyncRoom,
    private readonly peer: SyncPeer,
    options: ConnectionOptions,
  ) {
    this.principalId = options.principalId;
    this.canWrite = options.canWrite;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 连上之后先说的两句：服务端的 step1，以及当前的 awareness。 */
  greet(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.room.doc);
    this.send(encoding.toUint8Array(encoder));
    const states = this.room.awareness.getStates();
    if (states.size > 0) {
      this.send(awarenessFrame(this.room.awareness, [...states.keys()]));
    }
  }

  /** 一帧进来。返回 `false` 表示这条连接已经因它关掉。 */
  receive(data: Uint8Array): boolean {
    if (this.closed) return false;
    if (data.byteLength > MAX_FRAME_BYTES) {
      this.close(CLOSE_TOO_LARGE, "frame too large");
      return false;
    }
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      switch (type) {
        case MESSAGE_SYNC:
          return this.receiveSync(decoder);
        case MESSAGE_AWARENESS: {
          const update = decoding.readVarUint8Array(decoder);
          awarenessProtocol.applyAwarenessUpdate(
            this.room.awareness,
            update,
            this,
          );
          return true;
        }
        case MESSAGE_QUERY_AWARENESS: {
          const states = this.room.awareness.getStates();
          this.send(awarenessFrame(this.room.awareness, [...states.keys()]));
          return true;
        }
        default:
          // 不认识的消息类型丢掉：新页面多一种帧不该把旧 core 的连接打断。
          return true;
      }
    } catch {
      this.close(CLOSE_BAD_FRAME, "bad frame");
      return false;
    }
  }

  private receiveSync(decoder: decoding.Decoder): boolean {
    const subtype = decoding.readVarUint(decoder);
    if (subtype === syncProtocol.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncStep1(decoder, encoder, this.room.doc);
      this.send(encoding.toUint8Array(encoder));
      return true;
    }
    if (
      subtype === syncProtocol.messageYjsSyncStep2 ||
      subtype === syncProtocol.messageYjsUpdate
    ) {
      const update = decoding.readVarUint8Array(decoder);
      // 先完整解一遍：`Y.applyUpdate` 吞掉解析错误只打日志，坏帧会悄悄变成
      // 半条更新。解不开就是坏帧。
      Y.decodeUpdate(update);
      // 更新帧要 `canvas:write`（契约 §16.1）：只读者带来新内容的更新丢弃，
      // 连接以 4403 关掉——页面因此知道自己是只读，而不是默默地与别人分叉。
      // 回答服务端 step1 的那份 step2 对只读者通常是空的（什么都不缺），放过。
      if (!this.canWrite()) {
        if (adds(this.room.doc, update)) {
          this.close(CLOSE_FORBIDDEN, "forbidden");
          return false;
        }
        return true;
      }
      Y.applyUpdate(this.room.doc, update, this);
      return true;
    }
    throw new Error(`unknown sync message ${subtype}`);
  }

  /** 别人写的一条文档更新，转给这条连接。 */
  sendUpdate(update: Uint8Array): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  }

  send(frame: Uint8Array): void {
    if (this.closed) return;
    try {
      this.peer.send(frame);
    } catch {
      this.close(CLOSE_GOING_AWAY, "send failed");
    }
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.peer.close(code, reason);
    } catch {
      // 对端已经没了；关闭只是记账。
    }
  }
}

/**
 * 这条更新会不会改变文档：在副本上应用，比快照（状态向量 + 删除集）。只在
 * 只读连接发来写帧时用，代价是一次整份复制。
 */
export function adds(doc: Y.Doc, update: Uint8Array): boolean {
  const trial = new Y.Doc({ gc: false });
  Y.applyUpdate(trial, Y.encodeStateAsUpdate(doc));
  const before = Y.snapshot(trial);
  Y.applyUpdate(trial, update);
  const changed = !Y.equalSnapshots(before, Y.snapshot(trial));
  trial.destroy();
  return changed;
}

export function awarenessFrame(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  );
  return encoding.toUint8Array(encoder);
}
