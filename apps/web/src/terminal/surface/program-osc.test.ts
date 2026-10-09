import { describe, expect, it } from "vitest";

import { isProgress, registerProgramOsc } from "./program-osc";

describe("程序状态序列在页面里只吞不答（契约 §53）", () => {
  it("swallows OSC 7501 and OSC 9;4, and leaves other OSC 9 to the next handler", () => {
    const handlers = new Map<number, (data: string) => boolean>();
    let disposed = 0;
    const off = registerProgramOsc({
      registerOscHandler: (ident, callback) => {
        handlers.set(ident, callback as (data: string) => boolean);
        return { dispose: () => (disposed += 1) };
      },
    });
    expect(handlers.get(7501)?.("state=working:progress=40")).toBe(true);
    expect(handlers.get(7501)?.("?")).toBe(true);
    expect(handlers.get(9)?.("4;1;40")).toBe(true);
    expect(handlers.get(9)?.("4")).toBe(true);
    expect(handlers.get(9)?.("Build finished")).toBe(false);
    expect(isProgress("40")).toBe(false);
    off.dispose();
    expect(disposed).toBe(2);
  });
});
