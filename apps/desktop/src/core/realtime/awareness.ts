/**
 * awareness 帧的形状检查与身份改写（契约 §16.4）。
 *
 * awareness 是客户端说「我是谁、光标在哪、选了什么」。core 不信它说的身份：
 * 每条状态的 `principalId` 一律改写成这条连接背后的 principal（本机壳的
 * owner 是 `""`），所以一个成员没法冒充别人出现在在线表里。形状不对的状态
 * 整条丢掉（不转给别人），其余照常应用——一个坏字段不该让整条连接断掉。
 *
 * 上限与页面的 zod（`packages/shared/src/api/realtime.ts`
 * `awarenessStateSchema` / `AWARENESS_LIMITS`）一致；core 不依赖共享包，
 * 所以这里手写同一套检查。
 *
 * awareness 更新的编码（`y-protocols/awareness`）：varUint 条数，然后每条
 * varUint clientID、varUint clock、varString 状态 JSON（`null` 表示离开）。
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export const AWARENESS_LIMITS = {
  idLength: 128,
  nameLength: 80,
  colors: 8,
  selection: 256,
  stateBytes: 16 * 1024,
  minZoom: 0.01,
  maxZoom: 100,
} as const;

/** 一份 awareness 状态（契约 §16.4）。 */
export interface AwarenessState {
  principalId: string;
  deviceId: string;
  name: string;
  color: number;
  cursor?: { x: number; y: number };
  selection?: string[];
  focusNodeId?: string;
  /** 视口中心的画布坐标与缩放。 */
  viewport?: { x: number; y: number; zoom: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AWARENESS_LIMITS.idLength
  );
}

/**
 * 认得出就返回规范化后的状态（只留认识的键，`principalId` 换成连接的），
 * 认不出返回 `undefined`。
 */
export function normalizeAwarenessState(
  value: unknown,
  principalId: string,
): AwarenessState | undefined {
  if (!isRecord(value)) return undefined;
  const { deviceId, name, color, cursor, selection, focusNodeId, viewport } =
    value;
  if (!isId(deviceId)) return undefined;
  if (typeof name !== "string" || name.length > AWARENESS_LIMITS.nameLength) {
    return undefined;
  }
  if (
    typeof color !== "number" ||
    !Number.isInteger(color) ||
    color < 1 ||
    color > AWARENESS_LIMITS.colors
  ) {
    return undefined;
  }
  const state: AwarenessState = { principalId, deviceId, name, color };
  if (cursor !== undefined) {
    if (
      !isRecord(cursor) ||
      typeof cursor.x !== "number" ||
      typeof cursor.y !== "number" ||
      !Number.isFinite(cursor.x) ||
      !Number.isFinite(cursor.y)
    ) {
      return undefined;
    }
    state.cursor = { x: cursor.x, y: cursor.y };
  }
  if (selection !== undefined) {
    if (
      !Array.isArray(selection) ||
      selection.length > AWARENESS_LIMITS.selection ||
      !selection.every(isId)
    ) {
      return undefined;
    }
    state.selection = [...selection];
  }
  if (focusNodeId !== undefined) {
    if (!isId(focusNodeId)) return undefined;
    state.focusNodeId = focusNodeId;
  }
  if (viewport !== undefined) {
    if (
      !isRecord(viewport) ||
      typeof viewport.x !== "number" ||
      typeof viewport.y !== "number" ||
      typeof viewport.zoom !== "number" ||
      !Number.isFinite(viewport.x) ||
      !Number.isFinite(viewport.y) ||
      !Number.isFinite(viewport.zoom) ||
      viewport.zoom < AWARENESS_LIMITS.minZoom ||
      viewport.zoom > AWARENESS_LIMITS.maxZoom
    ) {
      return undefined;
    }
    state.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
  }
  return state;
}

/**
 * 过滤并改写一条 awareness 更新。返回要应用的更新；一条都不剩时返回
 * `undefined`。`foreign` 回答「这个 clientID 是不是别的连接的」，是就丢掉，
 * 免得一条连接拿更大的 clock 盖掉别人的光标。解不开（截断、不是 JSON）抛错，调用方按坏帧处理。
 */
export function sanitizeAwarenessUpdate(
  update: Uint8Array,
  principalId: string,
  foreign: (clientId: number) => boolean = () => false,
): Uint8Array | undefined {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const kept: { clientId: number; clock: number; json: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const raw = decoding.readVarString(decoder);
    const parsed = JSON.parse(raw) as unknown;
    // 别的连接登记过的 clientID 不归它管：既不能改写也不能替人「离开」。
    if (foreign(clientId)) continue;
    if (parsed === null) {
      kept.push({ clientId, clock, json: "null" });
      continue;
    }
    if (raw.length > AWARENESS_LIMITS.stateBytes) continue;
    const state = normalizeAwarenessState(parsed, principalId);
    if (state === undefined) continue;
    kept.push({ clientId, clock, json: JSON.stringify(state) });
  }
  if (kept.length === 0) return undefined;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, kept.length);
  for (const entry of kept) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.json);
  }
  return encoding.toUint8Array(encoder);
}
