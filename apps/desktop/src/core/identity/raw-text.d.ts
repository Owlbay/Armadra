/**
 * 随包的文本数据（`common-passwords.txt`）按 `?raw` 内联进产物：vite（桌面壳、
 * vitest）原生支持，服务器壳的 esbuild 在 `apps/server/scripts/build.mjs` 里用
 * 一个同名插件对齐。
 */
declare module "*.txt?raw" {
  const text: string;
  export default text;
}
