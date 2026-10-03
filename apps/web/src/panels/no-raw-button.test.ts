// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 设计系统 §7 第 8 步的守卫：功能代码里不手写 `<button>`，一律用 `Button` /
 * `IconButton` / `Toggle`（焦点环、禁用态、命中区由生成组件统一给）。
 *
 * G2-11 先收了一张名单，G3-11 把其余文件收完后改成扫整个 `src/`：只放过
 * shadcn 生成的 `ui/`（`Button` 自己就是一个 `<button>`）与测试文件。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const GENERATED = join(SRC, "ui");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return path === GENERATED ? [] : walk(path);
    return [path];
  });
}

function guarded(): string[] {
  return walk(SRC).filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file),
  );
}

describe("手写 <button> 守卫（设计系统 §7 第 8 步）", () => {
  it("真的扫到了功能代码，而不是空跑", () => {
    // Windows 上 relative() 给反斜杠，统一成 / 再比。
    const files = guarded().map((file) =>
      relative(SRC, file).split(sep).join("/"),
    );
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("panels/settings/SettingsRow.tsx");
    expect(files).toContain("shell/MobileFocusPage.tsx");
    expect(files.some((file) => file.startsWith("ui/"))).toBe(false);
  });

  it("src/ 里（ui/ 与测试除外）一处 <button 也没有", () => {
    const offenders = guarded().filter((file) =>
      readFileSync(file, "utf8").includes("<button"),
    );
    expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
  });
});
