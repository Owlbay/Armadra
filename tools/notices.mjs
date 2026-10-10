/**
 * THIRD_PARTY_NOTICES.md：随发行包分发的第三方声明（外部服务 §11.3）。
 *
 *   node tools/notices.mjs            重新生成根目录的 THIRD_PARTY_NOTICES.md
 *   node tools/notices.mjs --check    与仓库里的那份逐字节比较，不同就失败
 *   node tools/notices.mjs --scan apps/desktop/out
 *                                     查构建产物里打进去的第三方包都在声明里
 *
 * 来源是 `pnpm licenses list --prod --json`：工作区所有包的生产依赖。每个包的
 * 许可证正文从它安装目录里的 LICENSE / NOTICE 等文件原样读出——MIT、BSD、
 * Apache 都要求随二进制带上版权行与许可证全文，只写一个 SPDX 缩写不够。
 *
 * 不在 npm 生产依赖里、但同样随包分发的三样东西在文件开头单列：Electron 与
 * Chromium 的声明由 `apps/desktop/scripts/after-pack.mjs` 放在可执行文件旁
 * （macOS 是 `Contents/Resources/`），`@armadra/agent`（ama）自带的声明随
 * `resources/agent/` 一起带，Armadra 自己的 LICENSE。
 *
 * `--prod` 漏掉一类：构建期依赖（devDependencies）里被打包器整段打进 `out/` 的
 * 包——页面 CSS 里的 tailwindcss 与 tw-animate-css 就是。它们由 `BUNDLED_DEV_DEPENDENCIES`
 * 显式列出、照样读声明文件并进同一张表。名单是否够全由 `--scan` 对构建产物核：
 * rolldown 在未压缩的 JS 里给每个模块留 `//#region <路径>` 注释，CSS 里留
 * `/*! 包名 v版本` 的版权头；凡是从 `node_modules` 来的包，既不在 `--prod` 里、
 * 也不在名单里、又不是工作区自己的 `@armadra/*`，就失败。release.yml 打完包跑它。
 *
 * 输出只取决于锁文件装出来的东西：按名字与版本排序，不写绝对路径与时间，
 * 换行统一为 LF。所以 `--check` 能在三个平台的 CI 上防漂移——依赖变了却没有
 * 重新生成，`pnpm check` 就红。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

/** 包目录里算作「声明」的文件：LICENSE / LICENCE / COPYING / NOTICE 及其扩展名变体。 */
const NOTICE_NAME = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

/** 随 Electron 二进制分发、after-pack.mjs 负责放进包里的两份声明。 */
export const ELECTRON_NOTICES = [
  "LICENSE.electron.txt",
  "LICENSES.chromium.html",
];

/**
 * 不是生产依赖、却被打包器整段打进 `apps/desktop/out/` 的包（工作区目录 + 包名）。
 * 版本、许可证与声明文件从装好的那一份读。
 *
 * - tailwindcss：页面 CSS 的 preflight 与工具类由它生成，产物里带它的版权头。
 * - tw-animate-css：`apps/web/src/index.css` `@import` 它的动画类，原样进 CSS。
 */
export const BUNDLED_DEV_DEPENDENCIES = [
  { workspace: "apps/web", name: "tailwindcss" },
  { workspace: "apps/web", name: "tw-animate-css" },
];

/** 读一个已装包的 package.json 成为与 `packagesFrom` 同形的一行。 */
function packageRecord(directory) {
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  const author =
    typeof manifest.author === "string"
      ? manifest.author
      : (manifest.author?.name ?? "");
  return {
    name: manifest.name,
    version: manifest.version,
    license:
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? "Unknown"),
    author,
    homepage: manifest.homepage ?? "",
    path: directory,
  };
}

/** `BUNDLED_DEV_DEPENDENCIES` 装出来的样子；没装就抛（`pnpm install` 之后才跑）。 */
export function bundledDevPackages(
  cwd = root,
  list = BUNDLED_DEV_DEPENDENCIES,
) {
  return list.map(({ workspace, name }) => {
    const directory = join(cwd, workspace, "node_modules", name);
    if (!existsSync(join(directory, "package.json")))
      throw new Error(
        `${name} is listed as bundled from ${workspace} but is not installed there`,
      );
    return packageRecord(realpathSync(directory));
  });
}

/**
 * 构建产物里来自 `node_modules` 的包：`[{ name, version }]`，按名字与版本排序去重。
 *
 * JS 认 rolldown 的 `//#region <相对路径>` 注释，路径里最后一个 `node_modules/`
 * 之后的一段（或带作用域的两段）就是包名，版本读那个目录的 package.json——路径
 * 相对的是构建时的工作目录，所以按 `resolveFrom`（缺省仓库根）找。CSS 认
 * `/*! 包名 v版本` 这种保留注释。
 */
export function scanBundle(outDir, { resolveFrom = root } = {}) {
  const found = new Map();
  const add = (name, version) =>
    found.set(`${name}@${version}`, { name, version });
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(c|m)?js$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/^\/\/#region (\S+)$/gm)) {
          const region = match[1].replace(/\\/g, "/");
          const at = region.lastIndexOf("node_modules/");
          if (at < 0) continue;
          const rest = region.slice(at + "node_modules/".length).split("/");
          const name = rest[0].startsWith("@")
            ? `${rest[0]}/${rest[1]}`
            : rest[0];
          const relativeDir =
            `${region.slice(0, at)}node_modules/${name}`.replace(
              /^(\.\.\/)+/,
              "",
            );
          const manifest = join(resolveFrom, relativeDir, "package.json");
          const version = existsSync(manifest)
            ? JSON.parse(readFileSync(manifest, "utf8")).version
            : "?";
          add(name, version);
        }
      } else if (entry.name.endsWith(".css")) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(
          /\/\*!\s*(@?[a-z0-9][\w./-]*)\s+v(\d+\.\d+\.\d+[\w.-]*)/gi,
        ))
          add(match[1], match[2]);
      }
    }
  };
  walk(outDir);
  return [...found.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en") ||
      a.version.localeCompare(b.version, "en"),
  );
}

/**
 * 扫出来却不在声明里的包：既不在 `--prod` 的表里、也不在显式名单里，
 * 也不是工作区自己的 `@armadra/*`。
 */
export function unlistedBundled({ scanned, listing, bundled = [] }) {
  const covered = new Set(
    [...packagesFrom(listing), ...bundled].map((p) => `${p.name}@${p.version}`),
  );
  return scanned.filter(
    (p) =>
      !p.name.startsWith("@armadra/") && !covered.has(`${p.name}@${p.version}`),
  );
}

/** 跑 `pnpm licenses list -r --prod --json`，返回解析后的对象（pnpm 12 起根目录不再缺省递归，要显式 `-r`）。 */
export function pnpmLicenses(cwd = root) {
  const result = spawnSync(
    "pnpm",
    ["licenses", "list", "-r", "--prod", "--json"],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // Windows 上 pnpm 是 .cmd，不经 shell 起不来。
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0)
    throw new Error(
      `pnpm licenses list failed (${result.status}): ${result.stderr || result.error?.message || ""}`,
    );
  return withResolvedPeers(JSON.parse(result.stdout));
}

/**
 * pnpm 12 的 `licenses list` 不列已解析的 peer 与可选依赖（例如 `debug` 的
 * `supports-color`），它们照样装进 node_modules、随应用发出去。这里从已列出的
 * 每个包出发，按 pnpm 的目录布局（依赖是同一个 `node_modules` 下的兄弟目录）
 * 补上它实际装到的 peer 与可选依赖，以及它们自己的依赖，按许可证并回原来的分组。
 */
export function withResolvedPeers(listing) {
  const seen = new Set();
  for (const entries of Object.values(listing))
    for (const entry of entries)
      entry.versions.forEach((version) => seen.add(`${entry.name}@${version}`));
  const queue = Object.values(listing)
    .flat()
    .flatMap((entry) => entry.paths ?? []);
  while (queue.length > 0) {
    const path = queue.shift();
    const manifest = readManifest(path);
    if (manifest === null) continue;
    // 只有 peerDependenciesMeta 没有 peerDependencies 的写法也算（debug 就是）。
    const names = [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
      manifest.peerDependenciesMeta,
    ].flatMap((field) => Object.keys(field ?? {}));
    const siblings = path.slice(
      0,
      path.lastIndexOf("/node_modules/") + "/node_modules".length,
    );
    for (const name of names) {
      const candidate = join(siblings, name);
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      const pkg = readManifest(real);
      if (pkg === null || pkg.name.startsWith("@armadra/")) continue;
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const license = typeof pkg.license === "string" ? pkg.license : "Unknown";
      (listing[license] ??= []).push({
        name: pkg.name,
        versions: [pkg.version],
        paths: [real],
        license,
        author: typeof pkg.author === "string" ? pkg.author : pkg.author?.name,
        homepage: pkg.homepage,
      });
      queue.push(real);
    }
  }
  return listing;
}

/**
 * 包自己 package.json 里声明的许可证；没声明就是 Unknown。pnpm 12 在没声明时
 * 会去猜 LICENSE 正文，同一个包在不同机器上猜出不同结果（khroma：本机 MIT、
 * CI Unknown），声明文件就跟着平台变。读不到 package.json（单测里的假路径）时
 * 返回 null，交回 pnpm 给的值。
 */
function declaredLicense(directory) {
  if (!directory) return null;
  const manifest = readManifest(directory);
  if (manifest === null) return null;
  if (typeof manifest.license === "string") return manifest.license;
  if (typeof manifest.license?.type === "string") return manifest.license.type;
  const first = Array.isArray(manifest.licenses) ? manifest.licenses[0] : null;
  return typeof first?.type === "string" ? first.type : "Unknown";
}

/**
 * 包声明的主页；没写 homepage 时按 GitHub 仓库推成 `…#readme`（pnpm 11 的做法，
 * pnpm 12 不再推导）。读不到 package.json 时返回 null。
 */
function declaredHomepage(directory) {
  if (!directory) return null;
  const manifest = readManifest(directory);
  if (manifest === null) return null;
  if (typeof manifest.homepage === "string") return manifest.homepage;
  const repository =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
  if (typeof repository !== "string") return "";
  const match =
    /^(?:github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository) ??
    /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repository);
  return match ? `https://github.com/${match[1]}#readme` : "";
}

function readManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** 把一段文本统一成 LF、去掉行尾空白与首尾空行。 */
function normalize(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

/** 一个包目录里的声明文件，按名字排序；`[{name, text}]`。 */
export function noticeFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && NOTICE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      text: normalize(readFileSync(join(directory, name), "utf8")),
    }))
    .filter((file) => file.text !== "");
}

/**
 * `pnpm licenses list --json` 的输出（按许可证分组）→ 按名字、版本排好的包表。
 *
 * 一个名字装了几个版本时 pnpm 给的是并列的 `versions` 与 `paths`，这里拆成
 * 每个版本一条，各读各的声明。工作区自己的 `@armadra/*` 不算第三方。
 */
export function packagesFrom(listing) {
  const packages = [];
  for (const [license, entries] of Object.entries(listing)) {
    for (const entry of entries) {
      if (entry.name.startsWith("@armadra/")) continue;
      entry.versions.forEach((version, index) => {
        const path = entry.paths?.[index] ?? entry.paths?.[0] ?? "";
        packages.push({
          name: entry.name,
          version,
          license: declaredLicense(path) ?? entry.license ?? license,
          author: typeof entry.author === "string" ? entry.author : "",
          homepage: entry.homepage || declaredHomepage(path) || "",
          path,
        });
      });
    }
  }
  return packages.sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
  );
}

/** 比正文里最长的反引号串多一个，正文里有 ``` 也不会提前闭合。 */
function fenceFor(text) {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/** 读某个已安装包的版本；没装就是 ""。 */
function installedVersion(directory) {
  const manifest = join(directory, "package.json");
  if (!existsSync(manifest)) return "";
  return JSON.parse(readFileSync(manifest, "utf8")).version ?? "";
}

/**
 * 生成 THIRD_PARTY_NOTICES.md 的全文。
 *
 * `listing` 是 `pnpm licenses list --prod --json` 的结果；`agentVersion` 是随包
 * 打进 `resources/agent/` 的 `@armadra/agent` 版本（它是桌面壳的 devDependency，
 * 不在 `--prod` 里，自带声明文件）。
 */
export function renderNotices({
  listing,
  bundled = [],
  agentVersion = "",
  read = noticeFiles,
}) {
  const seen = new Set();
  const packages = [...packagesFrom(listing), ...bundled]
    .filter((pkg) => {
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.version < b.version ? -1 : a.version > b.version ? 1 : 0),
    );
  const lines = [
    "# Third-party notices",
    "",
    "<!-- Generated by `node tools/notices.mjs` from `pnpm licenses list --prod --json` plus the build-time packages bundled into the application (`BUNDLED_DEV_DEPENDENCIES`). Do not edit by hand; `node tools/notices.mjs --check` runs in `pnpm check`. -->",
    "",
    "Armadra is distributed under the MIT License (see `LICENSE`). It includes the third-party software listed below.",
    "",
    "## Shipped beside the application",
    "",
    "- **Electron and Chromium.** The notices Electron and Chromium require to accompany their binaries are shipped as `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable (on macOS in `Armadra.app/Contents/Resources/`).",
  ];
  if (agentVersion)
    lines.push(
      `- **ama (\`@armadra/agent\` ${agentVersion}).** Its own license and third-party notices are shipped in \`resources/agent/\` as \`LICENSE\` and \`THIRD_PARTY_NOTICES.md\`.`,
    );
  lines.push("", `## npm packages (${packages.length})`, "");
  for (const pkg of packages) {
    lines.push(`### ${pkg.name}@${pkg.version}`, "", `License: ${pkg.license}`);
    if (pkg.author) lines.push(`Author: ${normalize(pkg.author)}`);
    if (pkg.homepage) lines.push(`Homepage: ${pkg.homepage}`);
    lines.push("");
    const files = read(pkg.path);
    if (files.length === 0) {
      lines.push(
        "The package ships no license file; see its homepage for the license terms.",
        "",
      );
      continue;
    }
    for (const file of files) {
      const fence = fenceFor(file.text);
      lines.push(`${file.name}:`, "", `${fence}text`, file.text, fence, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** 生成当前检出的声明全文。 */
export function currentNotices(cwd = root) {
  return renderNotices({
    listing: pnpmLicenses(cwd),
    bundled: bundledDevPackages(cwd),
    agentVersion: installedVersion(
      join(cwd, "apps/desktop/node_modules/@armadra/agent"),
    ),
  });
}

function scan(outDir) {
  const scanned = scanBundle(outDir);
  const missing = unlistedBundled({
    scanned,
    listing: pnpmLicenses(root),
    bundled: bundledDevPackages(root),
  });
  if (missing.length > 0) {
    for (const pkg of missing)
      console.error(
        `✗ ${pkg.name}@${pkg.version} is bundled into ${outDir} but not in ${NOTICES_FILE}`,
      );
    console.error(
      "Add it to BUNDLED_DEV_DEPENDENCIES in tools/notices.mjs (or make it a production dependency) and regenerate.",
    );
    return 1;
  }
  console.log(
    `${scanned.length} bundled package(s) in ${outDir}, all in ${NOTICES_FILE}`,
  );
  return 0;
}

function main(argv) {
  const scanAt = argv.indexOf("--scan");
  if (scanAt >= 0) {
    const outDir = argv[scanAt + 1];
    if (!outDir || !existsSync(outDir)) {
      console.error(
        "usage: node tools/notices.mjs --scan <built out/ directory>",
      );
      return 2;
    }
    return scan(outDir);
  }
  const target = join(root, NOTICES_FILE);
  const expected = currentNotices(root);
  if (argv.includes("--check")) {
    const actual = existsSync(target)
      ? readFileSync(target, "utf8").replace(/\r\n/g, "\n")
      : "";
    if (actual !== expected) {
      console.error(
        `${NOTICES_FILE} is out of date with the installed dependencies; run \`node tools/notices.mjs\` and commit the result.`,
      );
      // 只在 CI 上不一致时，没有第一处差异就无从查起。
      const have = actual.split("\n");
      const want = expected.split("\n");
      const line = want.findIndex((text, index) => have[index] !== text);
      const at = line === -1 ? want.length : line;
      console.error(
        `first difference at line ${at + 1}:\n  committed: ${have[at] ?? "<end>"}\n  generated: ${want[at] ?? "<end>"}`,
      );
      return 1;
    }
    console.log(`${NOTICES_FILE} is up to date`);
    return 0;
  }
  writeFileSync(target, expected);
  console.log(`wrote ${NOTICES_FILE}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
