// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 确认框一律经 `ResponsiveAlertDialog*`（≤767 贴底、按钮全宽）。只有它自己
 * （`panels/ResponsiveDialog.tsx`）可以直接用生成的 `ui/alert-dialog`；`ui/`
 * 是生成文件，不扫。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === "ui" && directory === SRC ? [] : walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("确认框的手机形态", () => {
  it("除 ResponsiveDialog 外没有直接 import ui/alert-dialog 的", () => {
    const offenders = walk(SRC)
      .filter((file) => !file.endsWith(join("panels", "ResponsiveDialog.tsx")))
      .filter((file) =>
        /from "[^"]*ui\/alert-dialog"/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
