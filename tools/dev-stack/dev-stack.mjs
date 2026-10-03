#!/usr/bin/env node
/**
 * `pnpm dev-stack <up|down|logs|ps|health>`：本地 dev-stack 的入口。
 *
 *   up [服务…] [--profile 名] [--build] [--timeout 秒]
 *       生成 .data/dev.env（首次）、`docker compose up -d`，然后从宿主机逐个
 *       跑健康检查直到全过或超时。不给服务名就起全部非 profile 服务。
 *   down [--volumes]     停掉全部（含 profile 服务）；--volumes 连卷一起删。
 *   logs [服务…] [-f]    透传 `docker compose logs`。
 *   ps                   透传 `docker compose ps`。
 *   health [服务…] [--profile 名] [--json]   只跑健康检查。
 *
 * 没有 Docker（没装、没启动、没有 compose 插件）时说明原因并退出 0：dev-stack
 * 是可选的，依赖它的用例应当 skipped，而不是因为这台机器没装 Docker 就失败。
 *
 * 密钥：Keycloak 管理员口令、GlitchTip 的 SECRET_KEY 与数据库口令、Gitea 管理员
 * 口令在首次 `up` 时随机生成到 `.data/dev.env`（已 gitignore），只在本机。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES, checkService, selectServices } from "./services.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const COMPOSE_FILE = join(HERE, "docker-compose.yml");
export const DATA_DIR = join(HERE, ".data");
export const ENV_FILE = join(DATA_DIR, "dev.env");
const ALL_PROFILES = [
  ...new Set(SERVICES.filter((s) => s.profile).map((s) => s.profile)),
];

/** The docker binary; overridable so tests can simulate a machine without it. */
function dockerBin(env = process.env) {
  return env.ARMADRA_DEV_STACK_DOCKER || "docker";
}

/** `{ ok: true }` or `{ ok: false, reason }` — why the stack cannot run here. */
export function dockerStatus(env = process.env) {
  const bin = dockerBin(env);
  const compose = spawnSync(bin, ["compose", "version"], {
    encoding: "utf8",
    env,
  });
  if (compose.error)
    return {
      ok: false,
      reason: `没有找到 Docker（${bin}: ${compose.error.code ?? compose.error.message}）`,
    };
  if (compose.status !== 0)
    return {
      ok: false,
      reason: "Docker 没有 compose 插件（docker compose version 失败）",
    };
  const info = spawnSync(bin, ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    env,
  });
  if (info.status !== 0)
    return { ok: false, reason: "Docker 守护进程没有运行（docker info 失败）" };
  return { ok: true, server: info.stdout.trim() };
}

/** Read `.data/dev.env`, creating it with fresh random values the first time. */
export function ensureDevEnv() {
  mkdirSync(join(DATA_DIR, "release"), { recursive: true });
  mkdirSync(join(DATA_DIR, "push-sink", "apns"), { recursive: true });
  if (!existsSync(ENV_FILE)) {
    const secret = (bytes) => randomBytes(bytes).toString("hex");
    const lines = [
      "# 由 tools/dev-stack/dev-stack.mjs 首次 up 时生成；只在本机，不进仓库。",
      `KEYCLOAK_ADMIN_PASSWORD=${secret(16)}`,
      `GLITCHTIP_DB_PASSWORD=${secret(16)}`,
      `GLITCHTIP_SECRET_KEY=${secret(32)}`,
      `GITEA_ADMIN_PASSWORD=${secret(16)}`,
      "",
    ];
    writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
  }
  return readDevEnv();
}

export function readDevEnv() {
  const values = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function composeArgs(profiles) {
  const args = ["compose", "--project-directory", HERE, "-f", COMPOSE_FILE];
  if (existsSync(ENV_FILE)) args.push("--env-file", ENV_FILE);
  for (const profile of profiles) args.push("--profile", profile);
  return args;
}

function compose(args, { profiles = [], stdio = "inherit", env } = {}) {
  const result = spawnSync(dockerBin(), [...composeArgs(profiles), ...args], {
    stdio,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

/** Poll the host-side checks until every one passes or the deadline hits. */
export async function waitHealthy(
  services,
  { timeoutMs, intervalMs = 3000, log = () => {} },
) {
  const deadline = Date.now() + timeoutMs;
  let pending = services;
  let last = [];
  while (true) {
    const results = await Promise.all(pending.map(checkService));
    last = [
      ...last.filter((r) => !pending.some((s) => s.name === r.service)),
      ...results,
    ];
    pending = pending.filter((service) =>
      results.some((r) => r.service === service.name && !r.ok),
    );
    if (pending.length === 0 || Date.now() >= deadline) break;
    log(`等待：${pending.map((s) => s.name).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return services.map((service) =>
    last.find((r) => r.service === service.name),
  );
}

function printResults(results) {
  for (const result of results) {
    const service = SERVICES.find((s) => s.name === result.service);
    const ports = service.ports.join("/");
    const mark = result.ok ? "ok  " : "FAIL";
    console.log(
      `${mark} ${result.service.padEnd(15)} 127.0.0.1:${ports.padEnd(12)} ${result.ok ? `${result.ms}ms` : result.error}`,
    );
  }
}

/** Create the Gitea admin the forge tests log in as; idempotent. */
function ensureGiteaAdmin(env) {
  const result = compose(
    [
      "exec",
      "-T",
      "-u",
      "git",
      "gitea",
      "gitea",
      "admin",
      "user",
      "create",
      "--admin",
      "--username",
      "armadra-dev",
      "--email",
      "dev@armadra.test",
      "--password",
      env.GITEA_ADMIN_PASSWORD,
      "--must-change-password=false",
    ],
    { stdio: "pipe" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 && !/already exists/i.test(output))
    console.warn(`gitea 管理员没有建成：${output.trim()}`);
}

export function parseArgs(argv) {
  const options = {
    names: [],
    profiles: [],
    json: false,
    build: false,
    volumes: false,
    follow: false,
    timeout: 600,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") options.profiles.push(argv[++i]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--build") options.build = true;
    else if (arg === "--volumes") options.volumes = true;
    else if (arg === "-f" || arg === "--follow") options.follow = true;
    else if (arg === "--timeout") options.timeout = Number(argv[++i]);
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else options.names.push(arg);
  }
  return options;
}

export async function main(argv) {
  const [command = "help", ...rest] = argv;
  if (!["up", "down", "logs", "ps", "health"].includes(command)) {
    console.log(
      "usage: pnpm dev-stack <up|down|logs|ps|health> [服务…] [--profile 名] [--build] [--timeout 秒] [--volumes] [--json]",
    );
    return command === "help" || command === "--help" ? 0 : 2;
  }
  const options = parseArgs(rest);
  const docker = dockerStatus();
  if (!docker.ok) {
    if (options.json)
      console.log(
        JSON.stringify({
          dockerAvailable: false,
          reason: docker.reason,
          results: [],
        }),
      );
    else
      console.log(
        `dev-stack 跳过：${docker.reason}。依赖 dev-stack 的用例会记为 skipped。`,
      );
    return 0;
  }

  ensureDevEnv();
  if (command === "down") {
    const args = ["down", "--remove-orphans"];
    if (options.volumes) args.push("--volumes");
    return compose(args, { profiles: ALL_PROFILES }).status ?? 1;
  }
  if (command === "logs") {
    const args = ["logs", ...(options.follow ? ["-f"] : []), ...options.names];
    return compose(args, { profiles: ALL_PROFILES }).status ?? 1;
  }
  if (command === "ps")
    return compose(["ps"], { profiles: ALL_PROFILES }).status ?? 1;

  const services = selectServices(options);
  if (command === "health") {
    const results = await Promise.all(services.map(checkService));
    if (options.json)
      console.log(JSON.stringify({ dockerAvailable: true, results }));
    else printResults(results);
    return results.every((r) => r.ok) ? 0 : 1;
  }

  // up
  const env = readDevEnv();
  const profiles = [
    ...new Set([
      ...options.profiles,
      ...services.filter((s) => s.profile).map((s) => s.profile),
    ]),
  ];
  const upArgs = ["up", "-d", "--remove-orphans"];
  if (options.build) upArgs.push("--build");
  upArgs.push(...options.names);
  const up = compose(upArgs, { profiles });
  if (up.status !== 0) return up.status ?? 1;
  console.log(`等待健康检查（最多 ${options.timeout}s）…`);
  const results = await waitHealthy(services, {
    timeoutMs: options.timeout * 1000,
    log: (line) => console.log(line),
  });
  if (
    services.some((s) => s.name === "gitea") &&
    results.find((r) => r.service === "gitea")?.ok
  )
    ensureGiteaAdmin(env);
  printResults(results);
  if (results.every((r) => r.ok)) {
    console.log(`dev-stack 就绪。开发密钥在 ${ENV_FILE}。`);
    return 0;
  }
  console.log("有服务没通过健康检查；`pnpm dev-stack logs <服务>` 查看原因。");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
