import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

/**
 * 把中继打成一个 `out/main.js`，只依赖 Node 自带模块，部署时拷这一个文件即可。
 * APNs / FCM 客户端与信封形状来自 core 的 `push/transport-direct.ts`，打进来
 * 而不是复制一份：App 只认一种消息，两边必须是同一段代码。
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "out/main.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
});
