import { describe, expect, it } from "vitest";

import {
  AWARENESS_LIMITS,
  awarenessStateSchema,
  boardRealtimeStateSchema,
} from "../src/index.js";

describe("realtime shapes (contract §16.2, §16.4)", () => {
  it("parses the board realtime state", () => {
    expect(
      boardRealtimeStateSchema.parse({
        realtime: true,
        materializedSeq: 3,
        enabled: true,
      }),
    ).toEqual({ realtime: true, materializedSeq: 3, enabled: true });
  });

  it("accepts a full awareness state and drops unknown keys", () => {
    const state = awarenessStateSchema.parse({
      principalId: "",
      deviceId: "client-1",
      name: "macOS · Chrome",
      color: 2,
      cursor: { x: 10.5, y: -4 },
      selection: ["a", "wb:b"],
      focusNodeId: "a",
      viewport: { x: 1, y: 2, zoom: 0.5 },
      extra: true,
    });
    expect(state).toEqual({
      principalId: "",
      deviceId: "client-1",
      name: "macOS · Chrome",
      color: 2,
      cursor: { x: 10.5, y: -4 },
      selection: ["a", "wb:b"],
      focusNodeId: "a",
      viewport: { x: 1, y: 2, zoom: 0.5 },
    });
  });

  it("rejects states outside the limits", () => {
    const base = { principalId: "p", deviceId: "d", name: "n", color: 1 };
    expect(awarenessStateSchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, color: 0 },
      { ...base, color: AWARENESS_LIMITS.colors + 1 },
      { ...base, color: 1.5 },
      { ...base, deviceId: "" },
      { ...base, name: "x".repeat(AWARENESS_LIMITS.nameLength + 1) },
      { ...base, cursor: { x: Number.NaN, y: 0 } },
      { ...base, cursor: { x: 1 } },
      {
        ...base,
        selection: Array.from(
          { length: AWARENESS_LIMITS.selection + 1 },
          (_, i) => `n${i}`,
        ),
      },
      { ...base, focusNodeId: "" },
      { ...base, viewport: { x: 0, y: 0 } },
      { ...base, viewport: { x: 0, y: 0, zoom: 0 } },
      { ...base, viewport: { x: 0, y: Infinity, zoom: 1 } },
      { ...base, viewport: { x: 0, y: 0, zoom: AWARENESS_LIMITS.maxZoom + 1 } },
      { name: "n", color: 1 },
    ]) {
      expect(awarenessStateSchema.safeParse(bad).success).toBe(false);
    }
  });
});
