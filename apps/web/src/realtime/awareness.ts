import type { Awareness } from "y-protocols/awareness";
import {
  AWARENESS_LIMITS,
  awarenessStateSchema,
  type AwarenessState,
} from "@armadra/shared";

/**
 * awareness 在页面这一侧（补全架构 §6.2，契约 §16.4）：自己的那份怎么写，
 * 别人的那份怎么读。
 *
 *   * 自己：`deviceId` = 页面的 `clientId`，`name` = 设备名，`color` = 在场者
 *     没用过的最小成员色（从 2 起；1 留给「自己」，设计系统 §2.5）。光标按
 *     画布坐标、节流后写；选区与正在看的节点随 store 写。
 *   * 别人：逐条过 `awarenessStateSchema`，认不出的不进在线表、不画光标。
 */

/** 一个在场的人（不含自己）。 */
export interface Peer {
  /** awareness 的 clientID：同一个人的两个窗口是两个 Peer。 */
  readonly clientId: number;
  readonly state: AwarenessState;
}

/** 光标写入的最小间隔。 */
export const CURSOR_THROTTLE_MS = 50;

/** 别人的状态：校验过的、按 clientID 排好的。 */
export function peersOf(awareness: Awareness, self: number): Peer[] {
  const peers: Peer[] = [];
  awareness.getStates().forEach((value, clientId) => {
    if (clientId === self) return;
    const parsed = awarenessStateSchema.safeParse(value);
    if (parsed.success) peers.push({ clientId, state: parsed.data });
  });
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/**
 * 加入时取的颜色：在场的人没用过的最小一个（2..8）；八色都用了就按
 * clientID 回绕。要在第一次同步之后再取（那时 core 已经把在场者发过来了），
 * 颜色才是「按加入顺序」。两个人同时加入撞了色时 clientID 大的那个换一个
 * （`colorClash`）——两边看到的结果一致，不用协商。
 */
export function pickColor(peers: readonly Peer[], self: number): number {
  const taken = new Set(peers.map((peer) => peer.state.color));
  for (let color = 2; color <= AWARENESS_LIMITS.colors; color += 1) {
    if (!taken.has(color)) return color;
  }
  return 2 + (self % (AWARENESS_LIMITS.colors - 1));
}

/** 自己的颜色是否和一个 clientID 更小的人撞了（撞了就重挑）。 */
export function colorClash(
  peers: readonly Peer[],
  self: number,
  color: number,
): boolean {
  return peers.some(
    (peer) => peer.clientId < self && peer.state.color === color,
  );
}

export interface LocalPresence {
  setCursor(cursor: { x: number; y: number } | null): void;
  setSelection(selection: readonly string[]): void;
  setFocus(nodeId: string | null): void;
  destroy(): void;
}

export interface LocalPresenceOptions {
  deviceId: string;
  name: string;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function clip(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value;
}

/** 写自己的那份 awareness。 */
export function startLocalPresence(
  awareness: Awareness,
  options: LocalPresenceOptions,
): LocalPresence {
  const self = awareness.clientID;
  const setTimer =
    options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  const base: AwarenessState = {
    principalId: "",
    deviceId: clip(options.deviceId, AWARENESS_LIMITS.idLength),
    name: clip(options.name, AWARENESS_LIMITS.nameLength),
    color: pickColor(peersOf(awareness, self), self),
  };
  awareness.setLocalState(base);

  const update = (patch: Partial<AwarenessState>) => {
    const current = awareness.getLocalState() as AwarenessState | null;
    if (!current) return;
    const next: Record<string, unknown> = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
    }
    awareness.setLocalState(next);
  };

  const onChange = () => {
    const current = awareness.getLocalState() as AwarenessState | null;
    if (!current) return;
    const peers = peersOf(awareness, self);
    if (colorClash(peers, self, current.color)) {
      update({ color: pickColor(peers, self) });
    }
  };
  awareness.on("change", onChange);

  let lastCursorAt = -Infinity;
  let queued: { x: number; y: number } | null | undefined;
  let timer: unknown = null;
  const writeCursor = (cursor: { x: number; y: number } | null) => {
    lastCursorAt = now();
    update({ cursor: cursor ?? undefined });
  };

  return {
    setCursor: (cursor) => {
      const wait = CURSOR_THROTTLE_MS - (now() - lastCursorAt);
      // 离开画布马上写，别人那里光标立刻开始淡出。
      if (cursor === null || wait <= 0) {
        if (timer !== null) clearTimer(timer);
        timer = null;
        queued = undefined;
        writeCursor(cursor);
        return;
      }
      queued = cursor;
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        if (queued !== undefined) writeCursor(queued);
        queued = undefined;
      }, wait);
    },
    setSelection: (selection) => {
      const ids = selection
        .filter((id) => id.length > 0 && id.length <= AWARENESS_LIMITS.idLength)
        .slice(0, AWARENESS_LIMITS.selection);
      update({ selection: ids.length > 0 ? ids : undefined });
    },
    setFocus: (nodeId) => {
      update({ focusNodeId: nodeId ?? undefined });
    },
    destroy: () => {
      if (timer !== null) clearTimer(timer);
      timer = null;
      awareness.off("change", onChange);
    },
  };
}
