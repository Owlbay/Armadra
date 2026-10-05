import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 与 vite.config.ts / tsconfig.app.json 的 paths 保持一致：
      // src/ui 下 shadcn 生成的组件之间用 `@/` 互相引用。
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // 只跑本包的测试：仓库根下 `.claude/worktrees/` 里其他会话的副本曾被扫进来，
    // 用例数与结果都随之漂移。
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    environment: "jsdom",
    // import 会被提升，模块顶层就读 `matchMedia` 的依赖不止一个，所以这
    // 一类补丁必须在 setupFiles 里打，测试文件内的 `installDomPolyfills()`
    // 太晚了。
    setupFiles: ["./src/app/test-setup.ts"],
    // 工程规范化 §5：覆盖率只出报告、不设门槛。CI 只在 Linux 作业里开
    // （ARMADRA_COVERAGE=1），本机用 `pnpm test:coverage` 或 `vitest run --coverage`。
    coverage: {
      enabled: process.env.ARMADRA_COVERAGE === "1",
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/app/test-setup.ts"],
    },
  },
});
