#!/usr/bin/env node
/**
 * `pnpm platform:e2e`：平台的跨仓端到端探针（docs/design/platform/dev-stack-and-verification.md §4）。
 *
 *   A 档  personal-roundtrip、multi-source、link-join   → tools/ci/e2e.mjs --tier a
 *   B 档  nat-core-offline                              → tools/ci/e2e.mjs --tier b
 *   预留  relay-roundtrip：依赖 SaaS 服务端（armadra-cloud 的 saas 模式），服务端落地前
 *         没有这条探针，这里只打印说明，不算失败。
 *
 * 依赖 armadra-cloud 的本地检出与 Docker（没有时清单里的条目记 skipped / failed 由
 * `tools/ci/e2e.mjs` 说明）；加 `--a-only` 只跑 A 档。产物在 target/e2e/<档>/。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = fileURLToPath(new URL("../ci/e2e.mjs", import.meta.url));

export const PLAN = [
  {
    tier: "a",
    only: ["personal-roundtrip", "multi-source", "link-join"],
  },
  { tier: "b", only: ["nat-core-offline"] },
];

/** 预留的探针：依赖还没有的东西。 */
export const RESERVED = [
  {
    id: "relay-roundtrip",
    reason: "依赖 SaaS 服务端（armadra-cloud saas 模式），尚未落地",
  },
];

function main(argv) {
  const aOnly = argv.includes("--a-only");
  for (const item of RESERVED) console.log(`预留  ${item.id}：${item.reason}`);
  let failed = false;
  for (const step of PLAN) {
    if (aOnly && step.tier !== "a") continue;
    const result = spawnSync(
      process.execPath,
      [runner, "--tier", step.tier, "--only", step.only.join(",")],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
