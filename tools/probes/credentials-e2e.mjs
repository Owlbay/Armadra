#!/usr/bin/env node
/**
 * 节点凭据端到端（A 档，补全计划 G1-1，契约 §20）。
 *
 * 不用任何真实账号：凭据值是一串假令牌，CLI 是 `fixtures/env-echo.mjs`——一个
 * 基础 CLI 为 Claude 的自定义 Agent，只打印凭据变量的**长度**。断言：
 *
 *   1. 经画布启动器起的「CLI」看到的变量长度等于假令牌的长度；
 *   2. 节点 shell 自己的环境里没有这个变量（`env | grep -c` 为 0），只有条目名；
 *   3. 值没有出现在终端画面、core 的日志、`GET /api/credentials` 里；
 *   4. 基础 CLI 不匹配的条目在起终端时被拒（`credential_mismatch`），不建会话。
 *
 * 前提：`pnpm --filter @armadra/desktop build`（要 `out/core/main.js` 与
 * `out/cli/armadra-hook.js`）。临时数据目录、临时 HOME；密钥后端用
 * `file-encrypted`（数据目录里的 master key），不碰系统钥匙串；
 * `ARMADRA_NO_GLOBAL_WRITES=1`，数据目录之外什么都不写。Windows 上跳过（启动器
 * 还不能兑换，契约 §20.3）。
 *
 * 用法：node tools/probes/credentials-e2e.mjs [输出目录]
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const coreEntry = join(repo, "apps/desktop/out/core/main.js");
const hookBundle = join(repo, "apps/desktop/out/cli/armadra-hook.js");
const envEcho = join(here, "fixtures/env-echo.mjs");
const FAKE = `sk-ant-oat01-probe-${randomUUID()}`;

if (process.platform === "win32") {
  console.log("skipped: node credentials are not available on Windows yet");
  process.exit(0);
}
for (const path of [coreEntry, hookBundle]) {
  if (!existsSync(path)) {
    console.error(`missing ${path}: run pnpm --filter @armadra/desktop build`);
    process.exit(2);
  }
}

const output = resolve(
  process.argv[2] ??
    join(repo, "target/probes", `credentials-e2e-${Date.now()}`),
);
mkdirSync(output, { recursive: true });
const root = realpathSync(mkdtempSync(join(tmpdir(), "armadra-cred-e2e-")));
const dataDir = join(root, "data");
const home = join(root, "home");
const workspace = join(root, "workspace");
for (const dir of [dataDir, home, workspace])
  mkdirSync(dir, { recursive: true });

const steps = [];
function step(name, ok, detail = {}) {
  steps.push({ name, ok, ...detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

async function startCore() {
  const child = spawn(
    process.execPath,
    [coreEntry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        SHELL: "/bin/sh",
        TMPDIR: tmpdir(),
        ARMADRA_SECRET_BACKEND: "file-encrypted",
        ARMADRA_NO_GLOBAL_WRITES: "1",
      },
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const address = await new Promise((resolveAddress, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`core did not announce:\n${stderr}`)),
      30_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = /Armadra core is listening .*"spec":"tcp:([^"]+)"/.exec(
        stderr,
      );
      if (found) {
        clearTimeout(timer);
        resolveAddress(found[1]);
      }
    });
    child.stdout.resume();
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`core exited with ${code}:\n${stderr}`));
    });
  });
  return {
    base: `http://${address}`,
    stderr: () => stderr,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
    },
  };
}

async function call(core, method, path, body) {
  const response = await fetch(`${core.base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json, text };
}

async function screen(core, sessionId) {
  const answer = await call(
    core,
    "GET",
    `/api/terminals/${sessionId}/capture?lines=200&escapes=false`,
  );
  return answer.body?.data ?? "";
}

async function until(read, ready, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await delay(200);
  }
  return last;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

let core;
let failure;
try {
  core = await startCore();
  step("core started", true, { base: core.base });

  const agentId = "custom:env-echo";
  const settings = await call(core, "PATCH", "/api/settings", {
    agents: {
      custom: [
        {
          id: agentId,
          label: "Env echo",
          color: "#0a84ff",
          launchCmd: envEcho,
          args: [],
          baseAgent: "claude",
        },
      ],
    },
  });
  step("custom agent registered", settings.status === 200, {
    status: settings.status,
  });

  const created = await call(core, "POST", "/api/workspaces", {
    name: "Credentials",
    rootPath: workspace,
  });
  const workspaceId = created.body?.id;
  step("workspace created", typeof workspaceId === "string", {
    status: created.status,
  });

  const listed = await call(core, "GET", "/api/credentials");
  step(
    "credentials available on file-encrypted",
    listed.body?.available === true,
    { backend: listed.body?.backend, reason: listed.body?.reason },
  );

  const claude = await call(core, "POST", "/api/credentials", {
    providerId: "claude",
    kind: "oauth-token",
    label: "Probe",
    value: FAKE,
  });
  const copilot = await call(core, "POST", "/api/credentials", {
    providerId: "copilot",
    kind: "github-token",
    label: "Probe bot",
    value: "github_pat_probe",
  });
  step(
    "entries created, answers carry isSet only",
    claude.status === 201 &&
      claude.body?.isSet === true &&
      !claude.text.includes(FAKE),
    { status: claude.status },
  );

  const nodeId = randomUUID();
  const mismatch = await call(core, "POST", "/api/terminals", {
    workspaceId,
    cwd: workspace,
    shell: "/bin/sh",
    nodeId,
    agent: { id: agentId, credentialRef: copilot.body?.ref },
  });
  step(
    "mismatched provider refused before a pane exists",
    mismatch.status === 400 && mismatch.body?.code === "credential_mismatch",
    { status: mismatch.status, code: mismatch.body?.code },
  );

  const terminal = await call(core, "POST", "/api/terminals", {
    workspaceId,
    cwd: workspace,
    shell: "/bin/sh",
    nodeId,
    agent: { id: agentId, credentialRef: claude.body?.ref },
  });
  const sessionId = terminal.body?.id;
  step("terminal created with the credential", terminal.status === 200, {
    status: terminal.status,
    code: terminal.body?.code,
  });

  const agents = await call(core, "GET", "/api/agents");
  const row = (agents.body ?? []).find?.((agent) => agent.id === agentId);
  const launcher = row?.launcher;
  step("launcher resolved for the custom agent", typeof launcher === "string", {
    launcher,
  });

  await until(
    () => screen(core, sessionId),
    (text) => text.trim() !== "",
    5_000,
  );
  const paste = (text) =>
    call(core, "POST", `/api/terminals/${sessionId}/paste`, {
      text,
      enter: true,
    });
  await paste(`${shellQuote(launcher)} ${shellQuote(envEcho)}`);
  const echoed = await until(
    () => screen(core, sessionId),
    (text) => /env-echo ARMADRA_CREDENTIAL_REF/.test(text),
  );
  const length = /env-echo CLAUDE_CODE_OAUTH_TOKEN length=(\S+)/.exec(
    echoed,
  )?.[1];
  step("the CLI process sees the variable", length === String(FAKE.length), {
    length,
    expected: FAKE.length,
  });
  step(
    "another provider's variable is not set",
    /env-echo COPILOT_GITHUB_TOKEN length=unset/.test(echoed),
  );

  await paste(
    "printf 'shell-count=%s\\n' \"$(env | grep -c '^CLAUDE_CODE_OAUTH_TOKEN=')\"; printf 'shell-ref=%s\\n' \"${ARMADRA_CREDENTIAL_REF:+present}\"",
  );
  const shell = await until(
    () => screen(core, sessionId),
    (text) => /shell-ref=\S*\n?/.test(text) && /shell-count=\d/.test(text),
  );
  step("the node shell has no such variable", /shell-count=0/.test(shell), {
    line: /shell-count=\d+/.exec(shell)?.[0],
  });
  step(
    "the node shell carries only the entry name",
    /shell-ref=present/.test(shell),
  );

  const after = await call(core, "GET", "/api/credentials");
  const leaked = [
    ["screen", shell],
    ["core log", core.stderr()],
    ["credential list", after.text],
  ].filter(([, text]) => text.includes(FAKE));
  step("the value appears on no screen, log or answer", leaked.length === 0, {
    leaked: leaked.map(([where]) => where),
  });
  const used = after.body?.entries?.find(
    (entry) => entry.ref === claude.body?.ref,
  );
  step("lastUsedAt recorded", typeof used?.lastUsedAt === "number");

  // 走不到 CLI：条目删掉之后，同一个 shell 里重跑启动行，启动器拒绝而不是默认登录。
  await call(core, "DELETE", `/api/credentials/${claude.body?.ref}`);
  await paste(
    `${shellQuote(launcher)} ${shellQuote(envEcho)}; echo rerun-exit=$?`,
  );
  const rerun = await until(
    () => screen(core, sessionId),
    (text) => /rerun-exit=\d+/.test(text),
  );
  step(
    "a stale binding refuses to start the CLI",
    /rerun-exit=[1-9]/.test(rerun) && /armadra: node credential/.test(rerun),
    { exit: /rerun-exit=\d+/.exec(rerun)?.[0] },
  );
} catch (error) {
  failure = error;
} finally {
  await core?.stop();
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(
      {
        ok: failure === undefined,
        platform: process.platform,
        node: process.version,
        steps,
        ...(failure === undefined ? {} : { error: String(failure?.message) }),
      },
      null,
      2,
    )}\n`,
  );
  rmSync(root, { recursive: true, force: true });
  console.log(`result: ${join(output, "result.json")}`);
}
if (failure !== undefined) {
  console.error(failure);
  process.exit(1);
}
