// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 设计展示页只在开发构建里存在（设计展示页 §1 第 1–2 条、§4 第 1 条）。
 *
 * 三道检查：入口第一行是 DEV 守卫；`vite.config.ts` 的生产入口只列
 * `index.html`；真跑一次生产构建，产物里既没有 `showcase.html`，也没有
 * 任何来自 `src/showcase/` 的代码，也没有 `i18n/showcase.ts` 的文案（它在
 * `i18n/index.ts` 里只在 `import.meta.env.DEV` 下挂进来）。
 */

const webRoot = fileURLToPath(new URL("../../", import.meta.url));

/** 只在展示页源码里出现的串：任何一个进了产物，就说明展示页被打包了。 */
const MARKERS = [
  "design showcase is dev-only",
  "__showcaseContrast",
  "__showcaseSections",
  "showcaseReady",
  "data-showcase-section",
  // `i18n/showcase.ts` 的键：主包的消息表里出现任何一个，就说明展示页的文案
  // 跟着生产页面一起发了。
  "showcase.title",
  "showcase.section.tokens",
];

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

const temporary: string[] = [];
afterAll(() => {
  for (const directory of temporary)
    rmSync(directory, { recursive: true, force: true });
});

describe("设计展示页不进生产构建", () => {
  it("展示页的消息模块只在 DEV 下挂进 MESSAGE_MODULES", () => {
    const source = readFileSync(join(webRoot, "src/i18n/index.ts"), "utf8");
    expect(source).toContain("...(import.meta.env.DEV ? { showcase } : {}),");
  });

  it("入口第一行就是 DEV 守卫", () => {
    const source = readFileSync(join(webRoot, "src/showcase/main.tsx"), "utf8");
    expect(source.split("\n")[0]).toBe(
      'if (!import.meta.env.DEV) throw new Error("design showcase is dev-only");',
    );
  });

  it("生产构建的入口只有 index.html", async () => {
    // vite.config.ts 在加载时会去读 Runtime 的 endpoints.json：指到空的临时
    // 目录，不碰操作员自己的数据目录。
    const data = mkdtempSync(join(tmpdir(), "armadra-showcase-config-"));
    temporary.push(data);
    process.env.ARMADRA_DATA_DIR = data;
    const { loadConfigFromFile } = await import("vite");
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      join(webRoot, "vite.config.ts"),
      webRoot,
      "silent",
    );
    const input = loaded?.config.build?.rolldownOptions?.input;
    expect(typeof input).toBe("string");
    expect(relative(webRoot, input as string)).toBe("index.html");
  });

  it(
    "生产构建的 dist/ 里没有展示页的入口与代码",
    { timeout: 300_000 },
    async () => {
      const data = mkdtempSync(join(tmpdir(), "armadra-showcase-config-"));
      const outDir = mkdtempSync(join(tmpdir(), "armadra-showcase-dist-"));
      temporary.push(data, outDir);
      process.env.ARMADRA_DATA_DIR = data;
      const { build } = await import("vite");
      // Vitest 把 NODE_ENV 设成 `test`，Vite 据此把 `import.meta.env.DEV` 定成
      // true——那样构建出来的不是生产包。真实的 `vite build` 跑在
      // `production` 下，这里照它来，跑完还原。
      const nodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        await build({
          root: webRoot,
          configFile: join(webRoot, "vite.config.ts"),
          mode: "production",
          logLevel: "silent",
          build: { outDir, emptyOutDir: true },
        });
      } finally {
        process.env.NODE_ENV = nodeEnv;
      }

      const output = files(outDir);
      expect(output.some((file) => file.endsWith("index.html"))).toBe(true);
      expect(
        output.filter((file) => /showcase/i.test(relative(outDir, file))),
      ).toEqual([]);
      const leaks = output
        .filter((file) => /\.(js|html|css)$/.test(file))
        .flatMap((file) => {
          const text = readFileSync(file, "utf8");
          return MARKERS.filter((marker) => text.includes(marker)).map(
            (marker) => `${relative(outDir, file)}: ${marker}`,
          );
        });
      expect(leaks).toEqual([]);
    },
  );
});
