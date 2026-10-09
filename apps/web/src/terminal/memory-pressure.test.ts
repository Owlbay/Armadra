import { afterEach, describe, expect, it } from "vitest";

import { installMemoryPressure } from "./memory-pressure";
import {
  currentMemoryPressure,
  onMemoryPressure,
  resetMemoryPressure,
} from "./pressure-bus";

let uninstall: () => void = () => {};

afterEach(() => {
  uninstall();
  resetMemoryPressure();
});

function fakeBridge() {
  const listeners = new Set<(event: { level: unknown }) => void>();
  return {
    bridge: {
      memory: {
        onPressure: (listener: (event: { level: unknown }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    push: (level: unknown) => listeners.forEach((each) => each({ level })),
    count: () => listeners.size,
  };
}

describe("installMemoryPressure", () => {
  it("把壳推来的档转进总线，坏值丢掉", () => {
    const shell = fakeBridge();
    uninstall = installMemoryPressure(shell.bridge);
    const seen: string[] = [];
    const off = onMemoryPressure((level) => seen.push(level));
    shell.push("bogus");
    shell.push("critical");
    expect(seen).toEqual(["critical"]);
    expect(currentMemoryPressure()).toBe("critical");
    off();
  });

  it("只装一次；卸载后退订", () => {
    const shell = fakeBridge();
    uninstall = installMemoryPressure(shell.bridge);
    expect(installMemoryPressure(shell.bridge)).toBe(uninstall);
    expect(shell.count()).toBe(1);
    uninstall();
    expect(shell.count()).toBe(0);
  });

  it("没有壳（浏览器里）也能装，诊断把手可注入假压力", () => {
    uninstall = installMemoryPressure(undefined);
    const hook = (
      window as unknown as {
        __armadraMemoryPressure: { emit: (level: string) => void };
      }
    ).__armadraMemoryPressure;
    hook.emit("warning");
    expect(currentMemoryPressure()).toBe("warning");
  });
});
