// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 字号阶梯是 17 / 15 / 13 / 11（`tokens.css`），界面里不出现 11px 以下。
 * 这里扫源码里写死的 8–10px，免得有人为了塞进一个小徽标又退回去。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const TOO_SMALL = /text-\[(?:[0-9]|10)px\]|font-size:\s*(?:[0-9]|10)px/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("字号阶梯", () => {
  it("源码里没有 11px 以下的字号", () => {
    const offenders = sources(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          TOO_SMALL.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
