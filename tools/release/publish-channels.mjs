/**
 * 分发渠道的清单：Homebrew cask、Scoop、winget、AUR 的 PKGBUILD 模板
 * （外部服务 §4，docs/guides/ci-release.md §3.1）。
 *
 *   node tools/release/publish-channels.mjs render \
 *     --sums SHA256SUMS --version X.Y.Z --repo owner/name --out <dir> \
 *     [--download-base URL] [--license LICENSE]
 *   node tools/release/publish-channels.mjs push --channel tap|scoop \
 *     --rendered <dir> --remote <git url> --version X.Y.Z [--dry-run]
 *
 * render 只读发布元数据：版本、仓库名与发布里的 SHA256SUMS。文件名来自
 * `artifacts.mjs` 的 `desktopAssets()`——和 stage-desktop / assemble 用的是同一个
 * 名字表，所以改名一处、清单跟着变；SHA256SUMS 里缺哪个产物就拒绝渲染，
 * 而不是写出一个哈希为空的 cask。模板在 `tools/release/templates/`，占位符是
 * `{{名字}}`；渲染后还剩占位符也拒绝。
 *
 * push 把渲染好的某个渠道的文件提交到它的仓库（tap / bucket）。令牌从环境变量
 * `CHANNEL_TOKEN` 读，作为 HTTP 头交给 git，不进 URL、不进日志。内容没变就不提交。
 * winget 不走这里：它向 microsoft/winget-pkgs 提 PR，用 wingetcreate（见 distribute.yml）。
 *
 * 只发稳定版：带 "-" 的预发布版本拒绝渲染（PKGBUILD 的 pkgver 也不认 "-"）。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopAssets } from "./artifacts.mjs";
import { parseChecksums } from "./checksums.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const TEMPLATE_DIR = join(root, "tools/release/templates");

/** winget 的包标识：发布者.产品。 */
export const WINGET_ID = "Owlbay.Armadra";

/** 每个渠道：模板 → 渲染目录里的相对路径。winget 的目录按 winget-pkgs 的布局。 */
export function channelFiles(version) {
  const [publisher, product] = WINGET_ID.split(".");
  const winget = `winget/manifests/${publisher[0].toLowerCase()}/${publisher}/${product}/${version}`;
  return {
    tap: [{ template: "armadra.rb", to: "homebrew/Casks/armadra.rb" }],
    scoop: [{ template: "armadra.json", to: "scoop/bucket/armadra.json" }],
    winget: [
      { template: "winget/version.yaml", to: `${winget}/${WINGET_ID}.yaml` },
      {
        template: "winget/installer.yaml",
        to: `${winget}/${WINGET_ID}.installer.yaml`,
      },
      {
        template: "winget/locale.en-US.yaml",
        to: `${winget}/${WINGET_ID}.locale.en-US.yaml`,
      },
    ],
    aur: [{ template: "PKGBUILD", to: "aur/PKGBUILD" }],
  };
}

/** 渠道在渲染目录里的根（push 时整个复制进渠道仓库的根）。 */
export const CHANNEL_ROOTS = { tap: "homebrew", scoop: "scoop" };

/**
 * 模板要的产物：键是 `<target>.<后缀>`，即发布名里版本之后的部分
 * （`Armadra_0.1.0_darwin-aarch64.dmg` → `darwin-aarch64.dmg`）。
 */
export const CHANNEL_ASSETS = [
  "darwin-aarch64.dmg",
  "darwin-x86_64.dmg",
  "windows-x86_64-portable.zip",
  "windows-aarch64-portable.zip",
  "windows-x86_64-setup.exe",
  "windows-aarch64-setup.exe",
  "linux-x86_64.deb",
  "linux-aarch64.deb",
];

/** 某个渠道键在这个版本里的发布名；必须是 desktopAssets() 里真有的名字。 */
export function assetName(version, key) {
  const name = `Armadra_${version}_${key}`;
  const target = /^[a-z]+-[a-z0-9_]+/.exec(key)?.[0] ?? "";
  const known = desktopAssets(version, target).map((asset) => asset.name);
  if (!known.includes(name))
    throw new Error(
      `${name} is not a bundle tools/release/artifacts.mjs publishes`,
    );
  return name;
}

/** 渲染需要的全部值。 */
export function channelValues({
  version,
  repo,
  sums,
  downloadBase,
  licenseSha256,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(
      `channels are published for stable versions only, not ${version}`,
    );
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo))
    throw new Error(`--repo must be owner/name, not ${repo}`);
  const digests = parseChecksums(sums);
  const values = {
    version,
    tag: `v${version}`,
    repo,
    owner: repo.split("/")[0],
    wingetId: WINGET_ID,
    downloadBase: (
      downloadBase ?? `https://github.com/${repo}/releases/download`
    ).replace(/\/+$/, ""),
    licenseSha256,
  };
  const missing = [];
  for (const key of CHANNEL_ASSETS) {
    const name = assetName(version, key);
    const digest = digests.get(name);
    if (!digest) {
      missing.push(name);
      continue;
    }
    values[`sha256:${key}`] = digest;
    values[`SHA256:${key}`] = digest.toUpperCase();
  }
  if (missing.length > 0)
    throw new Error(`SHA256SUMS does not list ${missing.join(", ")}`);
  return values;
}

/** 把模板里的 `{{名字}}` 换成值；有没换掉的就失败。 */
export function fill(template, values, name = "template") {
  const unknown = new Set();
  const text = template.replace(/\{\{([A-Za-z0-9:._-]+)\}\}/g, (all, key) => {
    if (values[key] === undefined || values[key] === "") {
      unknown.add(key);
      return all;
    }
    return values[key];
  });
  if (unknown.size > 0)
    throw new Error(`${name}: no value for ${[...unknown].join(", ")}`);
  return text;
}

/** 渲染全部渠道到 `out`，返回写出的相对路径。 */
export function render({
  version,
  repo,
  sums,
  out,
  downloadBase,
  license = readFileSync(join(root, "LICENSE")),
  templates = TEMPLATE_DIR,
}) {
  const values = channelValues({
    version,
    repo,
    sums,
    downloadBase,
    licenseSha256: createHash("sha256").update(license).digest("hex"),
  });
  const written = [];
  for (const files of Object.values(channelFiles(version))) {
    for (const file of files) {
      const text = fill(
        readFileSync(join(templates, file.template), "utf8"),
        values,
        file.template,
      );
      if (file.to.endsWith(".json")) JSON.parse(text);
      const path = join(out, file.to);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      written.push(file.to);
    }
  }
  return written;
}

function git(args, { cwd, token, allowFail = false } = {}) {
  const auth = token
    ? [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      ]
    : [];
  const result = spawnSync("git", [...auth, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0 && !allowFail)
    throw new Error(
      `git ${args[0]} failed (${result.status}): ${(result.stderr || "").trim()}`,
    );
  return result;
}

/**
 * 把某个渠道渲染好的文件提交到它的仓库并推送。
 *
 * 返回 `"pushed"`、`"unchanged"`，或 `--dry-run` 时的 `"would-push"`。
 */
export function push({
  channel,
  rendered,
  remote,
  version,
  token = process.env.CHANNEL_TOKEN ?? "",
  dryRun = false,
  author = { name: "Armadra Release", email: "release@armadra.invalid" },
}) {
  const sub = CHANNEL_ROOTS[channel];
  if (!sub) throw new Error(`push knows tap and scoop, not ${channel}`);
  const from = join(rendered, sub);
  if (!existsSync(from)) throw new Error(`${from} was not rendered`);
  const work = mkdtempSync(join(tmpdir(), `armadra-${channel}-`));
  try {
    git(["clone", "--depth", "1", remote, work], { token });
    cpSync(from, work, { recursive: true });
    git(["add", "-A"], { cwd: work });
    const diff = git(["diff", "--cached", "--quiet"], {
      cwd: work,
      allowFail: true,
    });
    if (diff.status === 0) return "unchanged";
    git(
      [
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "-m",
        `armadra ${version}`,
      ],
      { cwd: work },
    );
    if (dryRun) return "would-push";
    git(["push", "origin", "HEAD"], { cwd: work, token });
    return "pushed";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv) {
  const command = argv[0];
  if (command === "render") {
    const sums = option(argv, "--sums");
    const out = option(argv, "--out");
    const version = option(argv, "--version");
    const repo = option(argv, "--repo");
    if (!sums || !out || !version || !repo)
      throw new Error("render needs --sums, --version, --repo and --out");
    const license = option(argv, "--license");
    const written = render({
      version,
      repo,
      out,
      sums: readFileSync(sums, "utf8"),
      downloadBase: option(argv, "--download-base"),
      ...(license ? { license: readFileSync(license) } : {}),
    });
    for (const path of written) console.log(`rendered ${path}`);
    return 0;
  }
  if (command === "push") {
    const channel = option(argv, "--channel");
    const rendered = option(argv, "--rendered");
    const remote = option(argv, "--remote");
    const version = option(argv, "--version");
    if (!channel || !rendered || !remote || !version)
      throw new Error(
        "push needs --channel, --rendered, --remote and --version",
      );
    const outcome = push({
      channel,
      rendered,
      remote,
      version,
      dryRun: argv.includes("--dry-run"),
    });
    console.log(`${channel}: ${outcome}`);
    return 0;
  }
  console.error(
    "usage: publish-channels.mjs render --sums F --version V --repo O/N --out D [--download-base URL]\n" +
      "       publish-channels.mjs push --channel tap|scoop --rendered D --remote URL --version V [--dry-run]",
  );
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`publish-channels: ${error.message}`);
    process.exit(1);
  }
}
