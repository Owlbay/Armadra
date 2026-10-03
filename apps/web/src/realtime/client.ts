import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";
import { REALTIME_CLOSE, REALTIME_MESSAGE } from "@armadra/shared";

/**
 * `WS …/boards/{boardId}/sync` 的页面一端（契约 §16.1）。
 *
 * 帧与 `y-websocket` 同一套编码，这里只是一份不带额外依赖的小实现：
 *
 *   * 连上先发自己的 step1 与本地 awareness；收到 core 的 step2 算「同步完」。
 *   * 文档的更新（来源不是这条连接）随手发出去；awareness 只发自己那一份。
 *   * 断开（网络、`1001`、坏帧）按退避重连，重连仍走 step1 / step2，离线期间
 *     的本地改动随之补齐。
 *   * `4403`：没有写权限。不再以写者身份重连——交给上层换一份全新的文档、
 *     以只读重连（`session.ts`），避免本地写不回去的改动卡在 step2 里反复被拒。
 *
 * `readOnly` 的连接只发 step1 与 awareness，不发任何文档更新。
 */

export type ClientStatus =
  /** 还没完成过第一次同步。 */
  | "connecting"
  /** 连着，并且至少同步过一次。 */
  | "online"
  /** 同步过，现在断开了：本地继续编辑，重连后补齐。 */
  | "offline"
  /** core 以 4403 关了流。 */
  | "forbidden"
  | "closed";

export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface RealtimeClientOptions {
  url: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  readOnly?: boolean;
  createSocket?: SocketFactory;
  /** 状态变化（含第一次同步完成）。 */
  onStatus?: (status: ClientStatus) => void;
  /** 一次连接没打开过就关了（升级被拒、网络不通）。上层据此复核要不要退回租约。 */
  onRefused?: (failures: number) => void;
  /** 退避：第 n 次重连前等多久。 */
  backoff?: (attempt: number) => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

export function defaultBackoff(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
}

function browserSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export class RealtimeClient {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly readOnly: boolean;
  private readonly options: RealtimeClientOptions;
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private refusals = 0;
  private synced = false;
  private stopped = false;
  private currentStatus: ClientStatus = "connecting";
  /** 这次连接以来收到过 awareness 的 clientID。 */
  private readonly seen = new Set<number>();

  constructor(options: RealtimeClientOptions) {
    this.options = options;
    this.doc = options.doc;
    this.awareness = options.awareness;
    this.readOnly = options.readOnly ?? false;
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    this.connect();
  }

  get status(): ClientStatus {
    return this.currentStatus;
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** 关掉连接、退订，告诉别人自己走了。之后不再重连。 */
  destroy(): void {
    if (this.stopped) return;
    // 先发一条「离开」，别人的在线表马上去掉这个人，而不是等 core 发现断线。
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "local",
    );
    this.stopped = true;
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.onerror = null;
      try {
        socket.close(1000, "bye");
      } catch {
        // 已经关了。
      }
    }
    this.setStatus("closed");
  }

  private setStatus(status: ClientStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatus?.(status);
  }

  private connect(): void {
    if (this.stopped) return;
    const create = this.options.createSocket ?? browserSocket;
    let socket: SocketLike;
    try {
      socket = create(this.options.url);
    } catch {
      this.schedule(false);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.seen.clear();
      this.attempt = 0;
      this.refusals = 0;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, REALTIME_MESSAGE.sync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      if (this.awareness.getLocalState() !== null) {
        this.send(awarenessFrame(this.awareness, [this.doc.clientID]));
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const data = bytesOf(event.data);
      if (data) this.receive(data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      // 别人的状态先留着：断线期间在线条照样列出他们（置灰）。重连同步完时
      // 把这段时间没再出现的人清掉（`pruneStale`）。
      if (event.code === REALTIME_CLOSE.forbidden) {
        this.stopped = true;
        this.setStatus("forbidden");
        return;
      }
      this.setStatus(this.synced ? "offline" : "connecting");
      this.schedule(opened);
    };
    // `onerror` 之后一定还有 `onclose`，重连只挂在 close 上。
    socket.onerror = () => undefined;
  }

  private schedule(opened: boolean): void {
    if (this.stopped || this.timer !== null) return;
    if (!opened) {
      this.refusals += 1;
      this.options.onRefused?.(this.refusals);
      if (this.stopped) return;
    }
    const delay = (this.options.backoff ?? defaultBackoff)(this.attempt);
    this.attempt += 1;
    this.timer = this.set(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private set(run: () => void, ms: number): unknown {
    return (this.options.setTimer ?? ((r, m) => setTimeout(r, m)))(run, ms);
  }

  private clear(handle: unknown): void {
    (
      this.options.clearTimer ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    )(handle);
  }

  private send(frame: Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    try {
      socket.send(frame);
    } catch {
      // 发不出去等 close 来处理。
    }
  }

  private receive(data: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === REALTIME_MESSAGE.sync) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, REALTIME_MESSAGE.sync);
        const subtype = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.doc,
          this,
        );
        // 回答 core 的 step1（step2）。只读连接也要答：core 认空 step2；本地
        // 若真有东西（不该有），core 会 4403。
        if (encoding.length(encoder) > 1) {
          this.send(encoding.toUint8Array(encoder));
        }
        if (subtype === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
        }
        if (subtype === syncProtocol.messageYjsSyncStep2) {
          this.pruneStale();
          this.setStatus("online");
        }
        return;
      }
      if (type === REALTIME_MESSAGE.awareness) {
        const update = decoding.readVarUint8Array(decoder);
        for (const id of awarenessClients(update)) this.seen.add(id);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
      }
    } catch {
      // 解不开的帧丢掉；core 不会发这种东西，发了也不该把页面打断。
    }
  }

  /**
   * 重连后 core 先发当前全部 awareness、再答 step2；到 step2 时还没出现过的
   * 别人就是断线期间走了的，清掉。
   */
  private pruneStale(): void {
    const stale = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.doc.clientID && !this.seen.has(id),
    );
    if (stale.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, stale, this);
    }
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.readOnly) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, REALTIME_MESSAGE.sync);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    const self = this.doc.clientID;
    const touched = [...change.added, ...change.updated, ...change.removed];
    if (!touched.includes(self)) return;
    this.send(awarenessFrame(this.awareness, [self]));
  };
}

export function awarenessFrame(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, REALTIME_MESSAGE.awareness);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  );
  return encoding.toUint8Array(encoder);
}

/** 一条 awareness 更新里有哪些 clientID（编码见 `y-protocols/awareness`）。 */
function awarenessClients(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}
