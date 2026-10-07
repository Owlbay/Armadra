import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

/**
 * 把服务器壳打成一个 `out/main.js`。
 *
 * 选型是 **esbuild**：core 与桌面壳共用的 electron-vite 底下也是它，同一个
 * bundler 意味着「什么该外部化」这条规则不会在两种壳之间分叉。输出是 CJS，因为
 * 入口用 `require.main === module` 判断自己是不是进程入口，而 core 的桌面产物
 * 也是 CJS。
 *
 * `--external` 的三类：
 *
 *   * **原生模块**（`node-pty`）。它按自己的相对路径找 `build/Release/*.node`，
 *     打进 bundle 之后那些路径就指向 `out/` 了。
 *   * **可选的原生加速**（`bufferutil`、`utf-8-validate`），`ws` 只在装了的时候
 *     才用它们。
 *   * **Electron**。core 一行都不 import 它（`core/no-electron.test.ts` 扫这件
 *     事），列在这里只是为了让误引入在构建期就炸，而不是在运行期。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/**
 * `import text from "./x.txt?raw"`：vite（桌面壳与 vitest）原生支持的写法，这里
 * 对齐成同一个语义——把文件正文当字符串内联。core 用它带上随包的常见口令表
 * （`core/identity/common-passwords.txt`）。
 */
const rawText = {
  name: "raw-text",
  setup(context) {
    context.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.slice(0, -"?raw".length)),
      namespace: "raw-text",
    }));
    context.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "out/main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["node-pty", "bufferutil", "utf-8-validate", "electron"],
  plugins: [rawText],
  /**
   * 这个进程的入口是服务器壳，不是 core。
   *
   * core 与壳各有一个 `require.main === module` 的入口判断，而 esbuild 把两
   * 个模块**内联进同一个 CommonJS 文件**：`module` 是同一个对象，于是两个判
   * 断同时成立。core 会去解析壳的命令行，在 `serve` 上失败并
   * `process.exit(1)`，壳一个请求都还没服务过。banner 在 bundle 正文之前执
   * 行，所以 core 的判断读到它时已经写好了。
   */
  banner: { js: 'globalThis.__armadraShellEntry = "server";' },
  logLevel: "info",
});

/**
 * 随包的 `ama` 与它的宿主适配器（docs/design/coordinator-agent.md §2.5）：与桌面
 * 壳同一份——`@armadra/agent` 的单文件运行时（桌面壳的精确版本 devDependency）
 * 复制到 `out/agent/`，适配器打成 `out/agent-host/ama-armadra.cjs`。core 在
 * `out/main.js` 旁边找它们（`hook/install/shared.ts::agentBundle`），
 * `<数据目录>/bin/ama` 启动器的运行器是本进程的 `node`。
 */
const desktop = resolve(root, "../desktop");
const agentDir = dirname(
  createRequire(join(desktop, "package.json")).resolve("@armadra/agent/bundle"),
);
const agentOut = resolve(root, "out/agent");
rmSync(agentOut, { recursive: true, force: true });
mkdirSync(agentOut, { recursive: true });
for (const name of ["ama.cjs", "ama-sandbox.cjs"]) {
  const source = join(agentDir, name);
  if (!existsSync(source)) throw new Error(`@armadra/agent has no ${name}`);
  copyFileSync(source, join(agentOut, name));
}

await build({
  entryPoints: [resolve(desktop, "src/agent-host/ama/main.ts")],
  outfile: resolve(root, "out/agent-host/ama-armadra.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "info",
});
