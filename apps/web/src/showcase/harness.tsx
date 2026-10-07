import type { ReactNode } from "react";

import { TestProviders } from "@/app/test-harness";
import {
  CONTRAST_THRESHOLD,
  composite,
  contrastOver,
  parseColor,
} from "@/lib/contrast";

/**
 * 展示页的 provider 与探针钩子（设计展示页 §2.2）。
 *
 * provider 与单测用的是同一组（`app/test-harness.tsx`）：query client 不重试、
 * React Flow 的 provider、Tooltip 的 provider。需要 store 的组件由各分区自己
 * 往 store 里放假数据。
 */
export function ShowcaseProviders({ children }: { children: ReactNode }) {
  return <TestProviders>{children}</TestProviders>;
}

/* -------------------------------------------------------------------------- */
/* 对比度实测                                                                   */
/* -------------------------------------------------------------------------- */

type Kind = "text" | "graphic";

/**
 * 一对颜色。`over` 给了时背景是「`over` 叠在 `bg` 上」之后的实色（衬底）；
 * `alpha` 给了时前景按这个不透明度画（焦点环按 50%）。
 */
export interface ContrastPair {
  fg: string;
  bg: string;
  kind: Kind;
  over?: string;
  alpha?: number;
}

const READING = ["--bg", "--panel", "--surface-card"];
const SURFACES = [
  "--bg",
  "--panel",
  "--surface-card",
  "--surface-raised",
  "--surface-overlay",
];
const AGENTS = ["claude", "codex", "opencode", "pi", "omp", "copilot", "ama"];
const STATUS: [string, string, string][] = [
  ["--danger", "--danger-text", "--danger-soft"],
  ["--warn", "--warn-text", "--warn-soft"],
  ["--success", "--success-text", "--success-soft"],
  ["--agent-working", "--working-text", "--agent-working-soft"],
];

/**
 * 设计系统 §2.1–§2.5 点名的每一对，与 `styles/tokens-contrast.test.ts` 同一张
 * 表。测试读源文本，这里读浏览器算出来的值——两边都过才说明 token 写对了、
 * 也真的生效了。
 */
export function contrastPairs(theme: "dark" | "light"): ContrastPair[] {
  const pairs: ContrastPair[] = [];
  for (const bg of [...READING, "--surface-overlay"]) {
    pairs.push({ fg: "--text", bg, kind: "text" });
    pairs.push({ fg: "--muted-foreground", bg, kind: "text" });
  }
  pairs.push({ fg: "--brand", bg: "--surface-card", kind: "graphic" });
  for (const bg of [...READING, "--surface-raised"]) {
    pairs.push({ fg: "--brand-text", bg, kind: "text" });
  }
  pairs.push({
    fg: "--brand-text",
    bg: "--surface-card",
    over: "--brand-soft",
    kind: "text",
  });
  pairs.push({ fg: "--on-accent", bg: "--brand-solid", kind: "text" });
  for (const bg of SURFACES) {
    pairs.push({ fg: "--focus-ring", bg, kind: "graphic", alpha: 0.5 });
  }
  for (const [graphic, text, soft] of STATUS) {
    pairs.push({ fg: graphic, bg: "--surface-card", kind: "graphic" });
    for (const bg of READING) pairs.push({ fg: text, bg, kind: "text" });
    // 深色 working 文字不叠在衬底上（设计系统 §2.3 表里没有这一对）。
    if (theme === "dark" && text === "--working-text") continue;
    pairs.push({ fg: text, bg: "--surface-card", over: soft, kind: "text" });
  }
  pairs.push({ fg: "--caution", bg: "--surface-card", kind: "text" });
  pairs.push({ fg: "--on-accent", bg: "--danger-solid", kind: "text" });
  for (const id of AGENTS) {
    pairs.push({ fg: `--agent-${id}`, bg: "--surface-card", kind: "graphic" });
    for (const bg of READING) {
      pairs.push({ fg: `--agent-${id}-text`, bg, kind: "text" });
    }
    pairs.push({ fg: "--on-agent", bg: `--agent-${id}`, kind: "text" });
  }
  for (let n = 1; n <= 8; n += 1) {
    pairs.push({ fg: `--member-${n}`, bg: "--surface-card", kind: "graphic" });
  }
  return pairs;
}

export interface ContrastResult extends ContrastPair {
  ratio: number;
  threshold: number;
  pass: boolean;
}

/** 让浏览器把一个 token 算成 `rgb(...)`：挂一个元素，读计算样式。 */
function computedColor(probe: HTMLElement, token: string): string {
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
}

function hex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function pairRatio(probe: HTMLElement, pair: Omit<ContrastPair, "kind">) {
  let background = computedColor(probe, pair.bg);
  if (pair.over) {
    const tint = parseColor(computedColor(probe, pair.over));
    const base = parseColor(background);
    if (!tint || !base) throw new Error(`unparseable ${pair.over}`);
    background = hex(composite(tint, base.rgb));
  }
  let foreground = computedColor(probe, pair.fg);
  if (pair.alpha !== undefined) {
    const parsed = parseColor(foreground);
    if (!parsed) throw new Error(`unparseable ${pair.fg}`);
    foreground = `rgb(${parsed.rgb.join(" ")} / ${pair.alpha * 100}%)`;
  }
  return contrastOver(foreground, background);
}

function withProbe<T>(read: (probe: HTMLElement) => T): T {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  try {
    return read(probe);
  } finally {
    probe.remove();
  }
}

/** 一对 token 此刻在页面上的对比度（色块下方印的那个数）。 */
export function tokenContrast(pair: Omit<ContrastPair, "kind">): number {
  return withProbe((probe) => pairRatio(probe, pair));
}

export function measureContrast(): ContrastResult[] {
  const theme =
    document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return withProbe((probe) =>
    contrastPairs(theme).map((pair) => {
      const ratio = pairRatio(probe, pair);
      const threshold = CONTRAST_THRESHOLD[pair.kind];
      return {
        ...pair,
        ratio: Math.round(ratio * 100) / 100,
        threshold,
        pass: ratio >= threshold,
      };
    }),
  );
}

declare global {
  interface Window {
    /** 截图探针读它（设计展示页 §3）。 */
    __showcaseContrast?: () => ContrastResult[];
  }
}

export function installShowcaseContrast(): void {
  window.__showcaseContrast = measureContrast;
}
