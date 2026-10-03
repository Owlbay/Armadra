// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 设计系统 §7 第 8 步的守卫：下面这些文件已经把手写 `<button>` 换成
 * `Button` / `IconButton` / `Toggle`（焦点环、禁用态、命中区由生成组件统一给），
 * 之后不许再写回去。其余文件在 G3-11 收口时并进这张表。测试文件不算。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const FILES = [
  "panels/settings/SettingsRow.tsx",
  "panels/ResponsiveDialog.tsx",
  "nodes/ContextReadsBadge.tsx",
  "nodes/DeliveryQueueBadge.tsx",
  "nodes/DependencyWaitBadge.tsx",
  "nodes/DriveBadge.tsx",
  "nodes/SupervisionBadge.tsx",
  "shell/MobileBottomNav.tsx",
  "shell/ClusterUsage.tsx",
  "panels/ExplorerDrawer.tsx",
  "panels/FileTree.tsx",
  "panels/ProjectSearchPanel.tsx",
  "panels/ResourceDrawer.tsx",
  "panels/QuickOpen.tsx",
  "panels/CloneRepoDialog.tsx",
  "panels/NewFolderDialog.tsx",
  "panels/FileEntryDialog.tsx",
  "showcase/sections/components.tsx",
  "showcase/sections/states.tsx",
];
const DIRECTORIES = ["panels/usage", "panels/git", "sidebar"];

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function guarded(): string[] {
  const files = [
    ...FILES.map((file) => join(SRC, file)),
    ...DIRECTORIES.flatMap((directory) => walk(join(SRC, directory))),
  ];
  return files.filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
  );
}

describe("手写 <button> 守卫（设计系统 §7 第 8 步）", () => {
  it("名单里的文件都在", () => {
    for (const file of FILES)
      expect(statSync(join(SRC, file)).isFile(), file).toBe(true);
    // 目录也真的被扫到了，而不是空跑
    expect(guarded().length).toBeGreaterThan(FILES.length + 40);
  });

  it("名单里的文件一处 <button 也没有", () => {
    const offenders = guarded().filter((file) =>
      readFileSync(file, "utf8").includes("<button"),
    );
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
