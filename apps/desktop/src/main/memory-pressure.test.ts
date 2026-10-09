import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PressureHysteresis,
  darwinPressure,
  linuxPressure,
  probeMemoryPressure,
  watchMemoryPressure,
  windowsPressure,
  type MemoryPressureLevel,
  type ProbeDeps,
} from "./memory-pressure";

describe("三平台解析", () => {
  it("macOS：1/2/4 → normal/warning/critical，别的未知", () => {
    expect(darwinPressure("1\n")).toBe("normal");
    expect(darwinPressure("2")).toBe("warning");
    expect(darwinPressure("4")).toBe("critical");
    expect(darwinPressure("3")).toBeNull();
    expect(darwinPressure("")).toBeNull();
  });

  it("Linux：PSI 的 some / full avg10", () => {
    const psi = (some: number, full: number) =>
      `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`;
    expect(linuxPressure(psi(0, 0))).toBe("normal");
    expect(linuxPressure(psi(9.99, 4.99))).toBe("normal");
    expect(linuxPressure(psi(10, 0))).toBe("warning");
    expect(linuxPressure(psi(10, 5))).toBe("critical");
    expect(linuxPressure("garbage")).toBeNull();
  });

  it("Windows：空闲占比", () => {
    expect(windowsPressure({ total: 100, free: 50 })).toBe("normal");
    expect(windowsPressure({ total: 100, free: 9 })).toBe("warning");
    expect(windowsPressure({ total: 100, free: 4 })).toBe("critical");
    expect(windowsPressure({})).toBeNull();
    expect(windowsPressure({ total: 0, free: 0 })).toBeNull();
  });

  it("按平台挑来源；探测失败是 null，不抛", async () => {
    const deps = (patch: Partial<ProbeDeps>): ProbeDeps => ({
      platform: "darwin",
      sysctl: async () => "2",
      readPsi: async () => "some avg10=50.0\nfull avg10=0\n",
      systemMemory: () => ({ total: 100, free: 1 }),
      ...patch,
    });
    expect(await probeMemoryPressure(deps({}))).toBe("warning");
    expect(await probeMemoryPressure(deps({ platform: "linux" }))).toBe(
      "warning",
    );
    expect(await probeMemoryPressure(deps({ platform: "win32" }))).toBe(
      "critical",
    );
    expect(await probeMemoryPressure(deps({ platform: "freebsd" }))).toBeNull();
    expect(
      await probeMemoryPressure(
        deps({
          sysctl: async () => {
            throw new Error("timeout");
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("迟滞", () => {
  it("升档立刻发，同档不重复发", () => {
    const h = new PressureHysteresis();
    expect(h.next("normal")).toBeNull();
    expect(h.next("warning")).toBe("warning");
    expect(h.next("warning")).toBeNull();
    expect(h.next("critical")).toBe("critical");
  });

  it("降档要连续两次低档，中间回到原档就重新数", () => {
    const h = new PressureHysteresis();
    h.next("critical");
    expect(h.next("normal")).toBeNull();
    expect(h.next("critical")).toBeNull();
    expect(h.next("normal")).toBeNull();
    expect(h.next("warning")).toBe("warning");
    expect(h.level).toBe("warning");
    expect(h.next("normal")).toBeNull();
    expect(h.next("normal")).toBe("normal");
  });

  it("没有读数不改变状态", () => {
    const h = new PressureHysteresis();
    h.next("warning");
    expect(h.next(null)).toBeNull();
    expect(h.next("normal")).toBeNull();
    expect(h.next(null)).toBeNull();
    expect(h.next("normal")).toBe("normal");
  });
});

describe("watchMemoryPressure", () => {
  afterEach(() => vi.useRealTimers());

  it("只在变化时发；上一轮没回来就跳过", async () => {
    vi.useFakeTimers();
    const readings: (MemoryPressureLevel | null)[] = [
      "normal",
      "warning",
      "warning",
      "normal",
      "normal",
    ];
    const sent: MemoryPressureLevel[] = [];
    let calls = 0;
    const watch = watchMemoryPressure({
      send: (level) => sent.push(level),
      probe: async () => readings[calls++] ?? null,
      intervalMs: 1_000,
    });
    await watch.tick();
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual(["warning", "normal"]);
    expect(watch.current()).toBe("normal");
    watch.stop();

    let release: (value: MemoryPressureLevel) => void = () => {};
    let started = 0;
    const slow = watchMemoryPressure({
      send: () => {},
      probe: () => {
        started += 1;
        return new Promise((resolve) => (release = resolve));
      },
      intervalMs: 1_000,
    });
    void slow.tick();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(started).toBe(1);
    release("critical");
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.current()).toBe("critical");
    slow.stop();
  });
});
