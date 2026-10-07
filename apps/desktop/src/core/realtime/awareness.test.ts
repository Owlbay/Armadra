import * as decoding from "lib0/decoding";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  AWARENESS_LIMITS,
  normalizeAwarenessState,
  sanitizeAwarenessUpdate,
} from "./awareness";

function decode(update: Uint8Array): { clientId: number; state: unknown }[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const out: { clientId: number; state: unknown }[] = [];
  for (let i = 0; i < count; i += 1) {
    const clientId = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    out.push({
      clientId,
      state: JSON.parse(decoding.readVarString(decoder)) as unknown,
    });
  }
  return out;
}

describe("awareness 形状（契约 §16.4）", () => {
  it("上限与共享层一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const shared = readFileSync(
      resolve(here, "../../../../../packages/shared/src/api/realtime.ts"),
      "utf8",
    );
    expect(shared).toContain(`idLength: ${AWARENESS_LIMITS.idLength},`);
    expect(shared).toContain(`nameLength: ${AWARENESS_LIMITS.nameLength},`);
    expect(shared).toContain(`colors: ${AWARENESS_LIMITS.colors},`);
    expect(shared).toContain(`selection: ${AWARENESS_LIMITS.selection},`);
    expect(shared).toContain("stateBytes: 16 * 1024,");
    expect(shared).toContain(`minZoom: ${AWARENESS_LIMITS.minZoom},`);
    expect(shared).toContain(`maxZoom: ${AWARENESS_LIMITS.maxZoom},`);
  });

  it("只留认识的键，principalId 换成连接的", () => {
    expect(
      normalizeAwarenessState(
        {
          principalId: "spoofed",
          deviceId: "d",
          name: "n",
          color: 3,
          cursor: { x: 1, y: 2, z: 3 },
          selection: ["a"],
          focusNodeId: "a",
          viewport: { x: -5, y: 7.5, zoom: 1.25, width: 900 },
          avatar: "http://example.invalid",
        },
        "p1",
      ),
    ).toEqual({
      principalId: "p1",
      deviceId: "d",
      name: "n",
      color: 3,
      cursor: { x: 1, y: 2 },
      selection: ["a"],
      focusNodeId: "a",
      viewport: { x: -5, y: 7.5, zoom: 1.25 },
    });
  });

  it("认不出的状态返回 undefined", () => {
    const base = { deviceId: "d", name: "n", color: 1 };
    for (const bad of [
      null,
      [],
      "x",
      { ...base, deviceId: "" },
      { ...base, color: 9 },
      { ...base, color: 0.5 },
      { ...base, name: "x".repeat(81) },
      { ...base, cursor: { x: Infinity, y: 0 } },
      { ...base, selection: [""] },
      { ...base, selection: "a" },
      { ...base, focusNodeId: 3 },
      { ...base, viewport: { x: 0, y: 0 } },
      { ...base, viewport: { x: 0, y: Number.NaN, zoom: 1 } },
      { ...base, viewport: { x: 0, y: 0, zoom: 0 } },
      { ...base, viewport: { x: 0, y: 0, zoom: AWARENESS_LIMITS.maxZoom * 2 } },
      { ...base, viewport: "0,0,1" },
    ]) {
      expect(normalizeAwarenessState(bad, "")).toBeUndefined();
    }
  });

  it("过滤一条更新：坏状态丢掉、离开保留、别人的 clientID 丢掉", () => {
    const combined = encodeEntries([
      {
        clientId: 1,
        clock: 1,
        json: JSON.stringify({ deviceId: "a", name: "A", color: 2 }),
      },
      { clientId: 2, clock: 1, json: JSON.stringify({ name: "broken" }) },
      {
        clientId: 3,
        clock: 1,
        json: JSON.stringify({ deviceId: "c", name: "C", color: 4 }),
      },
      { clientId: 4, clock: 2, json: "null" },
    ]);
    const out = sanitizeAwarenessUpdate(combined, "p", (id) => id === 3);
    expect(out).toBeDefined();
    expect(decode(out!)).toEqual([
      {
        clientId: 1,
        state: { principalId: "p", deviceId: "a", name: "A", color: 2 },
      },
      { clientId: 4, state: null },
    ]);
  });

  it("y-protocols 编出来的更新能原样过", () => {
    const peer = new Awareness(new Y.Doc());
    peer.setLocalState({ deviceId: "a", name: "A", color: 2 });
    const out = sanitizeAwarenessUpdate(
      encodeAwarenessUpdate(peer, [peer.clientID]),
      "",
    );
    expect(decode(out!)).toEqual([
      {
        clientId: peer.clientID,
        state: { principalId: "", deviceId: "a", name: "A", color: 2 },
      },
    ]);
  });

  it("一条都不剩时返回 undefined，截断的帧抛错", () => {
    const only = encodeEntries([
      { clientId: 7, clock: 1, json: JSON.stringify({ name: "x" }) },
    ]);
    expect(sanitizeAwarenessUpdate(only, "")).toBeUndefined();
    expect(() => sanitizeAwarenessUpdate(only.slice(0, 3), "")).toThrow();
  });

  it("超出字节上限的状态丢掉", () => {
    const big = encodeEntries([
      {
        clientId: 7,
        clock: 1,
        json: JSON.stringify({
          deviceId: "d",
          name: "n",
          color: 1,
          pad: "x".repeat(AWARENESS_LIMITS.stateBytes),
        }),
      },
    ]);
    expect(sanitizeAwarenessUpdate(big, "")).toBeUndefined();
  });
});

function encodeEntries(
  entries: { clientId: number; clock: number; json: string }[],
): Uint8Array {
  // 与 y-protocols 同一编码，手写以便塞进任意 JSON。
  const bytes: number[] = [];
  const varUint = (value: number) => {
    let n = value;
    while (n > 0x7f) {
      bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  };
  varUint(entries.length);
  for (const entry of entries) {
    varUint(entry.clientId);
    varUint(entry.clock);
    const text = new TextEncoder().encode(entry.json);
    varUint(text.length);
    bytes.push(...text);
  }
  return new Uint8Array(bytes);
}
