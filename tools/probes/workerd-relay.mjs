// 本地 workerd 上的 Workers 中继（armadra-cloud 的 apps/relay-workers，`wrangler dev --local`）。
//
// 不连 Cloudflare 账号：回环端口、临时存储目录、这一次随机生成的 secret；页面产物取
// 本仓库的 apps/web/dist（`--assets` 指到一份拷贝，不改 cloud 检出里的 assets/）。
// 答 `{ issuer, account, password, log(), stop() }`；`stop` 只按自己起的 PID 结束。
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freePort, until } from "./ui-features/harness.mjs";

/** cloud 检出里能直接起 wrangler 的 Workers 项目目录；没有则 null。 */
export function findWorkersProject(cloudHome) {
  const cwd = join(cloudHome, "apps/relay-workers");
  const wrangler = join(cwd, "node_modules/wrangler/bin/wrangler.js");
  return existsSync(wrangler) && existsSync(join(cwd, "wrangler.jsonc"))
    ? { cwd, wrangler }
    : null;
}

export async function startWorkerd({
  cloudHome,
  webRoot,
  onSecret = (_name, value) => value,
}) {
  const project = findWorkersProject(cloudHome);
  if (!project)
    throw new Error(
      `${cloudHome} 里没有装好的 apps/relay-workers（pnpm install 后再来）`,
    );
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const work = mkdtempSync(join(tmpdir(), "armadra-workerd-probe-"));
  const assets = join(work, "assets");
  cpSync(webRoot, assets, { recursive: true });
  const account = "dev";
  const password = onSecret(
    "中继口令",
    `${randomBytes(12).toString("base64url")}-Aq7`,
  );
  const masterKey = onSecret("主密钥", randomBytes(32).toString("hex"));
  const child = spawn(
    process.execPath,
    [
      project.wrangler,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
      // wrangler 本地模式按 routes 把 Host / Origin 改写成 relay.armadra.com；指回本机，
      // 页面的 Origin 才原样到中继（核心逐字节比对来源）。
      "--local-upstream",
      `127.0.0.1:${port}`,
      "--upstream-protocol",
      "http",
      "--persist-to",
      join(work, "state"),
      "--assets",
      assets,
      "--var",
      `RELAY_ISSUER:${issuer}`,
      "--var",
      `RELAY_MASTER_KEY:${masterKey}`,
      "--var",
      `RELAY_PERSONAL_ACCOUNT:${account}`,
      "--var",
      `RELAY_PERSONAL_PASSWORD:${password}`,
    ],
    {
      cwd: project.cwd,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let text = "";
  const take = (chunk) => (text += chunk);
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const exited = new Promise((done) => child.once("exit", done));
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGINT");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(work, { recursive: true, force: true });
  };
  try {
    await until(
      async () => {
        if (child.exitCode !== null)
          throw new Error(`wrangler 提前退出：${text.slice(-800)}`);
        try {
          return (await fetch(`${issuer}/health`)).ok;
        } catch {
          return false;
        }
      },
      "workerd 中继就绪",
      { timeout: 120_000 },
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return { issuer, account, password, log: () => text, stop };
}
