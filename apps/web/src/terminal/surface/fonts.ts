import * as React from "react";

import { isDesktop } from "@/platform";

/**
 * 本机装了哪些等宽字体（界面第二波 §2.4）。
 *
 * 不内置字体文件（`tokens.test.ts` 禁 `@font-face`），只在常见的等宽字体里
 * 挑出这台机器上真的有、而且真的等宽的那些，给终端外观页的字体 `Select`。
 */
export const MONOSPACE_CANDIDATES: readonly string[] = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Source Code Pro",
  "Hack",
  "IBM Plex Mono",
  "Iosevka",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Noto Sans Mono",
  "Sarasa Mono SC",
  "Maple Mono",
  "MesloLGS NF",
  "Courier New",
];

/** 探测用到的两样浏览器能力；测试直接造。 */
export interface FontProbe {
  /** `document.fonts.check`。 */
  check(font: string): boolean;
  /** 用 `font` 画 `text` 的宽度（canvas `measureText`）。 */
  measure(text: string, font: string): number;
}

const SIZE = "48px";
const NARROW = "iiii";
const WIDE = "MMMM";
/** 宽窄字母混排：两种回退字体画出来几乎不可能一样宽。 */
const SAMPLE = "mmmmmmmmmmlli10OQW";

const quoted = (name: string) => `'${name.replace(/'/g, "\\'")}'`;

/**
 * 一个名字算「装了而且等宽」：
 *
 * - `document.fonts.check` 不否认它；
 * - 分别以 `monospace` 与 `serif` 兜底画同一串，宽度相同——真装了，两次画的
 *   都是它自己；没装时落到两种不同的回退字体上，宽度不同。只和 `monospace`
 *   一种回退比会把恰好就是系统等宽回退的那一款（如 Menlo）误判成没装；
 * - `iiii` 与 `MMMM` 一样宽。
 */
export function isInstalledMonospace(name: string, probe: FontProbe): boolean {
  const family = quoted(name);
  if (!probe.check(`12px ${family}`)) return false;
  const withMono = `${SIZE} ${family}, monospace`;
  const withSerif = `${SIZE} ${family}, serif`;
  if (probe.measure(SAMPLE, withMono) !== probe.measure(SAMPLE, withSerif))
    return false;
  return probe.measure(NARROW, withSerif) === probe.measure(WIDE, withSerif);
}

/** 候选名单过一遍探测，去重、保序。 */
export function filterMonospace(
  names: readonly string[],
  probe: FontProbe,
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    if (isInstalledMonospace(name, probe)) found.push(name);
  }
  return found;
}

function browserProbe(): FontProbe | null {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context || !document.fonts) return null;
  return {
    check: (font) => {
      try {
        return document.fonts.check(font);
      } catch {
        return false;
      }
    },
    measure: (text, font) => {
      context.font = font;
      return context.measureText(text).width;
    },
  };
}

interface LocalFontData {
  family: string;
}

type QueryLocalFonts = () => Promise<readonly LocalFontData[]>;

/**
 * 桌面壳里多问一句系统字体表（`queryLocalFonts`）。浏览器里不调：它要手势
 * 授权，设置页一打开就弹一个权限框比列少几款字体更糟。取的是 `family`——
 * 写进 `font-family` 的是族名，`fullName`（「… Regular」）在那里不认。
 */
async function localFamilies(): Promise<string[]> {
  if (!isDesktop()) return [];
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts })
    .queryLocalFonts;
  if (typeof query !== "function") return [];
  try {
    const fonts = await query.call(globalThis);
    return fonts.map((font) => font.family);
  } catch {
    return [];
  }
}

/** 探测本机等宽字体；结果按名字排好，缺能力时是空表，从不抛。 */
export async function detectMonospaceFonts(
  probe: FontProbe | null = browserProbe(),
  extra: () => Promise<readonly string[]> = localFamilies,
): Promise<string[]> {
  if (!probe) return [];
  let names: readonly string[] = MONOSPACE_CANDIDATES;
  try {
    names = [...names, ...(await extra())];
  } catch {
    /* 系统字体表拿不到就只用候选名单。 */
  }
  return filterMonospace(names, probe).sort((left, right) =>
    left.localeCompare(right),
  );
}

let cached: Promise<string[]> | null = null;

/** 一次加载只探测一次：字体不会在设置页开着时装上。 */
export function monospaceFonts(): Promise<string[]> {
  cached ??= detectMonospaceFonts();
  return cached;
}

/** 测试用：丢掉缓存。 */
export function resetMonospaceFontsCache(): void {
  cached = null;
}

/** 探测结果；`null` = 还在探测。 */
export function useMonospaceFonts(): string[] | null {
  const [fonts, setFonts] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    let alive = true;
    void monospaceFonts().then((found) => {
      if (alive) setFonts(found);
    });
    return () => {
      alive = false;
    };
  }, []);
  return fonts;
}
