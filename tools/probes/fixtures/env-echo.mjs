#!/usr/bin/env node
/**
 * 节点凭据端到端的假 CLI（契约 §20，`tools/probes/credentials-e2e.mjs`）。
 *
 * 只打印凭据变量的**长度**，从不打印值：探针据此断言启动器把值设给了 CLI 进程，
 * 而值本身没有出现在终端画面、回滚缓冲区或任何产物里。
 */
const NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "COPILOT_GITHUB_TOKEN"];
for (const name of NAMES) {
  const value = process.env[name];
  process.stdout.write(
    `env-echo ${name} length=${value === undefined ? "unset" : value.length}\n`,
  );
}
process.stdout.write(
  `env-echo ARMADRA_CREDENTIAL_REF ${process.env.ARMADRA_CREDENTIAL_REF ? "present" : "absent"}\n`,
);
