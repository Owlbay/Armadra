/**
 * WCAG 2.x 相对亮度与对比度（设计系统 §1 原则 6、§2）。
 *
 * `styles/tokens-contrast.test.ts` 与设计展示页共用：测试读 `tokens.css`
 * 源文本，展示页读 `getComputedStyle` 的值，两边都落到这里算。只认两种写法：
 * `#rrggbb`（或 `#rgb`）与 `rgb(r g b / a%)` / `rgb(r, g, b)`——tokens.css 里
 * 只出现这两种。
 */

export type Rgb = readonly [number, number, number];

/** 带透明度的颜色；`alpha` 在 0–1 之间。 */
export interface Rgba {
  rgb: Rgb;
  alpha: number;
}

/** 解析 `#rgb` / `#rrggbb` / `rgb(...)`，认不出来返回 `undefined`。 */
export function parseColor(value: string): Rgba | undefined {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex?.[1]) {
    const digits =
      hex[1].length === 3
        ? [...hex[1]].map((digit) => digit + digit).join("")
        : hex[1];
    const n = Number.parseInt(digits, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgb =
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/i.exec(
      text,
    );
  if (rgb) {
    const alpha =
      rgb[4] === undefined
        ? 1
        : rgb[5] === "%"
          ? Number(rgb[4]) / 100
          : Number(rgb[4]);
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
      alpha,
    };
  }
  return undefined;
}

/** 把半透明色叠到不透明底色上，得到肉眼看到的颜色。 */
export function composite(color: Rgba, backdrop: Rgb): Rgb {
  const { rgb, alpha } = color;
  return [
    Math.round(rgb[0] * alpha + backdrop[0] * (1 - alpha)),
    Math.round(rgb[1] * alpha + backdrop[1] * (1 - alpha)),
    Math.round(rgb[2] * alpha + backdrop[2] * (1 - alpha)),
  ];
}

function channel(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度。 */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 两个不透明色的对比度（1–21）。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 文字 4.5:1（1.4.3），图形与焦点环 3:1（1.4.11）。 */
export const CONTRAST_THRESHOLD = { text: 4.5, graphic: 3 } as const;

/**
 * 前景叠在背景上的对比度：前景半透明时先叠到背景上再算。
 * 背景本身必须不透明（表面 token 都是实色）。
 */
export function contrastOver(foreground: string, background: string): number {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) {
    throw new Error(`unparseable color: ${foreground} / ${background}`);
  }
  if (bg.alpha !== 1)
    throw new Error(`background is not opaque: ${background}`);
  return contrastRatio(composite(fg, bg.rgb), bg.rgb);
}
