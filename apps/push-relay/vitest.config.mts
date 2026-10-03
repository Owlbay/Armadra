import { defineConfig } from "vitest/config";

/**
 * 中继自己的用例：真起一个中继进程内的 HTTP 服务，上游指向进程内的 push-sink
 * （dev-stack 的假 APNs / FCM）。
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/out/**"],
    environment: "node",
    pool: "forks",
    setupFiles: ["../desktop/src/core/testing/setup.ts"],
    testTimeout: 30_000,
  },
});
