// armadra-cloud 的本地检出在哪（私有仓，CI 拉不到）。
//
// 顺序：ARMADRA_DEV_STACK_CLOUD_SRC、ARMADRA_PERSONAL_RELAY_HOME，再是仓库旁边的
// `../cloud`（工作树放在 `armadra-wt/<名>/` 下时再往上一层）。认的是能直接
// node 运行中继入口的检出：`apps/relay/src/cli.ts` 在，依赖已装。
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const CLOUD_ENTRY = "apps/relay/src/cli.ts";

export function findCloudSource(env = process.env, root = ROOT) {
  const candidates = [
    env.ARMADRA_DEV_STACK_CLOUD_SRC,
    env.ARMADRA_PERSONAL_RELAY_HOME,
    resolve(root, "../cloud"),
    resolve(root, "../../cloud"),
  ]
    .map((value) => value?.trim())
    .filter(Boolean);
  return (
    candidates.find(
      (directory) =>
        existsSync(join(directory, CLOUD_ENTRY)) &&
        existsSync(join(directory, "node_modules")),
    ) ?? null
  );
}
