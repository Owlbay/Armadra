import { describe, expect, it, vi } from "vitest";

vi.mock("@/store/canvas-store", () => ({
  useCanvasStore: { getState: () => ({}) },
}));

import { linkTarget } from "./open-link";

describe("linkTarget", () => {
  it("opens workspace files in the editor and web pages as pages", () => {
    expect(linkTarget("file:///repo/src/a%20b.ts", "/repo")).toEqual({
      kind: "file",
      path: "src/a b.ts",
    });
    expect(linkTarget("file:///C:/repo/a.ts", "C:/repo")).toEqual({
      kind: "file",
      path: "a.ts",
    });
    expect(linkTarget("https://example.com/x", "/repo")).toEqual({
      kind: "web",
      url: "https://example.com/x",
    });
  });

  it("has nothing to open outside the workspace or for other schemes", () => {
    expect(linkTarget("file:///etc/hosts", "/repo")).toBeNull();
    expect(linkTarget("file:///repo/a.ts", undefined)).toBeNull();
    expect(linkTarget("mailto:a@example.com", "/repo")).toBeNull();
    expect(linkTarget("not a url", "/repo")).toBeNull();
  });
});
