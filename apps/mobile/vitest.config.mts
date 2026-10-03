import { defineConfig } from "vitest/config";

/** 手机壳的用例：插件桥、页面产物的拼装、与 core 共用的推送信封样本。 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "www/**", "ios/**", "android/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
