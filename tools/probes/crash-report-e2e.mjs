// 可选崩溃上报对 dev-stack GlitchTip 的端到端探针（补全计划 G3-10，外部服务
// §11.2）。
//
// 真 `@sentry/node`、core 的请求错误路径（`CoreServer` 的 500 → `platform.reportError`
// → 服务器壳的 `diagnostics.ts`）、真 GlitchTip 收件端；断言收到的事件里没有环境
// 变量的值、家目录、路径里的用户名、令牌、终端输出、用户与 extra，以及没配 DSN
// 时同一路径什么都不发。用例本体在 `apps/server/src/diagnostics.devstack.test.ts`，
// 这里只是带上 `ARMADRA_DEV_STACK=1` 调起它（平时的 `pnpm test` 里它是 skipped）。
//
// 用法（仓库根目录）：
//   pnpm dev-stack up glitchtip
//   pnpm libs:build
//   node tools/probes/crash-report-e2e.mjs [输出目录]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(
  process.argv[2] ?? join(root, "target/crash-report-e2e"),
);
mkdirSync(output, { recursive: true });

const started = Date.now();
const run = spawnSync(
  "pnpm",
  [
    "--filter",
    "@armadra/server",
    "exec",
    "vitest",
    "run",
    "src/diagnostics.devstack.test.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ARMADRA_DEV_STACK: "1" },
    shell: process.platform === "win32",
  },
);
const ok = run.status === 0;
writeFileSync(
  join(output, "result.json"),
  `${JSON.stringify({ ok, status: run.status, ms: Date.now() - started }, null, 2)}\n`,
);
process.exit(ok ? 0 : 1);
