// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 生成的 `CommandInput` 没有焦点环（见 `tabs-focus.ts`）：每个调用处都要带
 * `COMMAND_INPUT_FOCUS`，新加的也一样。`ui/` 是生成文件，不扫。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === "ui" && directory === SRC ? [] : walk(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe("CommandInput 焦点环", () => {
  it("每个调用处都带 COMMAND_INPUT_FOCUS", () => {
    const sites = walk(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("<CommandInput"),
    );
    expect(sites.length).toBeGreaterThanOrEqual(4);
    const missing = sites.filter((file) => {
      const text = readFileSync(file, "utf8");
      const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
      return (
        count(/<CommandInput\b/g) >
        count(/<CommandInput\s+className=\{COMMAND_INPUT_FOCUS\}/g)
      );
    });
    expect(missing.map((file) => relative(SRC, file))).toEqual([]);
  });
});
