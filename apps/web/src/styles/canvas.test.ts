// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest 把 CSS stub 成空串，所以按文件读源文本（同 `tokens.test.ts`）。
const canvasCss = readFileSync(
  fileURLToPath(new URL("./canvas.css", import.meta.url)),
  "utf8",
);

/** 选择器列表 → 它那一块声明（取第一处）。 */
function block(selector: string): string {
  const at = canvasCss.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const open = canvasCss.indexOf("{", at);
  return canvasCss.slice(open + 1, canvasCss.indexOf("}", open));
}

describe("缩略图收起钮：悬停才显示（#216）", () => {
  it("展开时平时不显示、不接指针", () => {
    const hidden = block('.minimap-toggle[aria-expanded="true"] {');
    expect(hidden).toMatch(/opacity:\s*0/);
    expect(hidden).toMatch(/pointer-events:\s*none/);
  });

  it("悬停缩略图、悬停钮本身、键盘聚焦与收起后的展开钮都显示", () => {
    const marker = '.minimap-toggle[data-reveal="true"] {';
    const shown = block(marker);
    expect(shown).toMatch(/opacity:\s*1/);
    expect(shown).toMatch(/pointer-events:\s*auto/);
    const at = canvasCss.indexOf(marker);
    // prettier 会把长选择器拆成几行，比较前把空白压成一个空格。
    const selectors = canvasCss
      .slice(canvasCss.lastIndexOf("}", at) + 1, at)
      .replace(/\s+/g, " ");
    expect(selectors).toContain('.minimap-toggle[aria-expanded="false"]');
    expect(selectors).toContain(".minimap-toggle:focus-visible");
    expect(selectors).toContain(
      ".react-flow__minimap:hover ~ .minimap-toggle-panel .minimap-toggle",
    );
    expect(selectors).toContain(".minimap-toggle-panel:hover .minimap-toggle");
  });

  it("触屏没有悬停：常显", () => {
    const at = canvasCss.indexOf("@media (hover: none), (any-pointer: coarse)");
    expect(at).toBeGreaterThanOrEqual(0);
    const media = canvasCss.slice(at, canvasCss.indexOf("}\n}", at));
    expect(media).toContain('.minimap-toggle[aria-expanded="true"]');
    expect(media).toMatch(/opacity:\s*1/);
  });
});
