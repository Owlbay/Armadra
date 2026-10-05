/**
 * `WS /api/workspaces/{id}/events` — the per-workspace fan-out.
 *
 * Ported from the pre-merge implementation (`EventHub` and the socket loop).
 * The acceptance test for
 * this file is `apps/web/src/api/events.ts`, which is not allowed to change: a
 * frame it cannot parse through `workspaceEventSchema` is a frame it drops.
 *
 * What the Rust side does, and therefore what this does:
 *
 *   * **No handshake.** The stream opens and says nothing. There is no initial
 *     snapshot and no server hello — the front end's own reducers are seeded by
 *     the REST reads it already made, and a snapshot frame would be a 22nd
 *     event type nothing parses.
 *   * **No application heartbeat.** No frame of this protocol is a ping. The
 *     `ws`-level ping every stream gets from `http/server.ts` (control frames,
 *     answered by the browser itself) is what keeps a quiet socket alive
 *     through proxies and ends a dead one.
 *   * **Read-only.** A client frame matters only as a close. Anything else is
 *     ignored rather than answered, and there is no ack: the transport is the
 *     acknowledgement, and a client that missed frames re-reads instead.
 *   * **A slow subscriber loses frames, not its connection.** The Rust receiver
 *     is a `broadcast` channel of 256; a subscriber that falls further behind
 *     than that gets `RecvError::Lagged`, which the loop answers with
 *     `continue` — it resumes at the oldest frame still in the ring and the
 *     skipped ones are gone. It is never disconnected for being slow, because
 *     disconnecting it would cost it the frames it *could* still keep up with.
 *   * **Reconnection is the client's.** `nextReconnectDelay` in `api/events.ts`
 *     backs off 1 s → 2 s → 4 s → 8 s → 10 s and resets on open. The server has
 *     no part in it and keeps no session across one.
 */

import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";

import type { EventBus, WorkspaceEvent } from "../bus";
import { OPEN, SendQueue, wsTarget } from "../http/stream-queue";
import { appendEvent, catchUp, outboxReady, prune, watermark } from "./outbox";

/**
 * 只扇出、不进 outbox 的事件。
 *
 * `canvas.presence` 描述的是「此刻谁在看」，它的真相在内存里、随心跳过期
 * （`canvas/presence.ts`）。补发一帧过去的在线表只会让一个续订的页面短暂地
 * 看见已经走了的设备，而它重连后的第一次心跳本来就会带回当前的那一份。
 */
export const EPHEMERAL_EVENTS: ReadonlySet<string> = new Set([
  "canvas.presence",
]);

/**
 * How far behind one connection may fall before it starts losing frames.
 *
 * 256, the capacity of the Rust `broadcast` channel, and for the same reason: a
 * board being dragged produces frames faster than a socket on a busy machine
 * drains them, and the choice is between a bounded loss and an unbounded
 * buffer. `ws` will happily queue gigabytes into `bufferedAmount`, so the bound
 * has to be kept here.
 */
export const MAX_QUEUED_FRAMES = 256;

/**
 * 一条连接的缓冲超过多少字节就算跟不上（平台规格 core 包 §3.3）：之后的帧进
 * 有界队列，满了丢最旧的。
 */
export const EVENT_HIGH_WATER_BYTES = 1024 * 1024;

/** 一次续订最多读多少页 outbox。有界，所以一个坏游标转不起来。 */
export const MAX_REPLAY_PASSES = 32;

/**
 * What a subscriber is, once the socket details are stripped away.
 *
 * `written` is the backpressure signal and the only reason this is an interface
 * rather than a `WebSocket`: a sink that calls it immediately never queues, and
 * a sink that calls it when the bytes have left the process is what bounds a
 * slow client's backlog.
 */
export interface EventSink {
  /** Serialised frame, ready for the wire. */
  send(frame: string, written: () => void): void;
  /** The socket's own backlog, when there is a socket; `0` when absent. */
  readonly bufferedAmount?: number;
  /** `1` (open) when absent. */
  readonly readyState?: number;
}

interface Subscription {
  /**
   * `drop-oldest`, bounded by `MAX_QUEUED_FRAMES` past a backlog of
   * `EVENT_HIGH_WATER_BYTES` — the shared queue every stream uses
   * (`http/stream-queue.ts`), which also counts the drops.
   */
  readonly queue: SendQueue;
  closed: boolean;
  /**
   * 这条订阅带了 `?cursor=`，所以它还要收游标控制帧。
   *
   * 默认关。页面（`apps/web/src/api/events.ts`）从不带游标，于是它永远只看到
   * 那 21 个契约事件；控制帧只发给明确要求续订的客户端。
   */
  readonly cursored: boolean;
}

/**
 * 游标控制帧。
 *
 * **不是第 22 个 `WorkspaceEvent`**：它只发给带了 `?cursor=` 的订阅，而契约说的
 * 那 21 个 `type` 字符串是「页面会解析的那些」。`workspaceEventSchema` 解不开
 * 这一帧，`parseFrame` 直接丢掉——但页面根本收不到它，因为页面不带游标。
 *
 * 帧本身不加 `seq` 字段是同一条契约的另一半：加一个字段要同步改
 * `packages/shared`，那是破坏性改动。位置信息走带外，就是这一帧。
 */
export function cursorFrame(
  cursor: number,
  floor: number,
  watermark: number,
): string {
  return JSON.stringify({ type: "cursor", cursor, floor, watermark });
}

/**
 * The fan-out itself: subscriptions by workspace, and one bounded queue per
 * connection.
 *
 * Deliberately not one queue per workspace. Two clients watching the same board
 * are two connections with two drain rates, and a shared queue would make the
 * slower one's backlog the faster one's latency — which is precisely the
 * property the acceptance asks about ("慢客户端不拖慢快客户端").
 */
/**
 * 控制面订阅（`workspaces.events`，契约 §35.4）收帧的回调：序列化好的那一帧和
 * 它的 outbox 序号（不进 outbox 的是 0）。背压由 RPC 门面的有界队列管。
 */
export type EventListener = (frame: string, seq: number) => void;

export class WorkspaceEventStream {
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  /** 有库就有 outbox；没有就退回 R1b 的纯内存扇出。 */
  private database: DatabaseSync | undefined;
  /** 每写多少帧裁剪一次，摊掉 `DELETE` 的成本。 */
  private sincePrune = 0;

  /**
   * Attaches to a bus and returns the detach function.
   *
   * Every domain emits `workspace.event`; nothing emits to a socket directly.
   */
  attach(bus: EventBus): () => void {
    return bus.on("workspace.event", ({ workspaceId, event }) => {
      this.publish(workspaceId, event);
    });
  }

  /**
   * 接上 outbox。
   *
   * 分成两步而不是构造参数，因为装配顺序是「事件域第一个装」——它要在任何域可
   * 能发事件之前就位，而那时候库已经开好了。没过 0017 的库没有 `events` 表，
   * 这时候什么都不接：实时扇出照常，只是补发不了。
   */
  useOutbox(database: DatabaseSync): boolean {
    if (!outboxReady(database)) return false;
    this.database = database;
    return true;
  }

  /** outbox 在不在。带 `?cursor=` 的升级靠它决定拒绝还是补发。 */
  get durable(): DatabaseSync | undefined {
    return this.database;
  }

  /**
   * Hands one event to everybody watching that workspace.
   *
   * Serialised once for all of them: the frame is identical per connection, and
   * a board with thirty nodes open in two windows would otherwise pay for the
   * same `JSON.stringify` twice. Publishing into a workspace nobody watches is
   * a no-op and never an error — a save that nobody is looking at is still a
   * save.
   */
  publish(workspaceId: string, event: WorkspaceEvent): number {
    // 序列化在扇出之前，也在 outbox 之前：补发的必须是当初发出去的那一帧，
    // 从记录里重新拼一次就给了它一个走样的机会。
    const frame = JSON.stringify(event);
    const seq = EPHEMERAL_EVENTS.has(event.type)
      ? 0
      : this.record(workspaceId, event, frame);
    const listeners = this.listeners.get(workspaceId);
    for (const listener of listeners ?? []) {
      try {
        listener(frame, seq);
      } catch {
        // 一个订阅出错不该让其余的漏帧。
      }
    }
    const watchers = this.subscriptions.get(workspaceId);
    if (watchers === undefined || watchers.size === 0) {
      return listeners?.size ?? 0;
    }
    for (const subscription of watchers) this.enqueue(subscription, frame, seq);
    return watchers.size + (listeners?.size ?? 0);
  }

  /**
   * 控制面订阅收帧（契约 §35.4），返回退订函数。和 {@link subscribe} 一样算一个
   * 「在看」的人：资源采样与 Agent 状态按它决定发不发。
   */
  listen(workspaceId: string, listener: EventListener): () => void {
    const set = this.listeners.get(workspaceId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(workspaceId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(workspaceId) === set) {
        this.listeners.delete(workspaceId);
      }
    };
  }

  /**
   * 写 outbox。
   *
   * 不开自己的事务：调用方要么已经在一次业务写入的事务里（那这条记录搭同一班
   * 车），要么那次写入本身就是单语句事务。这是 outbox 模式唯一要紧的那条规矩。
   *
   * 写不进去不往上抛：一次存下来的看板文档仍然是存下来了，广播补发不了只是
   * 少了一次续订的机会，不该把那次保存变成失败。
   */
  private record(
    workspaceId: string,
    event: WorkspaceEvent,
    frame: string,
  ): number {
    const database = this.database;
    if (database === undefined || workspaceId === "") return 0;
    try {
      const seq = appendEvent(database, workspaceId, event, frame);
      this.sincePrune += 1;
      if (this.sincePrune >= 256) {
        this.sincePrune = 0;
        prune(database);
      }
      return seq;
    } catch {
      return 0;
    }
  }

  /** Registers a sink and returns the function that removes it. */
  subscribe(
    workspaceId: string,
    sink: EventSink,
    options: { readonly cursored?: boolean } = {},
  ): () => void {
    const subscription: Subscription = {
      queue: new SendQueue(
        {
          send: (frame, written) => sink.send(frame as string, written),
          get bufferedAmount() {
            return sink.bufferedAmount ?? 0;
          },
          get readyState() {
            return sink.readyState ?? OPEN;
          },
        },
        {
          policy: "drop-oldest",
          maxFrames: MAX_QUEUED_FRAMES,
          highWaterBytes: EVENT_HIGH_WATER_BYTES,
        },
      ),
      closed: false,
      cursored: options.cursored === true,
    };
    const watchers =
      this.subscriptions.get(workspaceId) ?? new Set<Subscription>();
    watchers.add(subscription);
    this.subscriptions.set(workspaceId, watchers);
    return () => {
      subscription.closed = true;
      subscription.queue.close();
      watchers.delete(subscription);
      // A workspace nobody watches keeps no entry: the map would otherwise grow
      // by one every time a board was opened and closed for the rest of the run.
      if (watchers.size === 0) this.subscriptions.delete(workspaceId);
    };
  }

  /** How many connections are watching one workspace. */
  subscriberCount(workspaceId: string): number {
    return (
      (this.subscriptions.get(workspaceId)?.size ?? 0) +
      (this.listeners.get(workspaceId)?.size ?? 0)
    );
  }

  /** Every workspace with at least one watcher, for the sampling domains. */
  watchedWorkspaces(): string[] {
    return [
      ...new Set([...this.subscriptions.keys(), ...this.listeners.keys()]),
    ];
  }

  private enqueue(subscription: Subscription, frame: string, seq = 0): void {
    if (subscription.closed) return;
    // 续订客户端在每一帧之后收到它的序号。两条消息而不是一个字段，因为帧的
    // 形状是契约；控制帧排在业务帧之后，所以客户端记下的游标永远指向一条它
    // 已经收下的帧。
    //
    // A client that falls behind loses the oldest frames, never its
    // connection: the Rust receiver resumed at the oldest frame still in its
    // ring, and dropping from the front of the queue is the same thing said
    // from the other end.
    subscription.queue.push(frame);
    if (subscription.cursored && seq > 0) {
      subscription.queue.push(cursorFrame(seq, 0, seq));
    }
  }

  /**
   * Attaches one already-upgraded socket to a workspace.
   *
   * The `ws` send callback is the drain signal, which is why the socket is
   * wrapped here rather than in the HTTP layer: separating the two would leave
   * a queue whose drain condition lived somewhere else.
   *
   * Returns the release function; the caller wires it to `close`.
   */
  attachSocket(
    workspaceId: string,
    socket: WebSocket,
    options: { readonly cursor?: number | "now" } = {},
  ): () => void {
    const cursored = options.cursor !== undefined;
    if (options.cursor === "now") this.seed(socket);
    else if (cursored)
      this.replay(workspaceId, socket, options.cursor as number);
    // A failed write is a socket on its way out; `close` will arrive and
    // release the subscription. The queue settles the frame either way, so it
    // does not wedge in the meantime.
    return this.subscribe(workspaceId, wsTarget(socket), { cursored });
  }

  /**
   * 只报一次当前水位，不补发任何历史（`?cursor=now`）。
   *
   * 给还没有位置的客户端用：它要的是「从现在起别漏」。补发历史是另一个问题的
   * 答案，而那个问题只有已经看过一段的客户端才问得出来。
   */
  private seed(socket: WebSocket): void {
    const database = this.database;
    if (database === undefined) return;
    const bounds = watermark(database);
    socket.send(cursorFrame(bounds.watermark, bounds.floor, bounds.watermark));
  }

  /**
   * 把 `cursor` 之后那一段直接写进 socket，然后交给实时扇出。
   *
   * 整段是同步的，中间发不出一次 `publish`——单线程里「读一页、写出去、挂上
   * 订阅」之间没有别的代码能跑，所以补发和推送之间不会有缝，也不会重。
   *
   * 补发的帧不走那条有界队列：队列的上限是为了挡住「跟不上的客户端」，而一次
   * 续订正是要把历史完整地交出去，中途丢帧等于没补。
   */
  private replay(workspaceId: string, socket: WebSocket, cursor: number): void {
    const database = this.database;
    if (database === undefined) return;
    let position = cursor;
    for (let pass = 0; pass < MAX_REPLAY_PASSES; pass += 1) {
      const page = catchUp(database, workspaceId, position);
      if (page.status !== "ok") return;
      for (const record of page.records) {
        socket.send(record.frame);
        socket.send(cursorFrame(record.seq, page.floor, page.watermark));
      }
      position = page.nextCursor;
      if (!page.hasMore) break;
    }
    const bounds = watermark(database);
    socket.send(cursorFrame(position, bounds.floor, bounds.watermark));
  }

  /** Diagnostics: how many frames each connection has lost to the bound. */
  droppedFrames(workspaceId: string): number[] {
    return [...(this.subscriptions.get(workspaceId) ?? [])].map(
      (subscription) => subscription.queue.dropped,
    );
  }
}
