#!/usr/bin/env node
/**
 * `pnpm dev-stack <up|down|logs|ps|health>`：本地 dev-stack 的入口。
 *
 *   up [服务…] [--profile 名] [--build] [--timeout 秒]
 *       生成 .data/dev.env（首次）、`docker compose up -d`，然后从宿主机逐个
 *       跑健康检查直到全过或超时。不给服务名就起全部非 profile 服务；
 *       `--profile platform|personal` 自成一体，只起这个 profile 的服务（见下文）。
 *   down [服务…] [--profile 名] [--volumes]
 *       不点名停掉全部（含 profile 服务，别的 worktree 的也会被停）；点名只停那几个；
 *       `--profile platform|personal` 只停该 profile 的服务。--volumes 连卷一起删。
 *   logs [服务…] [-f]    透传 `docker compose logs`。
 *   ps                   透传 `docker compose ps`。
 *   health [服务…] [--profile 名] [--json]   只跑健康检查。
 *
 * 没有 Docker（没装、没启动、没有 compose 插件）时说明原因并退出 0：dev-stack
 * 是可选的，依赖它的用例应当 skipped，而不是因为这台机器没装 Docker 就失败。
 *
 * platform / personal profile：`pnpm platform:up` / `platform:personal` 等，见
 * docs/guides/development.md「本地平台环境」。
 *
 * 密钥：Keycloak 管理员口令、GlitchTip 的 SECRET_KEY 与数据库口令、Gitea 管理员
 * 口令在首次 `up` 时随机生成到 `.data/dev.env`（已 gitignore），只在本机。
 */
import { spawnSync } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST,
  RELAY_PERSONAL,
  SCOPED_PROFILES,
  SERVICES,
  checkService,
  profilesOf,
  selectServices,
} from "./services.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const COMPOSE_FILE = join(HERE, "docker-compose.yml");
export const CLOUD_SRC_FILE = join(HERE, "docker-compose.cloud-src.yml");
export const DATA_DIR = join(HERE, ".data");
export const ENV_FILE = join(DATA_DIR, "dev.env");
const ALL_PROFILES = [...new Set(SERVICES.flatMap(profilesOf))];

/**
 * 云仓本地克隆的位置：`ARMADRA_DEV_STACK_CLOUD_SRC`，没设就看本仓库旁边有没有
 * `../armadra-cloud`（GHCR 镜像发布前这是缺省）。返回绝对路径或 null；`note` 收一行说明。
 */
export function resolveCloudSrc(
  env = process.env,
  { repoRoot = join(HERE, "..", ".."), note = () => {} } = {},
) {
  const explicit = env.ARMADRA_DEV_STACK_CLOUD_SRC;
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(join(dir, "apps", "cloud", "Dockerfile")))
      throw new Error(
        `ARMADRA_DEV_STACK_CLOUD_SRC=${explicit} 不是 armadra-cloud 的克隆（缺 apps/cloud/Dockerfile）`,
      );
    return dir;
  }
  const sibling = resolve(repoRoot, "..", "armadra-cloud");
  if (existsSync(join(sibling, "apps", "cloud", "Dockerfile"))) {
    note(
      `云仓镜像从本地克隆构建：${sibling}（设 ARMADRA_DEV_STACK_CLOUD_SRC 可改）`,
    );
    return sibling;
  }
  return null;
}

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

/** platform / personal profile 用的开发密钥（名字，字节数）；PLATFORM_DB_PASSWORD 等只在本机。 */
const PLATFORM_SECRETS = [
  ["PLATFORM_DB_PASSWORD", 16],
  ["PERSONAL_RELAY_PASSWORD", 16],
  ["PLATFORM_SEED_PASSWORD", 16],
  ["ARMADRA_CLOUD_MASTER_KEY", 32],
];

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
  // 后来加的密钥补进已有的文件：旧的 .data/dev.env 不会被重写。
  const present = readDevEnv();
  const added = PLATFORM_SECRETS.filter(([name]) => !(name in present)).map(
    ([name, bytes]) => `${name}=${randomBytes(bytes).toString("hex")}`,
  );
  if (added.length > 0) appendFileSync(ENV_FILE, `${added.join("\n")}\n`);
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

function composeArgs(profiles, cloudSrc = null) {
  const args = ["compose", "--project-directory", HERE, "-f", COMPOSE_FILE];
  if (cloudSrc) args.push("-f", CLOUD_SRC_FILE);
  if (existsSync(ENV_FILE)) args.push("--env-file", ENV_FILE);
  for (const profile of profiles) args.push("--profile", profile);
  return args;
}

function compose(args, { profiles = [], stdio = "inherit", env } = {}) {
  // 本地构建只在 up / build 时有意义，但 down / rm 也得用同一组文件才认得服务定义。
  const cloudSrc = resolveCloudSrc(process.env, {
    note: cloudSrcNoteOnce,
  });
  const result = spawnSync(
    dockerBin(),
    [...composeArgs(profiles, cloudSrc), ...args],
    {
      stdio,
      encoding: "utf8",
      // 开发密钥同时放进环境：compose 的 secrets.environment 只认进程环境。
      env: {
        ...(existsSync(ENV_FILE) ? readDevEnv() : {}),
        ...process.env,
        ...(cloudSrc ? { ARMADRA_DEV_STACK_CLOUD_SRC: cloudSrc } : {}),
        ...env,
      },
    },
  );
  if (result.error) throw result.error;
  return result;
}

let cloudSrcNoted = false;
function cloudSrcNoteOnce(line) {
  if (cloudSrcNoted) return;
  cloudSrcNoted = true;
  console.log(line);
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
    const ports = service.ports.length > 0 ? service.ports.join("/") : "-";
    const mark = result.ok ? "ok  " : "FAIL";
    console.log(
      `${mark} ${result.service.padEnd(15)} 127.0.0.1:${ports.padEnd(12)} ${result.ok ? `${result.ms}ms` : result.error}`,
    );
  }
}

/**
 * cloud 起来后跑一次迁移（命令幂等）。签名密钥与 seed 账号等云仓的 `keys generate` /
 * `seed` 命令落地后（C2-1）再接进来。
 */
function migrateCloud() {
  const result = compose(
    ["exec", "-T", "cloud", "node", "/app/out/main.js", "migrate"],
    {
      profiles: ["platform"],
    },
  );
  if (result.status !== 0)
    console.warn("cloud 迁移没有成功；`pnpm dev-stack logs cloud` 查看原因。");
  return result.status ?? 1;
}

/** 对 relay-personal 的 HTTPS 调用；`ca` 给了就按它校验（只信这一张），没给时只取 CA 本身。 */
function relayRequest(method, path, { ca, body, token } = {}) {
  const url = new URL(path, RELAY_PERSONAL.issuer);
  if (url.hostname !== HOST) throw new Error(`dev-stack 只连 ${HOST}`);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, fail) => {
    const request = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        // 取 CA 那一次拿不到可校验的链（就是在取信任锚），只对回环、只读 /ca.crt。
        ...(ca ? { ca } : { rejectUnauthorized: false }),
        headers: {
          accept: "application/json",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", fail);
      },
    );
    request.on("timeout", () => request.destroy(new Error("中继调用超时")));
    request.on("error", fail);
    request.end(payload);
  });
}

/**
 * 给 armadra-server-nat-personal 备登记材料：取中继自签 CA 与指纹，用中继账号登录（钉着这张 CA，
 * 顺带证明 issuer 对宿主机成立），换一枚注册令牌。令牌与指纹只经返回值进 compose 的进程环境，
 * 不打印、不落盘。
 */
export async function mintRelayRegistration(password) {
  const ca = await relayRequest("GET", "/ca.crt");
  if (ca.status !== 200) throw new Error(`/ca.crt 答 ${ca.status}`);
  const fingerprint = createHash("sha256")
    .update(new X509Certificate(ca.text).raw)
    .digest("hex");
  const login = await relayRequest("POST", "/v1/auth/login", {
    ca: ca.text,
    body: {
      account: RELAY_PERSONAL.account,
      password,
      device: { platform: "desktop", name: "dev-stack" },
    },
  });
  if (login.status !== 200)
    throw new Error(`中继账号登录答 ${login.status}（口令与卷里的不一致？）`);
  const accessToken = JSON.parse(login.text).session?.accessToken;
  const issued = await relayRequest("POST", "/v1/sources/registration-tokens", {
    ca: ca.text,
    token: accessToken,
    body: {},
  });
  if (issued.status !== 200) throw new Error(`注册令牌答 ${issued.status}`);
  return {
    fingerprint,
    registrationToken: JSON.parse(issued.text).registrationToken,
  };
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
    // 点了名就只停这几个：dev-stack 在各 worktree 之间共用一个 compose 项目，
    // 不点名的 down 会把别人正在用的服务一起停掉。
    // `--profile platform|personal` 等于点名该 profile 的全部服务（platform:down 用它）。
    const scoped = options.profiles.some((p) => SCOPED_PROFILES.includes(p));
    const names = scoped
      ? selectServices({ profiles: options.profiles }).map((s) => s.name)
      : options.names;
    if (names.length > 0) {
      const args = [
        "rm",
        "-s",
        "-f",
        ...(options.volumes ? ["-v"] : []),
        ...names,
      ];
      return compose(args, { profiles: ALL_PROFILES }).status ?? 1;
    }
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
    ...new Set([...options.profiles, ...services.flatMap(profilesOf)]),
  ];
  const scoped = options.profiles.some((p) => SCOPED_PROFILES.includes(p));
  // 不带 --remove-orphans：别的 worktree 起的、不在这次 profile 里的服务不算孤儿。
  const upArgs = ["up", "-d"];
  if (options.build) upArgs.push("--build");
  // platform / personal 自成一体：点名起它们的服务，免得 compose 把无 profile 的默认那组也带起来。
  upArgs.push(...(scoped ? services.map((s) => s.name) : options.names));
  // NAT 后的 core 要等中继起来才有登记令牌：先起其余服务，中继健康后再起它。
  const nat = scoped
    ? services.find((s) => s.name === "armadra-server-nat-personal")
    : undefined;
  if (nat) upArgs.splice(upArgs.indexOf(nat.name), 1);
  const up = compose(upArgs, { profiles });
  if (up.status !== 0) return up.status ?? 1;
  if (nat) {
    const relay = services.find((s) => s.name === "relay-personal");
    const [relayUp] = await waitHealthy([relay], {
      timeoutMs: options.timeout * 1000,
      log: (line) => console.log(line),
    });
    if (!relayUp.ok) {
      console.log(`relay-personal 没起来：${relayUp.error}`);
      return 1;
    }
    let registration;
    try {
      registration = await mintRelayRegistration(env.PERSONAL_RELAY_PASSWORD);
    } catch (error) {
      console.log(
        `没能向 relay-personal 取登记令牌：${error instanceof Error ? error.message : error}`,
      );
      return 1;
    }
    const natUp = compose(
      ["up", "-d", ...(options.build ? ["--build"] : []), nat.name],
      {
        profiles,
        env: {
          ARMADRA_CLOUD_REGISTRATION_TOKEN: registration.registrationToken,
          ARMADRA_CLOUD_FINGERPRINT: registration.fingerprint,
        },
      },
    );
    if (natUp.status !== 0) return natUp.status ?? 1;
  }
  if (services.some((s) => s.name === "cloud")) {
    const migrated = migrateCloud();
    if (migrated !== 0) return migrated;
  }
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
