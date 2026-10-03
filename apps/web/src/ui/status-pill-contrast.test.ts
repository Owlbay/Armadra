// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONTRAST_THRESHOLD,
  composite,
  contrastRatio,
  parseColor,
  type Rgb,
} from "@/lib/contrast";
import {
  STATUS_PILL_TEXT,
  STATUS_PILL_TINT,
  TONE_COLOR,
  type StatusTone,
} from "./status-pill";

/**
 * 状态胶囊的字叠在自己的衬底上（图形色按 `STATUS_PILL_TINT`% 混进透明），
 * 衬底再落在三档阅读表面上——每个 tone、两套主题都要 ≥ 4.5（设计系统 §2.3、
 * WCAG 1.4.3）。深色 working 原来拿图形色 `--agent-working` 写字、衬底 15%，
 * 落在卡片上只有约 3.6。
 */

const css = readFileSync(
  fileURLToPath(new URL("../styles/tokens.css", import.meta.url)),
  "utf8",
);

function block(selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const out = new Map<string, string>();
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
  return out;
}

const dark = block(":root {");
const TABLES = {
  dark,
  light: new Map([...dark, ...block(':root[data-theme="light"]')]),
};
type Theme = keyof typeof TABLES;

function resolve(theme: Theme, value: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() 嵌套过深：${value}`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const raw = TABLES[theme].get(name);
    if (raw === undefined) throw new Error(`${theme} 主题缺少 ${name}`);
    return resolve(theme, raw, depth + 1);
  });
}

function color(theme: Theme, value: string) {
  const parsed = parseColor(resolve(theme, value));
  if (!parsed) throw new Error(`无法解析 ${theme} ${value}`);
  return parsed;
}

const TONES = Object.keys(TONE_COLOR) as StatusTone[];
const SURFACES = ["--bg", "--panel", "--surface-card"];

describe.each(["dark", "light"] as const)("状态胶囊 %s", (theme) => {
  it.each(TONES)("%s：字在衬底上 ≥ 4.5", (tone) => {
    const graphic = color(theme, TONE_COLOR[tone]);
    const text = color(theme, `var(${STATUS_PILL_TEXT[tone]})`);
    for (const name of SURFACES) {
      const base = color(theme, `var(${name})`).rgb;
      const tinted: Rgb = composite(
        { rgb: graphic.rgb, alpha: graphic.alpha * (STATUS_PILL_TINT / 100) },
        base,
      );
      const ratio = contrastRatio(composite(text, tinted), tinted);
      expect(ratio, `${tone} on ${name}`).toBeGreaterThanOrEqual(
        CONTRAST_THRESHOLD.text,
      );
    }
  });
});
