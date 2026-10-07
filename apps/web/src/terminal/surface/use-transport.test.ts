import { describe, expect, it } from "vitest";

import { helloNeedsResize } from "./use-transport";

describe("helloNeedsResize", () => {
  it("does not resize when the local container already matches the hello", () => {
    expect(
      helloNeedsResize({ cols: 120, rows: 40 }, { cols: 120, rows: 40 }),
    ).toBe(false);
  });

  it("resizes when either dimension differs", () => {
    expect(
      helloNeedsResize({ cols: 120, rows: 40 }, { cols: 40, rows: 40 }),
    ).toBe(true);
    expect(
      helloNeedsResize({ cols: 120, rows: 40 }, { cols: 120, rows: 12 }),
    ).toBe(true);
  });
});
