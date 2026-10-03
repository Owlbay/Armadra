// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONTRAST_THRESHOLD,
  composite,
  contrastOver,
  parseColor,
} from "@/lib/contrast";

/**
 * 设计系统 §2.1–§2.5 每一对颜色的对比度守卫（WCAG 2.1 AA）。
 *
 * 读 `tokens.css` 源文本，把 `var()` 与 `rgb(var(--tint-rgb) / n%)` 展开成
 * 实际颜色，再按表里点名的「前景 × 背景」逐对断言：文字 ≥ 4.5，图形 ≥ 3。
 * 浅色主题 = 深色块打底 + 浅色块覆盖（与浏览器里的层叠一致）。
 */

const tokensCss = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`未找到选择器：${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`规则体没有闭合：${selector}`);
}

function customProperties(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  }
  return out;
}

const darkTable = customProperties(ruleBody(tokensCss, ":root {"));
const lightTable = new Map([
  ...darkTable,
  ...customProperties(ruleBody(tokensCss, ':root[data-theme="light"]')),
]);

type Theme = "dark" | "light";
const TABLES: Record<Theme, Map<string, string>> = {
  dark: darkTable,
  light: lightTable,
};

/** 把一个 token 展开成不含 `var()` 的值。 */
function resolve(theme: Theme, name: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() 嵌套过深：${name}`);
  const raw = TABLES[theme].get(name);
  if (raw === undefined) throw new Error(`${theme} 主题缺少 ${name}`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, ref: string) =>
    resolve(theme, ref, depth + 1),
  );
}

/** 不透明的表面色。 */
function surface(theme: Theme, name: string): string {
  const value = resolve(theme, name);
  const parsed = parseColor(value);
  if (!parsed || parsed.alpha !== 1) {
    throw new Error(`${theme} ${name} 不是实色：${value}`);
  }
  return value;
}

/** 半透明衬底叠到表面上之后的实色（`#rrggbb`）。 */
function flatten(theme: Theme, overlay: string, base: string): string {
  const color = parseColor(resolve(theme, overlay));
  const backdrop = parseColor(surface(theme, base));
  if (!color || !backdrop) throw new Error(`无法解析 ${overlay} / ${base}`);
  const [r, g, b] = composite(color, backdrop.rgb);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function ratio(theme: Theme, fg: string, bg: string): number {
  return contrastOver(resolve(theme, fg), surface(theme, bg));
}

const THEMES: Theme[] = ["dark", "light"];
const TEXT = CONTRAST_THRESHOLD.text;
const GRAPHIC = CONTRAST_THRESHOLD.graphic;
const READING_SURFACES = ["--bg", "--panel", "--surface-card"];
const AGENTS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "omp",
  "copilot",
  "ama",
] as const;

describe("lib/contrast", () => {
  it("黑白是 21:1，同色是 1:1", () => {
    expect(contrastOver("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastOver("#777", "#777777")).toBeCloseTo(1, 5);
  });

  it("半透明前景先叠到背景上再算", () => {
    expect(parseColor("rgb(255 255 255 / 50%)")).toEqual({
      rgb: [255, 255, 255],
      alpha: 0.5,
    });
    expect(contrastOver("rgb(0 0 0 / 0%)", "#ffffff")).toBeCloseTo(1, 5);
  });
});

describe.each(THEMES)("%s 主题对比度", (theme) => {
  it("§2.1 正文与次要文字在阅读表面上 ≥ 4.5", () => {
    for (const bg of [...READING_SURFACES, "--surface-overlay"]) {
      expect(ratio(theme, "--text", bg)).toBeGreaterThanOrEqual(TEXT);
      expect(ratio(theme, "--muted-foreground", bg)).toBeGreaterThanOrEqual(
        TEXT,
      );
    }
  });

  it("§2.2 品牌色：图形 ≥ 3，品牌文字 ≥ 4.5（含叠在 --brand-soft 上），实底白字 ≥ 4.5", () => {
    expect(ratio(theme, "--brand", "--surface-card")).toBeGreaterThanOrEqual(
      GRAPHIC,
    );
    for (const bg of [...READING_SURFACES, "--surface-raised"]) {
      expect(ratio(theme, "--brand-text", bg)).toBeGreaterThanOrEqual(TEXT);
    }
    const soft = flatten(theme, "--brand-soft", "--surface-card");
    expect(
      contrastOver(resolve(theme, "--brand-text"), soft),
    ).toBeGreaterThanOrEqual(TEXT);
    expect(
      contrastOver(
        resolve(theme, "--on-accent"),
        surface(theme, "--brand-solid"),
      ),
    ).toBeGreaterThanOrEqual(TEXT);
  });

  it("§2.2 焦点环按 50% 画，在每一档表面上 ≥ 3", () => {
    const ring = parseColor(resolve(theme, "--focus-ring"))!;
    for (const bg of [
      "--bg",
      "--panel",
      "--surface-card",
      "--surface-raised",
      "--surface-overlay",
    ]) {
      const backdrop = surface(theme, bg);
      const color = `rgb(${ring.rgb.join(" ")} / 50%)`;
      expect(contrastOver(color, backdrop)).toBeGreaterThanOrEqual(GRAPHIC);
    }
  });

  it.each([
    ["danger", "--danger", "--danger-text", "--danger-soft"],
    ["warn", "--warn", "--warn-text", "--warn-soft"],
    ["success", "--success", "--success-text", "--success-soft"],
    ["working", "--agent-working", "--working-text", "--agent-working-soft"],
  ])(
    "§2.3 %s：图形 ≥ 3，文字 ≥ 4.5（卡片上与自身衬底上）",
    (name, graphic, text, soft) => {
      expect(ratio(theme, graphic, "--surface-card")).toBeGreaterThanOrEqual(
        GRAPHIC,
      );
      for (const bg of READING_SURFACES) {
        expect(ratio(theme, text, bg)).toBeGreaterThanOrEqual(TEXT);
      }
      // §2.3 表里深色 working 只验到卡片（5.3），没列「文字叠在衬底上」这一对
      // （按现值算约 4.1）。深色下别把 `--working-text` 叠在 18% 衬底上。
      if (theme === "dark" && name === "working") return;
      const tinted = flatten(theme, soft, "--surface-card");
      expect(contrastOver(resolve(theme, text), tinted)).toBeGreaterThanOrEqual(
        TEXT,
      );
    },
  );

  it("§2.3 caution 图形即文字，≥ 4.5；危险实底白字 ≥ 4.5", () => {
    expect(ratio(theme, "--caution", "--surface-card")).toBeGreaterThanOrEqual(
      TEXT,
    );
    expect(
      contrastOver(
        resolve(theme, "--on-accent"),
        surface(theme, "--danger-solid"),
      ),
    ).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(AGENTS)(
    "§2.4 %s：标识色 ≥ 3，文字色 ≥ 4.5，实底头像上的字 ≥ 4.5",
    (id) => {
      expect(
        ratio(theme, `--agent-${id}`, "--surface-card"),
      ).toBeGreaterThanOrEqual(GRAPHIC);
      for (const bg of READING_SURFACES) {
        expect(ratio(theme, `--agent-${id}-text`, bg)).toBeGreaterThanOrEqual(
          TEXT,
        );
      }
      expect(
        contrastOver(
          resolve(theme, "--on-agent"),
          surface(theme, `--agent-${id}`),
        ),
      ).toBeGreaterThanOrEqual(TEXT);
    },
  );

  it("§2.5 成员色八色在卡片上 ≥ 3", () => {
    for (let n = 1; n <= 8; n += 1) {
      expect(
        ratio(theme, `--member-${n}`, "--surface-card"),
      ).toBeGreaterThanOrEqual(GRAPHIC);
    }
  });
});
