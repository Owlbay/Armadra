// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 生成的 `Spinner` 自带 `role="status"` 与英文的 `aria-label="Loading"`：读屏
 * 在中文界面里会念出一个英文词。每个调用处要么传本地化的 `aria-label`（它在
 * 告诉人「正在做什么」），要么 `aria-hidden`（旁边已经有字说明了）。`ui/` 是
 * 生成文件，不扫。
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

describe("Spinner 的无障碍名", () => {
  it("每个调用处都传本地化的 aria-label，或 aria-hidden", () => {
    const missing: string[] = [];
    let sites = 0;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<Spinner\b[^>]*?\/>/gs)) {
        sites += 1;
        const tag = match[0];
        // 表达式（`t(…)`、由 `t` 算出的变量）算本地化；写死的字面量不算。
        const labelled = /aria-label=\{/.test(tag);
        const hidden = /\baria-hidden\b/.test(tag);
        if (!labelled && !hidden) {
          const line = text.slice(0, match.index).split("\n").length;
          missing.push(`${relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(sites).toBeGreaterThanOrEqual(20);
    expect(missing).toEqual([]);
  });
});
