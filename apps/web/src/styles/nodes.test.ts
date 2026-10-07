// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// vitest 把 CSS stub 成空串，所以按文件读源文本（同 `tokens.test.ts`）。
const nodesCss = readFileSync(
  fileURLToPath(new URL("./nodes.css", import.meta.url)),
  "utf8",
);

describe("nodes.css 节点头（设计系统 §4）", () => {
  it("不再有悬停才出现的头部控件", () => {
    expect(nodesCss).not.toContain(".node-secondary-action");
    expect(nodesCss).not.toMatch(/node-header[^{]*\{[^}]*opacity:\s*0/);
  });

  it("胶囊簇最多占头部 40%", () => {
    expect(nodesCss).toMatch(/\.node-header-chips\s*\{\s*max-width:\s*40%;/);
  });
});
