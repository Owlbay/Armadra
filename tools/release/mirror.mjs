/**
 * 更新镜像（W-MIRROR，外部服务 §3.3）：把一次发布复制进一个 S3 兼容桶（Cloudflare R2，
 * 本地是 dev-stack 的 `s3`），路径与 GitHub Release 同形，客户端在
 * `ARMADRA_UPDATER_ENDPOINTS` 里把镜像排在 GitHub 后面（或前面）即可。
 *
 *   node tools/release/mirror.mjs stage   --dir <发布目录> --version X.Y.Z [--manifest <镜像 latest.json 目录>]
 *   node tools/release/mirror.mjs promote --version X.Y.Z
 *   node tools/release/mirror.mjs verify  --base <公开地址> --pubkey <minisign.pub>
 *
 * 桶里两处：
 *
 * - `releases/download/v<版本>/`：这一版的全部文件，`stage` 写，写过不改。先传包，
 *   再传清单（latest.json、SHA256SUMS、`latest-*.yml` 与它们的 .sig），读到清单的
 *   客户端不会去拿还没到的包。`--manifest` 给的是 `assemble.mjs --mirror-base` 写的
 *   镜像版 `latest.json`（同一把钥匙签、链接指向镜像自己），它盖掉发布里那份。
 * - `releases/latest/download/`：只有清单。`promote` 把那一版的清单服务端复制过来；
 *   清单里的地址都指向带版本的那一处，所以这里不需要包。
 *
 * `stage` 在 release.yml 建 draft 时跑（带版本的路径没人会去问）；`promote` 在人把
 * Release 转正后由 distribute.yml 跑，预发布不 promote——镜像的「最新」与 GitHub
 * 的「最新」同时变。
 *
 * 连接参数都从环境变量来：`ARMADRA_MIRROR_ENDPOINT`、`ARMADRA_MIRROR_BUCKET`、
 * `ARMADRA_MIRROR_ACCESS_KEY_ID`、`ARMADRA_MIRROR_SECRET_ACCESS_KEY`，可选
 * `ARMADRA_MIRROR_PROVIDER`（缺省 Cloudflare）与 `ARMADRA_MIRROR_REGION`（缺省 auto）。
 * 四个都没有就跳过（退出 0）；只给了一部分是配置错误（退出 1）。
 *
 * 传输用 rclone：PATH 上有就用，否则用钉住版本的容器镜像 `RCLONE_IMAGE`。rclone 的
 * 远端配置走 `RCLONE_CONFIG_MIRROR_*` 环境变量，不落盘。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChecksums } from "./checksums.mjs";
import { verifyDetached } from "./minisign.mjs";
import { parseFeed, sha512Base64 } from "./stage-desktop.mjs";

export const RCLONE_IMAGE = "rclone/rclone:1.71.1";
export const REMOTE = "mirror";
export const PREFIX = "releases";

/** 必填的四个环境变量。 */
export const MIRROR_ENV = [
  "ARMADRA_MIRROR_ENDPOINT",
  "ARMADRA_MIRROR_BUCKET",
  "ARMADRA_MIRROR_ACCESS_KEY_ID",
  "ARMADRA_MIRROR_SECRET_ACCESS_KEY",
];

/** 清单：读到它们的客户端接着会去拿别的文件，所以总是最后上传。 */
export const MANIFEST_PATTERNS = [
  "latest.json*",
  "SHA256SUMS*",
  "latest-*.yml*",
];

/**
 * 读配置：`{ skip: true }`（一个都没给）、`{ problem }`（给了一部分），或完整配置。
 */
export function mirrorConfig(env = process.env) {
  const present = MIRROR_ENV.filter((name) => (env[name] ?? "").trim() !== "");
  if (present.length === 0) return { skip: true };
  if (present.length < MIRROR_ENV.length)
    return {
      problem: `mirror is half configured; missing ${MIRROR_ENV.filter((n) => !present.includes(n)).join(", ")}`,
    };
  return {
    endpoint: env.ARMADRA_MIRROR_ENDPOINT.trim(),
    bucket: env.ARMADRA_MIRROR_BUCKET.trim(),
    accessKeyId: env.ARMADRA_MIRROR_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.ARMADRA_MIRROR_SECRET_ACCESS_KEY.trim(),
    provider: (env.ARMADRA_MIRROR_PROVIDER ?? "").trim() || "Cloudflare",
    region: (env.ARMADRA_MIRROR_REGION ?? "").trim() || "auto",
  };
}

/** rclone 的远端 `mirror:` 由这些环境变量定义。 */
export function rcloneEnv(config) {
  const prefix = `RCLONE_CONFIG_${REMOTE.toUpperCase()}_`;
  return {
    [`${prefix}TYPE`]: "s3",
    [`${prefix}PROVIDER`]: config.provider,
    [`${prefix}ENDPOINT`]: config.endpoint,
    [`${prefix}REGION`]: config.region,
    [`${prefix}ACCESS_KEY_ID`]: config.accessKeyId,
    [`${prefix}SECRET_ACCESS_KEY`]: config.secretAccessKey,
    // R2 的令牌常常只授权一个桶，HEAD / 建桶会被拒；桶由人建好。
    [`${prefix}NO_CHECK_BUCKET`]: "true",
  };
}

const COMMON = ["--retries", "3", "--stats-one-line", "-v"];
const manifestsOnly = () => [
  ...MANIFEST_PATTERNS.flatMap((p) => ["--filter", `+ ${p}`]),
  "--filter",
  "- *",
];
const withoutManifests = () =>
  MANIFEST_PATTERNS.flatMap((p) => ["--exclude", p]);

export function versionedPath(bucket, version) {
  return `${REMOTE}:${bucket}/${PREFIX}/download/v${version}`;
}

export function latestPath(bucket) {
  return `${REMOTE}:${bucket}/${PREFIX}/latest/download`;
}

/**
 * `stage` 的 rclone 调用，按顺序：包、清单、（有镜像版 latest.json 时）盖上它、
 * 核对。`source` 是发布目录在 rclone 眼里的路径（容器里是挂载点）。
 */
export function stagePlan({ source, manifestSource, bucket, version }) {
  const target = versionedPath(bucket, version);
  const plan = [
    ["copy", source, target, ...withoutManifests(), ...COMMON],
    ["copy", source, target, ...manifestsOnly(), ...COMMON],
  ];
  if (manifestSource) {
    plan.push([
      "copy",
      manifestSource,
      target,
      "--filter",
      "+ latest.json*",
      "--filter",
      "- *",
      ...COMMON,
    ]);
    // 镜像版 latest.json 与本地发布目录里那份本来就不同，核对时不算它。
    plan.push([
      "check",
      source,
      target,
      "--one-way",
      "--exclude",
      "latest.json*",
    ]);
  } else {
    plan.push(["check", source, target, "--one-way"]);
  }
  return plan;
}

/** `promote` 的 rclone 调用：服务端把那一版的清单复制到 latest，再核对。 */
export function promotePlan({ bucket, version }) {
  const from = versionedPath(bucket, version);
  const to = latestPath(bucket);
  return [
    ["copy", from, to, ...manifestsOnly(), ...COMMON],
    ["check", from, to, "--one-way", ...manifestsOnly()],
  ];
}

function onPath(command) {
  const probe = spawnSync(command, ["version"], { stdio: "ignore" });
  return probe.status === 0;
}

/**
 * 怎么跑 rclone：`{ command, args(prefixArgs), mounts }`。PATH 上有就直接跑；否则
 * `docker run` 钉住的镜像，把要读的本地目录只读挂进去。容器在 Linux 上用宿主网络；
 * 在 Docker Desktop 上回环地址换成 `host.docker.internal`。
 */
export function rcloneRunner({
  env = process.env,
  platform = process.platform,
  local = onPath("rclone"),
} = {}) {
  if (local && env.ARMADRA_MIRROR_RCLONE !== "docker")
    return {
      local: true,
      path: (p) => p,
      endpoint: (e) => e,
      invoke: (args, extraEnv) => ({
        command: "rclone",
        args,
        env: { ...env, ...extraEnv },
      }),
    };
  const mounts = [];
  return {
    local: false,
    path: (p) => {
      const index = mounts.indexOf(p);
      const at = index >= 0 ? index : mounts.push(p) - 1;
      return `/mnt/m${at}`;
    },
    endpoint: (e) =>
      platform === "linux"
        ? e
        : e.replace(
            /\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/,
            "//host.docker.internal",
          ),
    invoke: (args, extraEnv) => ({
      command: "docker",
      args: [
        "run",
        "--rm",
        ...(platform === "linux" ? ["--network", "host"] : []),
        ...mounts.flatMap((p, i) => ["-v", `${p}:/mnt/m${i}:ro`]),
        ...Object.keys(extraEnv).flatMap((name) => ["-e", name]),
        RCLONE_IMAGE,
        ...args,
      ],
      env: { ...env, ...extraEnv },
    }),
  };
}

function run(runner, plan, config, log) {
  const extraEnv = rcloneEnv({
    ...config,
    endpoint: runner.endpoint(config.endpoint),
  });
  for (const args of plan) {
    log(`rclone ${args.join(" ")}`);
    const call = runner.invoke(args, extraEnv);
    const result = spawnSync(call.command, call.args, {
      env: call.env,
      stdio: "inherit",
    });
    if (result.status !== 0)
      throw new Error(`rclone ${args[0]} exited with ${result.status}`);
  }
}

/** 把发布目录传到带版本的那一处。 */
export function stage({
  directory,
  manifestDir,
  version,
  config,
  runner = rcloneRunner(),
  log = console.log,
}) {
  const source = runner.path(resolve(directory));
  const manifestSource = manifestDir
    ? runner.path(resolve(manifestDir))
    : undefined;
  run(
    runner,
    stagePlan({ source, manifestSource, bucket: config.bucket, version }),
    config,
    log,
  );
}

/** 把那一版的清单提为「最新」。 */
export function promote({
  version,
  config,
  runner = rcloneRunner(),
  log = console.log,
}) {
  run(runner, promotePlan({ bucket: config.bucket, version }), config, log);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 像客户端那样读镜像：`<base>/releases/latest/download/latest.json` 与它的签名，
 * 每个平台的 feed（地址、sha256 与 latest.json 一致、在 SHA256SUMS 里），feed 指的包
 * （sha512、大小、SHA256SUMS、minisign 签名）；所有地址都得在 `base` 之下——
 * 指回 GitHub 的镜像只镜像了检查。返回 `{ problems, checked, version }`。
 */
export async function verifyMirror({ base, publicKeyText, fetchImpl = fetch }) {
  const root = String(base).replace(/\/+$/, "");
  const problems = [];
  const checked = [];
  const bytesOf = async (url) => {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const latestUrl = `${root}/${PREFIX}/latest/download/latest.json`;
  let latestBytes;
  try {
    latestBytes = await bytesOf(latestUrl);
    const verdict = verifyDetached(
      publicKeyText,
      (await bytesOf(`${latestUrl}.sig`)).toString("utf8"),
      latestBytes,
    );
    if (!verdict.ok) problems.push(`latest.json signature: ${verdict.reason}`);
    else checked.push("latest.json minisign");
  } catch (error) {
    return { problems: [error.message], checked };
  }
  const latest = JSON.parse(latestBytes.toString("utf8"));
  const version = latest.version;
  const versioned = `${root}/${PREFIX}/download/v${version}`;
  let sums = new Map();
  try {
    const sumsBytes = await bytesOf(`${versioned}/SHA256SUMS`);
    const verdict = verifyDetached(
      publicKeyText,
      (await bytesOf(`${versioned}/SHA256SUMS.sig`)).toString("utf8"),
      sumsBytes,
    );
    if (!verdict.ok) problems.push(`SHA256SUMS signature: ${verdict.reason}`);
    sums = parseChecksums(sumsBytes.toString("utf8"));
  } catch (error) {
    problems.push(error.message);
  }
  const platforms = Object.entries(latest.platforms ?? {});
  if (platforms.length === 0) problems.push("latest.json offers no platform");
  for (const [platform, entry] of platforms) {
    const before = problems.length;
    for (const url of [entry.url, entry.feed?.url])
      if (!String(url ?? "").startsWith(`${root}/`))
        problems.push(`${platform}: ${url} is not on the mirror`);
    if (!entry.feed) {
      problems.push(`${platform}: latest.json names no feed`);
      continue;
    }
    try {
      const feedBytes = await bytesOf(entry.feed.url);
      const feedName = decodeURIComponent(entry.feed.url.split("/").pop());
      const digest = sha256Hex(feedBytes);
      if (digest !== entry.feed.sha256)
        problems.push(
          `${platform}: ${feedName} is not the feed latest.json names`,
        );
      if (sums.get(feedName) !== digest)
        problems.push(
          `${platform}: ${feedName} is not the feed SHA256SUMS lists`,
        );
      const file = parseFeed(feedBytes.toString("utf8")).files[0];
      const bundleUrl = new URL(file.url, entry.feed.url).toString();
      if (bundleUrl !== entry.url)
        problems.push(
          `${platform}: the feed names ${bundleUrl}, latest.json ${entry.url}`,
        );
      const bundle = await bytesOf(bundleUrl);
      if (sha512Base64(bundle) !== file.sha512)
        problems.push(
          `${platform}: ${file.url} does not match the feed's sha512`,
        );
      if (sums.get(file.url) !== sha256Hex(bundle))
        problems.push(`${platform}: ${file.url} does not match SHA256SUMS`);
      const verdict = verifyDetached(publicKeyText, entry.signature, bundle);
      if (!verdict.ok)
        problems.push(`${platform}: ${file.url} signature: ${verdict.reason}`);
    } catch (error) {
      problems.push(`${platform}: ${error.message}`);
    }
    if (problems.length === before) checked.push(`${platform} feed and bundle`);
  }
  return { problems, checked, version };
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv) {
  const [command] = argv;
  if (command === "verify") {
    const base = flag(argv, "base");
    const pubkey = flag(argv, "pubkey");
    if (!base || !pubkey) {
      console.error(
        "usage: node tools/release/mirror.mjs verify --base <url> --pubkey <minisign.pub>",
      );
      return 2;
    }
    const { problems, checked, version } = await verifyMirror({
      base,
      publicKeyText: readFileSync(pubkey, "utf8"),
    });
    console.log(`Mirror ${base}: release ${version ?? "?"}`);
    for (const line of checked) console.log(`  ✓ ${line}`);
    for (const problem of problems) console.error(`✗ ${problem}`);
    return problems.length > 0 ? 1 : 0;
  }
  const version = flag(argv, "version");
  if (!["stage", "promote"].includes(command) || !version) {
    console.error(
      "usage: node tools/release/mirror.mjs <stage --dir <dir> [--manifest <dir>] | promote> --version X.Y.Z",
    );
    return 2;
  }
  const config = mirrorConfig();
  if (config.skip) {
    console.log(`mirror not configured (${MIRROR_ENV.join(", ")}); skipped`);
    return 0;
  }
  if (config.problem) {
    console.error(`✗ ${config.problem}`);
    return 1;
  }
  try {
    if (command === "stage") {
      const directory = flag(argv, "dir");
      const manifestDir = flag(argv, "manifest");
      if (!directory || !existsSync(directory)) {
        console.error("stage needs --dir <release directory>");
        return 2;
      }
      stage({
        directory,
        manifestDir:
          manifestDir && existsSync(manifestDir) ? manifestDir : undefined,
        version,
        config,
      });
    } else {
      promote({ version, config });
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return 1;
  }
  console.log(`mirror ${command} ${version}: done`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main(process.argv.slice(2)));
}
