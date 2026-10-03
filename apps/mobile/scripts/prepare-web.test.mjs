import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BRIDGE_FILE, injectBridge, prepareWeb } from "./prepare-web.mjs";

const VITE_INDEX = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Armadra</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/react-vendor.js">
  </head>
  <body><div id="root"></div></body>
</html>`;

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "armadra-mobile-"));
  dirs.push(dir);
  return dir;
}

describe("injectBridge", () => {
  it("puts the bridge before the first module script, once", () => {
    const once = injectBridge(VITE_INDEX);
    const bridge = once.indexOf(`<script src="/${BRIDGE_FILE}"></script>`);
    expect(bridge).toBeGreaterThan(0);
    expect(bridge).toBeLessThan(once.indexOf('type="module"'));
    expect(injectBridge(once)).toBe(once);
  });

  it("falls back to the end of <head> and refuses a page without one", () => {
    const html = "<html><head><title>x</title></head><body></body></html>";
    expect(injectBridge(html)).toMatch(
      /armadra-native\.js"><\/script>\n\s*<\/head>/,
    );
    expect(() => injectBridge("<html><body></body></html>")).toThrow();
  });
});

describe("prepareWeb", () => {
  it("copies the built page, writes the bridge bundle and injects it", async () => {
    const dist = temp();
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), VITE_INDEX);
    writeFileSync(join(dist, "assets/index-abc.js"), "console.log(1)");
    const out = join(temp(), "www");
    mkdirSync(out);
    writeFileSync(join(out, "stale.txt"), "old");

    await prepareWeb({ webDist: dist, out });

    expect(existsSync(join(out, "stale.txt"))).toBe(false);
    expect(readFileSync(join(out, "assets/index-abc.js"), "utf8")).toBe(
      "console.log(1)",
    );
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain(
      BRIDGE_FILE,
    );
    const bundle = readFileSync(join(out, BRIDGE_FILE), "utf8");
    expect(bundle).toContain("ArmadraNative");
    // 自包含：没有残留的 import / require。
    expect(bundle).not.toMatch(/\bimport\s*[{(*"']|\brequire\(/);
  });

  it("refuses to run before the page is built", async () => {
    await expect(
      prepareWeb({ webDist: temp(), out: join(temp(), "www") }),
    ).rejects.toThrow(/pnpm --filter @armadra\/web build/);
  });
});
