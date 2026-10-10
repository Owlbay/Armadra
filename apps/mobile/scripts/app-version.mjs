/**
 * 手机 / 平板 App 的版本与构建号，写给两个原生工程。
 *
 *   node apps/mobile/scripts/app-version.mjs write   # cap sync 之前（pnpm --filter @armadra/mobile sync 已带）
 *   node apps/mobile/scripts/app-version.mjs print   # → 1.0.0 (3185)
 *
 * App 与桌面 / 服务器同一条版本线（docs/guides/ci-release.md「版本规则」）：
 *
 * - 版本名来自 `apps/mobile/package.json` 的 `version`（与根版本一致，由
 *   `node tools/release/version.mjs set X.Y.Z` 统一改）。商店的
 *   `CFBundleShortVersionString` 不收预发布后缀，所以预发布版本只取 `X.Y.Z` 核心。
 * - 构建号单调递增：`ARMADRA_BUILD_NUMBER`（CI 显式给）优先，否则是当前提交的
 *   `git rev-list --count HEAD`——同一提交本地与 CI 算出同一个数，主干往前走只增不减。
 *   浅克隆数不出真实提交数，宁可报错也不写一个偏小的号。
 *
 * 写出的两份文件都不入库（`.gitignore`）：
 *
 * - `ios/version.generated.xcconfig`：`MARKETING_VERSION` 与 `CURRENT_PROJECT_VERSION`，
 *   经 `ios/version.xcconfig` 进工程的基础配置；外加的 `-xcconfig`（如个人签名配置）
 *   不设这两个键，叠加时不冲突。
 * - `android/app/version.properties`：`versionName` 与 `versionCode`，`app/build.gradle` 读它。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, "..");

export const IOS_VERSION_FILE = "ios/version.generated.xcconfig";
export const ANDROID_VERSION_FILE = "android/app/version.properties";

/** Android `versionCode` 的上限（Play 管理中心收的最大值）。 */
export const MAX_BUILD_NUMBER = 2_100_000_000;

const PLAIN_VERSION =
  /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-[0-9A-Za-z.-]+)?$/;

/** 校验并返回 App 的商店版本名：`X.Y.Z`，预发布后缀去掉；不是 semver 就抛。 */
export function parseMobileVersion(value) {
  const text = String(value ?? "").trim();
  const match = PLAIN_VERSION.exec(text);
  if (!match) throw new Error(`移动端版本 ${value} 不是 X.Y.Z[-预发布]`);
  return match[1];
}

/** `apps/mobile/package.json` 里的版本。 */
export function mobileVersion(root = mobileRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return parseMobileVersion(manifest.version);
}

function gitOutput(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function checkedBuildNumber(text, from) {
  if (!/^[1-9]\d*$/.test(text))
    throw new Error(`${from} 给的构建号 ${text} 不是正整数`);
  const value = Number(text);
  if (value > MAX_BUILD_NUMBER)
    throw new Error(`${from} 给的构建号 ${text} 超过 ${MAX_BUILD_NUMBER}`);
  return value;
}

/**
 * 构建号。`git(args)` 跑一条 git 命令并返回输出，测试注入；缺省在 `cwd` 里跑真 git。
 */
export function buildNumber({
  env = process.env,
  cwd = mobileRoot,
  git = (args) => gitOutput(cwd, args),
} = {}) {
  const given = String(env.ARMADRA_BUILD_NUMBER ?? "").trim();
  if (given !== "") return checkedBuildNumber(given, "ARMADRA_BUILD_NUMBER");
  let shallow;
  let count;
  try {
    shallow = git(["rev-parse", "--is-shallow-repository"]);
    count = git(["rev-list", "--count", "HEAD"]);
  } catch {
    throw new Error(
      "不在 git 检出里，数不出构建号：设 ARMADRA_BUILD_NUMBER（正整数）",
    );
  }
  if (shallow === "true")
    throw new Error(
      "浅克隆数不出真实的提交数：检出时取完整历史（fetch-depth: 0），或设 ARMADRA_BUILD_NUMBER",
    );
  return checkedBuildNumber(count, "git rev-list --count HEAD");
}

/** 两份原生版本文件的正文。 */
export function nativeVersionFiles({ version, build }) {
  const name = parseMobileVersion(version);
  const code = checkedBuildNumber(String(build), "构建号");
  const header =
    "由 apps/mobile/scripts/app-version.mjs 生成，不入库；改版本用 node tools/release/version.mjs set X.Y.Z";
  return {
    [IOS_VERSION_FILE]: `// ${header}\nMARKETING_VERSION = ${name}\nCURRENT_PROJECT_VERSION = ${code}\n`,
    [ANDROID_VERSION_FILE]: `# ${header}\nversionName=${name}\nversionCode=${code}\n`,
  };
}

/** 算出版本与构建号，写进两个原生工程。 */
export function writeNativeVersion({
  root = mobileRoot,
  env = process.env,
  git,
} = {}) {
  const version = mobileVersion(root);
  const build = buildNumber({ env, cwd: root, ...(git ? { git } : {}) });
  for (const [path, text] of Object.entries(
    nativeVersionFiles({ version, build }),
  ))
    writeFileSync(join(root, path), text);
  return { version, build };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode = "write"] = process.argv.slice(2);
  try {
    if (mode === "print") {
      console.log(`${mobileVersion()} (${buildNumber()})`);
    } else if (mode === "write") {
      const { version, build } = writeNativeVersion();
      console.log(`mobile version ${version} (${build}) → ios, android`);
    } else {
      console.error(
        "usage: node apps/mobile/scripts/app-version.mjs write|print",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
