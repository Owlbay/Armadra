import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changelogSection,
  readReleaseNotes,
  releaseNotes,
} from "./changelog.mjs";
import { workspaceVersion } from "./version.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

const SAMPLE = `# 更新记录

说明文字。

## 0.3.0（未发布）

### 新增

- 第三版。

## 0.2.0（2026-10-10）

- 第二版。
- \`armadra\` 换成 Electron。

## 0.1.0

- 第一版。
`;

test("取本版一节：标题括注、三级标题保留、到下一个二级标题为止", () => {
  const section = changelogSection(SAMPLE, "0.3.0");
  assert.equal(section.heading, "0.3.0（未发布）");
  assert.equal(section.body, "### 新增\n\n- 第三版。");
  assert.equal(section.released, false);
  const second = changelogSection(SAMPLE, "0.2.0");
  assert.equal(second.released, true);
  assert.equal(second.body, "- 第二版。\n- `armadra` 换成 Electron。");
  assert.equal(changelogSection(SAMPLE, "0.1.0").body, "- 第一版。");
});

test("版本号是整段比较：0.2.0 不会命中 0.2.0-rc.1 或 0.2.01", () => {
  const text = "## 0.2.0-rc.1\n\n- 候选\n\n## 0.2.01\n\n- 别的\n";
  assert.equal(changelogSection(text, "0.2.0"), null);
  assert.equal(changelogSection(text, "0.2.0-rc.1").body, "- 候选");
});

test("CRLF 的文件读出来与 LF 一样", () => {
  const section = changelogSection(SAMPLE.replace(/\n/g, "\r\n"), "0.2.0");
  assert.equal(section.body, "- 第二版。\n- `armadra` 换成 Electron。");
});

test("没有这一节、这一节是空的、发布时还标着未发布，都是错", () => {
  assert.match(releaseNotes(SAMPLE, "9.9.9").problem, /no "## 9\.9\.9"/);
  assert.match(
    releaseNotes("## 1.0.0\n\n## 0.9.0\n- x\n", "1.0.0").problem,
    /is empty/,
  );
  assert.match(
    releaseNotes(SAMPLE, "0.3.0", { requireReleased: true }).problem,
    /still marked unreleased/,
  );
  assert.equal(releaseNotes(SAMPLE, "0.3.0").notes, "### 新增\n\n- 第三版。");
  assert.equal(
    releaseNotes(SAMPLE, "0.2.0", { requireReleased: true }).notes,
    "- 第二版。\n- `armadra` 换成 Electron。",
  );
});

test("仓库自己的 CHANGELOG.md 有当前版本的一节", () => {
  const result = readReleaseNotes({ version: workspaceVersion() });
  assert.equal(result.problem, undefined);
  assert.ok(result.notes.length > 0);
});

test("assemble --changelog：没有本版一节就在签名之前失败，目录不动", () => {
  const directory = mkdtempSync(join(tmpdir(), "armadra-changelog-"));
  try {
    const changelog = `${directory}.md`;
    writeFileSync(changelog, "## 0.1.0\n\n- 旧的\n");
    writeFileSync(join(directory, "armadra-web_0.2.0.tar.gz"), "web");
    const run = spawnSync(
      process.execPath,
      [
        join(root, "tools/release/assemble.mjs"),
        "--dir",
        directory,
        "--version",
        "0.2.0",
        "--repo",
        "Owlbay/Armadra",
        "--changelog",
        changelog,
      ],
      { encoding: "utf8" },
    );
    rmSync(changelog, { force: true });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /no "## 0\.2\.0" section/);
    assert.deepEqual(readdirSync(directory), ["armadra-web_0.2.0.tar.gz"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("assemble --changelog 与 --notes-from 只能给一个", () => {
  const run = spawnSync(
    process.execPath,
    [
      join(root, "tools/release/assemble.mjs"),
      "--dir",
      tmpdir(),
      "--version",
      "0.2.0",
      "--repo",
      "Owlbay/Armadra",
      "--changelog",
      "CHANGELOG.md",
      "--notes-from",
      "x.md",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 2);
});

test("assemble --changelog：说明正文是本版一节，围栏照旧追加", () => {
  const directory = mkdtempSync(join(tmpdir(), "armadra-changelog-"));
  const changelog = `${directory}.md`;
  const note = `${directory}-note.md`;
  try {
    writeFileSync(changelog, SAMPLE);
    const run = spawnSync(
      process.execPath,
      [
        join(root, "tools/release/assemble.mjs"),
        "--dir",
        directory,
        "--version",
        "0.2.0",
        "--repo",
        "Owlbay/Armadra",
        "--changelog",
        changelog,
        "--require-released",
        "--note",
        note,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, ARMADRA_RELEASE_SIGNING_KEY: "" },
      },
    );
    // 空目录本身凑不成发布（缺清单），但说明已经写出来了。
    const text = readFileSync(note, "utf8");
    assert.match(text, /- 第二版。\n- `armadra` 换成 Electron。/);
    assert.match(text, /```armadra-compatibility\n/);
    assert.doesNotMatch(text, /第三版|第一版/);
    assert.ok(run.status === 0 || run.status === 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(changelog, { force: true });
    rmSync(note, { force: true });
  }
});
