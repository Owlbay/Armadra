import type { Viewport } from "@armadra/shared";

import { readStored, writeStored } from "@/app/preferences/storage";
import type { Peer, PresenceViewport } from "./awareness";

/**
 * 实时板的视口（补全架构 §6.2，契约 §16.4）。
 *
 *   * **本机**：实时板的视口不进文档、也不 PUT，所以每块板记在本机
 *     `localStorage`（按 `boardId`），刷新后回到自己上次停的地方。存的是
 *     React Flow 语义的 `{x, y, zoom}`，与 `board.viewport` 同一种值。
 *   * **awareness**：报的是视口**中心**的画布坐标 + 缩放。窗口大小不同的两个
 *     人跟随时看到的是同一块地方的中心。
 */

const KEY_PREFIX = "armadra.realtimeViewport.";

export function viewportStorageKey(boardId: string): string {
  return `${KEY_PREFIX}${boardId}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 本机记着的这块板的视口；没有或坏了是 `null`。 */
export function loadBoardViewport(boardId: string): Viewport | null {
  const raw = readStored(viewportStorageKey(boardId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object") return null;
    const { x, y, zoom } = value;
    if (!finite(x) || !finite(y) || !finite(zoom) || zoom <= 0) return null;
    return { x, y, zoom };
  } catch {
    return null;
  }
}

export function saveBoardViewport(boardId: string, viewport: Viewport): void {
  if (!finite(viewport.x) || !finite(viewport.y) || !finite(viewport.zoom)) {
    return;
  }
  writeStored(
    viewportStorageKey(boardId),
    JSON.stringify({ x: viewport.x, y: viewport.y, zoom: viewport.zoom }),
  );
}

export interface Size {
  width: number;
  height: number;
}

/** React Flow 的视口 + 容器大小 → 中心的画布坐标与缩放。 */
export function viewportCenter(
  viewport: Viewport,
  size: Size,
): PresenceViewport | null {
  if (viewport.zoom <= 0 || size.width <= 0 || size.height <= 0) return null;
  return {
    x: (size.width / 2 - viewport.x) / viewport.zoom,
    y: (size.height / 2 - viewport.y) / viewport.zoom,
    zoom: viewport.zoom,
  };
}

/** 跟随谁：对方报了视口就跟视口，没报就退回跟光标，都没有就不动。 */
export type FollowTarget =
  | { kind: "viewport"; x: number; y: number; zoom: number }
  | { kind: "cursor"; x: number; y: number };

export function followTarget(peer: Peer | undefined): FollowTarget | null {
  if (!peer) return null;
  const { viewport, cursor } = peer.state;
  if (viewport) return { kind: "viewport", ...viewport };
  if (cursor) return { kind: "cursor", x: cursor.x, y: cursor.y };
  return null;
}
