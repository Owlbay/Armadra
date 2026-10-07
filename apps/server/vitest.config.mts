import { defineConfig } from "vitest/config";

/**
 * 服务器壳自己的用例。装配级用例会真起一个 core（临时数据目录、随机端口、
 * 自签名 TLS），所以和桌面壳一样用 `pool: "forks"`：真进程、真监听、真信号。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/out/**"],
    environment: "node",
    pool: "forks",
    // 用例经 `tempDir()` 建的临时目录，每个文件跑完统一删（与桌面壳同一套）。
    setupFiles: ["../desktop/src/core/testing/setup.ts"],
    testTimeout: 60_000,
    // 工程规范化 §5：覆盖率只出报告、不设门槛。CI 只在 Linux 作业里开
    // （ARMADRA_COVERAGE=1），本机用 `pnpm test:coverage` 或 `vitest run --coverage`。
    coverage: {
      enabled: process.env.ARMADRA_COVERAGE === "1",
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
