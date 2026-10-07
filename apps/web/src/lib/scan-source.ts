import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * 扫描测试共用的小工具（只给 `*.test.ts` 用，运行在 node 环境）：列出
 * `apps/web/src` 下的功能代码、去掉注释、算出一处命中的行号。
 *
 * 「功能代码」= `.ts` / `.tsx`，不含测试、shadcn 生成的 `ui/`（顶层那个）与
 * showcase 的样例数据 `showcase/fixtures/`。
 */

/** 路径统一成 `/` 分隔，Windows 上也一样。 */
export function posix(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

export function featureSources(root: string): string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (directory === root && name === "ui") return [];
        return walk(path);
      }
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  return walk(root);
}

/**
 * 把注释换成等长的空白（换行保留）：偏移与行号不变，注释里举例的标签、
 * 色值不会被当成命中。字符串里的 `//`（如 `"http://…"`）不当注释。
 */
export function blankComments(source: string): string {
  let out = "";
  let index = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (index < source.length) {
    const rest = source.slice(index);
    const quote = /^(["'`])/.exec(rest)?.[1];
    if (quote !== undefined) {
      let end = index + 1;
      while (end < source.length && source[end] !== quote) {
        if (source[end] === "\\") end += 1;
        end += 1;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
    } else if (rest.startsWith("//")) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
    } else if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

export function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
