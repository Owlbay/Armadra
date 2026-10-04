/**
 * 发布说明的正文来自 `CHANGELOG.md` 里本版那一节。
 *
 *   node tools/release/changelog.mjs check --version X.Y.Z [--released] [--file CHANGELOG.md]
 *   node tools/release/changelog.mjs print --version X.Y.Z [--file CHANGELOG.md]
 *
 * 一节从 `## X.Y.Z` 开始（后面可以跟「（未发布）」或「（2026-10-10）」这样的括注），
 * 到下一个二级标题为止。没有这一节就是错：发布说明不再由 GitHub 按 PR 生成，
 * 缺了这一节的发布等于没有说明。`--released` 还要求标题不再标「未发布」——
 * 真正建 Release 的那一次（release.yml 的 publish）带它，分支演练不带。
 *
 * 兼容性围栏不在这里加：`assemble.mjs` 拿到正文后由 `releaseNote()` 追加。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const CHANGELOG_FILE = "CHANGELOG.md";

/** 标题里表示「还没发」的括注。 */
const UNRELEASED = /未发布|unreleased/i;

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 找 `version` 那一节：`{ heading, body, released }`；没有就是 `null`。
 * `body` 去掉了标题行与首尾空行，三级标题原样保留。
 */
export function changelogSection(text, version) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const start = new RegExp(`^##\\s+v?${escape(version)}(?=$|[\\s（(])`);
  const index = lines.findIndex((line) => start.test(line));
  if (index < 0) return null;
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const heading = lines[index].replace(/^##\s+/, "").trim();
  const body = lines
    .slice(index + 1, end)
    .join("\n")
    .trim();
  return { heading, body, released: !UNRELEASED.test(heading) };
}

/**
 * 发布说明的正文，或说清楚为什么没有。`requireReleased` 时标「未发布」的一节
 * 也算错，免得把「未发布」三个字发出去。
 */
export function releaseNotes(text, version, { requireReleased = false } = {}) {
  const section = changelogSection(text, version);
  if (!section)
    return {
      problem: `${CHANGELOG_FILE} has no "## ${version}" section; write the release notes there before releasing`,
    };
  if (section.body === "")
    return { problem: `${CHANGELOG_FILE} section ${version} is empty` };
  if (requireReleased && !section.released)
    return {
      problem: `${CHANGELOG_FILE} section "${section.heading}" is still marked unreleased; put the release date in its heading`,
    };
  return { notes: section.body, section };
}

/** 读文件再取一节；文件不在也是一个 problem，不抛。 */
export function readReleaseNotes({
  file = resolve(root, CHANGELOG_FILE),
  version,
  requireReleased = false,
}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { problem: `${file} cannot be read: ${error.message}` };
  }
  return releaseNotes(text, version, { requireReleased });
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(argv) {
  const [command] = argv;
  const version = flag(argv, "version");
  if (!["check", "print"].includes(command) || !version) {
    console.error(
      "usage: node tools/release/changelog.mjs <check|print> --version X.Y.Z [--released] [--file CHANGELOG.md]",
    );
    return 2;
  }
  const file = flag(argv, "file");
  const result = readReleaseNotes({
    ...(file ? { file: resolve(file) } : {}),
    version,
    requireReleased: argv.includes("--released"),
  });
  if (result.problem) {
    console.error(`✗ ${result.problem}`);
    return 1;
  }
  if (command === "print") process.stdout.write(`${result.notes}\n`);
  else console.log(`${CHANGELOG_FILE}: ${result.section.heading}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
