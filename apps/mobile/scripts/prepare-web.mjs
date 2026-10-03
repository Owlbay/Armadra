/**
 * 把 `apps/web` 的生产构建拷进 `www/`（`capacitor.config.ts` 的 `webDir`），再塞进
 * 插件桥：
 *
 *   pnpm --filter @armadra/web build        # 先有页面产物
 *   node apps/mobile/scripts/prepare-web.mjs  # → apps/mobile/www
 *   pnpm --filter @armadra/mobile exec cap sync
 *
 * 页面打进安装包（外部服务 §5.1：商店不收远程网页壳，也不做 OTA），所以这里
 * 只认本地产物，不接受 URL。插件桥（`src/bridge.ts`）打成一个自包含的 IIFE，
 * 以普通 `<script>` 插在页面的第一个模块脚本之前——模块脚本是延迟执行的，页面
 * 求值时 `Capacitor.Plugins.ArmadraNative` 已经登记好。
 */
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, "..");

export const BRIDGE_FILE = "armadra-native.js";
const BRIDGE_TAG = `<script src="/${BRIDGE_FILE}"></script>`;

/** 在第一个 `<script type="module"` 之前（没有就在 `</head>` 之前）插桥；已插过原样返回。 */
export function injectBridge(html) {
  if (html.includes(BRIDGE_TAG)) return html;
  const module = html.search(/<script\b[^>]*\btype=["']?module\b/i);
  if (module >= 0)
    return `${html.slice(0, module)}${BRIDGE_TAG}\n    ${html.slice(module)}`;
  const head = html.search(/<\/head>/i);
  if (head < 0) throw new Error("index.html 里没有 </head>，插不进插件桥");
  return `${html.slice(0, head)}    ${BRIDGE_TAG}\n  ${html.slice(head)}`;
}

/** 插件桥的 IIFE。 */
export async function bundleBridge() {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [join(mobileRoot, "src/bridge.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    // iOS 15 的 WKWebView、Android 8 起的 WebView（Chromium 自更新）都认 ES2020。
    target: ["es2020", "safari15"],
    minify: true,
    legalComments: "none",
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("插件桥没有产物");
  return output.text;
}

export async function prepareWeb({
  webDist = resolve(mobileRoot, "../web/dist"),
  out = join(mobileRoot, "www"),
} = {}) {
  const index = join(webDist, "index.html");
  if (!existsSync(index))
    throw new Error(
      `${index} 不存在：先构建页面（pnpm --filter @armadra/web build）`,
    );
  rmSync(out, { recursive: true, force: true });
  cpSync(webDist, out, { recursive: true });
  writeFileSync(join(out, BRIDGE_FILE), await bundleBridge());
  const page = join(out, "index.html");
  writeFileSync(page, injectBridge(readFileSync(page, "utf8")));
  return { out };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const webDist = option("--web");
  const out = option("--out");
  prepareWeb({
    ...(webDist ? { webDist: resolve(webDist) } : {}),
    ...(out ? { out: resolve(out) } : {}),
  }).then(
    ({ out: written }) => console.log(`web assets → ${written}`),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
