import type { DatabaseSync } from "node:sqlite";

import {
  type WorkspaceEventsItem,
  workspaceEventSchema,
} from "@armadra/shared";

import { fail } from "../http/errors";
import { withEventId } from "../http/rpc";
import {
  type RequestIdentity,
  accessGate,
  onAccessChanged,
} from "../identity/gate";
import { scope } from "../identity/scopes";
import { ITERATOR_MAX_FRAMES } from "../http/ws-control";
import { catchUp, watermark } from "./outbox";
import type { WorkspaceEventStream } from "./stream";
import { workspaceExists } from "./workspaces";

/**
 * `workspaces.events`：控制面上的工作空间事件流（契约 §35.4）。
 *
 * 与旧路由 `WS /api/workspaces/{id}/events`（留到 E4）同一份扇出与 outbox，区别
 * 只在帧怎么走：每一项是一个工作空间事件，事件 `id` 就是 outbox 序号；断线重订
 * 时上游把客户端最后收到的那个 `id` 交回来（`lastEventId`），这里先补发再接实时，
 * 与 `?cursor=` 同一个读法。
 *
 *   * 起点：`lastEventId` 优先，其次入参 `cursor`，都没有就是 `now`（不补历史）。
 *   * 每次（重新）订上、补发完之后发一帧位置帧 `{ type: "cursor", … }`，`id` 是
 *     这时的位置——还没收到任何事件就断了的订阅也有一个可续的 `lastEventId`，
 *     页面拿它当「订上了」的上升沿。
 *   * 补发与实时之间没有缝：监听在读水位的同一拍挂上，补发只发到那时的水位，
 *     之后的都在监听收到的那一段里。补发按页懒读，读多少由客户端拉的速度定。
 *   * 位置掉出保留下限答 `snapshot_required`，比水位还新答 `cursor_ahead`：在
 *     订阅开始之前就判，拒绝是这次调用的错误，不是一条开了又断的订阅。
 *   * 授权变了（撤销共享、停用账号）就复核，不再能读这块画布的以 `forbidden`
 *     结束这一条订阅；连接上别的调用照旧。
 *   * 背压按 `resubscribe`（契约 §35.5）：门面拥塞时不来取，补发因此停在原处；
 *     实时的一段攒在有界缓冲里，满了就把已攒的发完、以 `overflow` 结束。
 *   * 解不开的帧（core 比契约新）不发：页面本来也会丢它，而出参校验会把一帧
 *     坏的变成整条订阅的错误。
 */

export interface EventsInput {
  readonly workspaceId: string;
  readonly cursor?: number | "now";
}

export interface EventsCall {
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
  readonly identity?: RequestIdentity;
}

type Item = WorkspaceEventsItem;

/** 一帧 → 事件对象；不是契约里的事件答 `undefined`。 */
function decode(frame: string): Item | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return undefined;
  }
  return workspaceEventSchema.safeParse(value).success
    ? (value as Item)
    : undefined;
}

/** `lastEventId` 只认十进制非负整数（与 `?cursor=` 同一个读法）。 */
function parseEventId(raw: string): number {
  if (!/^\d{1,19}$/.test(raw)) {
    throw fail("bad_request", "lastEventId 不是一个位置");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw fail("bad_request", "lastEventId 不是一个位置");
  }
  return value;
}

function stillAllowed(identity: RequestIdentity, workspaceId: string): boolean {
  const subject =
    identity.revalidate === undefined
      ? identity.subject
      : identity.revalidate();
  if (subject === undefined) return false;
  return accessGate().permits(subject, [scope("events:read", workspaceId)]);
}

/**
 * 判起点并交出订阅。先决条件（工作空间在不在、位置续不续得上）在这里判，所以
 * 拒绝是这次调用的错误。
 */
export function openWorkspaceEvents(
  stream: WorkspaceEventStream,
  database: DatabaseSync,
  input: EventsInput,
  call: EventsCall,
): AsyncGenerator<Item, void, void> {
  const { workspaceId } = input;
  if (!workspaceExists(database, workspaceId)) {
    throw fail("not_found", `没有这个工作空间：${workspaceId}`);
  }
  const start: number | "now" =
    call.lastEventId !== undefined && call.lastEventId !== ""
      ? parseEventId(call.lastEventId)
      : (input.cursor ?? "now");
  if (typeof start === "number") {
    const durable = stream.durable;
    if (durable === undefined) {
      throw fail("snapshot_required", "这台 core 没有 outbox，续不上");
    }
    const probe = catchUp(durable, workspaceId, start, 1);
    if (probe.status === "snapshotRequired") {
      throw fail("snapshot_required", "这个位置已经掉出保留下限");
    }
    if (probe.status === "cursorAhead") {
      throw fail("cursor_ahead", "这个位置比这台 core 的水位还新");
    }
  }
  return run(stream, workspaceId, start, call);
}

async function* run(
  stream: WorkspaceEventStream,
  workspaceId: string,
  start: number | "now",
  call: EventsCall,
): AsyncGenerator<Item, void, void> {
  const pending: { frame: string; seq: number }[] = [];
  let wake: (() => void) | undefined;
  const poke = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  let revoked = false;
  // 监听与读水位在同一拍：此后发布的都进 `pending`，之前的都在 outbox 里。
  let overflowed = false;
  const off = stream.listen(workspaceId, (frame, seq) => {
    // 门面拥塞时不来取（`resubscribe`）：实时这一段攒在这里，有界。满了不再
    // 攒，订阅以 `overflow` 结束，客户端带最后的 id 重订，缺口由 outbox 补。
    if (pending.length >= ITERATOR_MAX_FRAMES) {
      overflowed = true;
    } else {
      pending.push({ frame, seq });
    }
    poke();
  });
  const identity = call.identity;
  const offAccess =
    identity === undefined
      ? () => {}
      : onAccessChanged(() => {
          if (!stillAllowed(identity, workspaceId)) {
            revoked = true;
            poke();
          }
        });
  const signal = call.signal;
  signal?.addEventListener("abort", poke);
  const database = stream.durable;
  const bounds =
    database === undefined ? { floor: 0, watermark: 0 } : watermark(database);
  const ceiling = bounds.watermark;
  try {
    if (typeof start === "number" && database !== undefined) {
      let position = start;
      while (position < ceiling) {
        const page = catchUp(database, workspaceId, position);
        if (page.status === "snapshotRequired") {
          throw fail("snapshot_required", "补发途中这一段被裁掉了");
        }
        if (page.status !== "ok") break;
        for (const record of page.records) {
          if (record.seq > ceiling) break;
          const event = decode(record.frame);
          if (event !== undefined) {
            yield withEventId(event, String(record.seq));
          }
        }
        if (!page.hasMore) break;
        position = page.nextCursor;
      }
    }
    yield withEventId(
      {
        type: "cursor",
        cursor: ceiling,
        floor: bounds.floor,
        watermark: ceiling,
      },
      String(ceiling),
    );
    while (signal?.aborted !== true) {
      if (revoked) throw fail("forbidden", "没有这块工作空间的读授权了");
      const next = pending.shift();
      if (next === undefined && overflowed) {
        throw fail("overflow", "订阅跟不上，带 lastEventId 重订");
      }
      if (next === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const event = decode(next.frame);
      if (event === undefined) continue;
      yield next.seq > 0 ? withEventId(event, String(next.seq)) : event;
    }
  } finally {
    off();
    offAccess();
    signal?.removeEventListener("abort", poke);
  }
}
