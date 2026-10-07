// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blankComments,
  featureSources,
  lineOf,
  posix,
  readSource,
} from "../lib/scan-source";

/**
 * 功能代码里不手写表单原语（工程规范化 §4.2）：`<input>`、`<select>`、
 * `<textarea>`、`<dialog>` 一律走 `ui/` 的 `Input` / `Checkbox` / `Select` /
 * `Textarea` / `ResponsiveDialog`——焦点环、禁用态、命中区与可访问名由生成
 * 组件统一给。
 *
 * 放过两类：`type="file"` / `type="hidden"` 的 `<input>`（本来就没有可见外观），
 * 以及标了 `ui-exempt: 理由` 注释（出现在标签前三行内）的个别位置。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const TAG = /<(input|select|textarea|dialog)(?=[\s/>])/g;
const EXEMPT = /ui-exempt:/;

interface RawFormHit {
  readonly tag: string;
  readonly line: number;
}

function rawFormElements(source: string): RawFormHit[] {
  const code = blankComments(source);
  const lines = source.split("\n");
  return [...code.matchAll(TAG)].flatMap((match) => {
    const offset = match.index ?? 0;
    const tag = match[1]!;
    const line = lineOf(code, offset);
    if (tag === "input") {
      const attributes = code.slice(offset, code.indexOf(">", offset) + 1);
      if (/\btype=["'{]*(?:file|hidden)\b/.test(attributes)) return [];
    }
    const above = lines.slice(Math.max(0, line - 4), line).join("\n");
    return EXEMPT.test(above) ? [] : [{ tag, line }];
  });
}

describe("手写表单原语守卫", () => {
  it("真的扫到了功能代码，而不是空跑", () => {
    const files = featureSources(SRC).map((file) => posix(SRC, file));
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("session/SignIn.tsx");
    expect(files.some((file) => file.startsWith("ui/"))).toBe(false);
  });

  it("src/ 里（ui/ 与测试除外）没有手写的 input / select / textarea / dialog", () => {
    const offenders = featureSources(SRC).flatMap((file) =>
      rawFormElements(readSource(file)).map(
        (hit) => `${posix(SRC, file)}:${hit.line} <${hit.tag}>`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("扫描器真的扫得到违规", () => {
  it("抓得到四种原生元素，行号对得上", () => {
    const sample = [
      "export const A = () => (",
      "  <div>",
      '    <input type="text" />',
      "    <select>",
      "      <option />",
      "    </select>",
      "    <textarea />",
      "    <dialog open />",
      "  </div>",
      ");",
    ].join("\n");
    expect(rawFormElements(sample)).toEqual([
      { tag: "input", line: 3 },
      { tag: "select", line: 4 },
      { tag: "textarea", line: 7 },
      { tag: "dialog", line: 8 },
    ]);
  });

  it("放过 file / hidden 的 input、ui-exempt 标注与注释里的例子", () => {
    const sample = [
      '<input type="file" onChange={f} />',
      '<input type="hidden" value="x" />',
      "{/* ui-exempt: 画布行内编辑 */}",
      "<textarea />",
      "// <input /> 只是注释里的例子",
      "const x = 1; /* <select> */",
    ].join("\n");
    expect(rawFormElements(sample)).toEqual([]);
  });

  it("多行的 input 标签按整个标签判断 type", () => {
    const sample = '<input\n  className="x"\n  type="file"\n/>';
    expect(rawFormElements(sample)).toEqual([]);
    expect(
      rawFormElements('<input\n  className="x"\n  type="text"\n/>'),
    ).toHaveLength(1);
  });

  it("Input / Select 这类大写组件名不算", () => {
    expect(rawFormElements("<Input /><Select /><Textarea />")).toEqual([]);
  });
});
