import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock("@/platform", () => ({ isDesktop: () => platform.desktop }));

import {
  MONOSPACE_CANDIDATES,
  detectMonospaceFonts,
  filterMonospace,
  type FontProbe,
} from "./fonts";

/**
 * 假的一台机器：`installed` 里的字体真的装了，`monospace` 里的那几款等宽。
 * 没装的字体按 CSS 规则落到兜底族上——`monospace` 等宽、`serif` 不等宽，
 * 两者宽度不同。
 */
function machine(
  installed: readonly string[],
  monospace: readonly string[],
  check: (font: string) => boolean = () => true,
): FontProbe {
  const resolve = (font: string) => {
    const first = /'((?:[^'\\]|\\.)*)'/.exec(font)?.[1] ?? "";
    if (installed.includes(first)) return first;
    return font.endsWith("serif") ? "serif" : "monospace";
  };
  return {
    check,
    measure: (text, font) => {
      const family = resolve(font);
      const fixed = family === "monospace" || monospace.includes(family);
      if (fixed) return text.length * 10;
      // 比例字体：窄字母窄、宽字母宽。
      return [...text].reduce(
        (sum, char) =>
          sum + (/[il1]/.test(char) ? 4 : /[MW]/.test(char) ? 14 : 9),
        0,
      );
    },
  };
}

afterEach(() => {
  platform.desktop = false;
  vi.unstubAllGlobals();
});

describe("等宽字体探测", () => {
  it("只留下装了而且等宽的", () => {
    const probe = machine(
      ["Menlo", "JetBrains Mono", "Helvetica"],
      ["Menlo", "JetBrains Mono"],
    );
    expect(
      filterMonospace(["Menlo", "Helvetica", "JetBrains Mono", "Hack"], probe),
    ).toEqual(["Menlo", "JetBrains Mono"]);
  });

  it("恰好就是系统等宽回退的那一款也认得出来", () => {
    // Menlo 装着，又正好是 `monospace` 的落点：只和 monospace 比会把它当成没装。
    const probe = machine(["Menlo"], ["Menlo"]);
    expect(filterMonospace(["Menlo"], probe)).toEqual(["Menlo"]);
  });

  it("document.fonts.check 否认的直接跳过", () => {
    const probe = machine(["Menlo"], ["Menlo"], () => false);
    expect(filterMonospace(["Menlo"], probe)).toEqual([]);
  });

  it("去重、忽略空名", () => {
    const probe = machine(["Menlo"], ["Menlo"]);
    expect(filterMonospace(["Menlo", " menlo ", ""], probe)).toEqual(["Menlo"]);
  });

  it("浏览器里不调 queryLocalFonts；缺席时也不抛", async () => {
    const probe = machine(["Menlo"], ["Menlo"]);
    const query = vi.fn();
    vi.stubGlobal("queryLocalFonts", query);
    expect(await detectMonospaceFonts(probe)).toEqual(["Menlo"]);
    expect(query).not.toHaveBeenCalled();

    platform.desktop = true;
    vi.stubGlobal("queryLocalFonts", undefined);
    expect(await detectMonospaceFonts(probe)).toEqual(["Menlo"]);
  });

  it("桌面壳里并入系统字体表的族名，同样过等宽比对", async () => {
    platform.desktop = true;
    vi.stubGlobal(
      "queryLocalFonts",
      vi.fn(async () => [
        { family: "Berkeley Mono", fullName: "Berkeley Mono Regular" },
        { family: "Avenir", fullName: "Avenir Book" },
      ]),
    );
    const probe = machine(
      ["Menlo", "Berkeley Mono", "Avenir"],
      ["Menlo", "Berkeley Mono"],
    );
    expect(await detectMonospaceFonts(probe)).toEqual([
      "Berkeley Mono",
      "Menlo",
    ]);
  });

  it("系统字体表拒绝授权时只用候选名单", async () => {
    platform.desktop = true;
    vi.stubGlobal(
      "queryLocalFonts",
      vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    );
    const probe = machine(["Consolas"], ["Consolas"]);
    expect(await detectMonospaceFonts(probe)).toEqual(["Consolas"]);
  });

  it("没有探测能力（jsdom 无 canvas）时是空表", async () => {
    expect(await detectMonospaceFonts(null)).toEqual([]);
    expect(MONOSPACE_CANDIDATES).toContain("JetBrains Mono");
  });
});
