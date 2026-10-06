// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ERROR_CODES, isRegisteredErrorCode } from "@armadra/shared";

/**
 * 错误码注册表守卫（工程规范化 §4.3）：扫 core 源码里 `coreError(status,
 * "code", …)` 与 `code: "UPPER_SNAKE"` 两种字面量，核对它们和注册表一致。
 */
const CORE = fileURLToPath(
  new URL("../../../desktop/src/core", import.meta.url),
);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** 去掉注释，免得文档里举例的 `coreError(404, "x")` 被当成真调用。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface Found {
  readonly code: string;
  readonly status?: number;
  readonly file: string;
}

/** `coreError(404, "not_found", …)`：状态与码都是字面量的调用。 */
function scanCoreErrors(source: string, file = "sample.ts"): Found[] {
  return [
    ...stripComments(source).matchAll(
      /coreError\(\s*(\d{3})\s*,\s*"([A-Za-z0-9_]+)"/g,
    ),
  ].map((m) => ({ code: m[2]!, status: Number(m[1]), file }));
}

/**
 * `fail("not_found", …)`：状态由注册表给，码必须登记（类型上已经守着）。只认
 * 从 `http/errors` 拿来的那个 `fail`——身份域的 OAuth 有自己同名的局部函数。
 */
function scanFails(source: string, file = "sample.ts"): Found[] {
  const imported =
    /import\s*\{[^}]*\bfail\b[^}]*\}\s*from\s*"(?:\.\/|(?:\.\.\/)*)(?:http\/)?errors"/.test(
      source,
    ) &&
    (file.startsWith("http/") ||
      /from\s*"(?:\.\.\/)+http\/errors"/.test(source));
  if (!imported) return [];
  return [
    ...stripComments(source).matchAll(/\bfail\(\s*"([A-Za-z0-9_]+)"/g),
  ].map((m) => ({ code: m[1]!, file }));
}

/**
 * `new DomainError(423, "canvas_lease_held", …)`：域里抛的拒绝（状态与码是字面量
 * 的）。只用来数「这个码还在被用」，不核对状态——各域的存量码还没都登记。
 */
function scanDomainErrors(source: string, file = "sample.ts"): Found[] {
  return [
    ...stripComments(source).matchAll(
      /new DomainError\(\s*(\d{3})\s*,\s*"([A-Za-z0-9_]+)"/g,
    ),
  ].map((m) => ({ code: m[2]!, status: Number(m[1]), file }));
}

/** `code: "NOT_FOUND"`：大写拼法的存量（身份域、GitHub 面）。 */
function scanUpperCodes(source: string, file = "sample.ts"): Found[] {
  return [
    ...stripComments(source).matchAll(
      /\bcode:\s*"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{4,})"/g,
    ),
  ].map((m) => ({ code: m[1]!, file }));
}

function scanCore<T>(scan: (source: string, file: string) => T[]): T[] {
  return walk(CORE).flatMap((file) =>
    scan(readFileSync(file, "utf8"), relative(CORE, file).split(sep).join("/")),
  );
}

/**
 * 大写码的存量，只减不增：身份域的 gRPC 风格拼法，在 `identity` 域迁移时改成
 * snake_case 并从这里划掉。GitHub 面（契约 §41.1）已换成 snake_case。
 */
const LEGACY_UPPER_CODES = new Set([
  "CONFLICT",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "NOT_IMPLEMENTED",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
]);

describe("错误码注册表", () => {
  it("码都是 snake_case，状态是 4xx / 5xx", () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(code, code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      expect(spec.status, code).toBeGreaterThanOrEqual(400);
      expect(spec.status, code).toBeLessThan(600);
    }
  });

  it("core 里 coreError 的每个字面量码都登记了，状态一致", () => {
    const found = scanCore(scanCoreErrors);
    // 不是空跑：core 里确实有这类调用。
    expect(found.length).toBeGreaterThan(50);
    const problems = found.flatMap(({ code, status, file }) => {
      if (!isRegisteredErrorCode(code)) return [`${file}: 未登记的码 ${code}`];
      const registered = ERROR_CODES[code].status;
      return registered === status
        ? []
        : [`${file}: ${code} 登记为 ${registered}，这里是 ${status}`];
    });
    expect(problems).toEqual([]);
  });

  it("core 里 fail() 的每个字面量码都登记了", () => {
    const problems = scanCore(scanFails).flatMap(({ code, file }) =>
      isRegisteredErrorCode(code) ? [] : [`${file}: 未登记的码 ${code}`],
    );
    expect(problems).toEqual([]);
  });

  it("注册表里的码都还在被用（删掉最后一处用法时一并删登记）", () => {
    const used = new Set(
      [
        ...scanCore(scanCoreErrors),
        ...scanCore(scanFails),
        ...scanCore(scanDomainErrors),
      ].map((entry) => entry.code),
    );
    expect(Object.keys(ERROR_CODES).filter((code) => !used.has(code))).toEqual(
      [],
    );
  });

  it("大写拼法只许是存量名单里的，且名单里的都还在用", () => {
    const used = new Set(scanCore(scanUpperCodes).map((entry) => entry.code));
    expect([...used].filter((code) => !LEGACY_UPPER_CODES.has(code))).toEqual(
      [],
    );
    expect([...LEGACY_UPPER_CODES].filter((code) => !used.has(code))).toEqual(
      [],
    );
  });
});

describe("扫描器真的扫得到", () => {
  it("抓得到未登记的码与状态不一致", () => {
    const sample = `
      return coreError(404, "no_such_thing", "x");
      return coreError(
        409,
        "not_found",
        "y",
      );
    `;
    const found = scanCoreErrors(sample);
    expect(found.map((entry) => [entry.code, entry.status])).toEqual([
      ["no_such_thing", 404],
      ["not_found", 409],
    ]);
    expect(isRegisteredErrorCode("no_such_thing")).toBe(false);
    expect(ERROR_CODES.not_found.status).not.toBe(409);
  });

  it("抓得到 fail() 的码", () => {
    expect(
      scanFails(
        'import { fail } from "../http/errors";\nthrow fail("not_found", "x"); unfail("y")',
      ).map((entry) => entry.code),
    ).toEqual(["not_found"]);
    // 别处同名的局部函数不算。
    expect(scanFails('function fail(c) {}\nfail("oauth_x")')).toEqual([]);
  });

  it("注释里的例子不算", () => {
    expect(
      scanCoreErrors('// coreError(404, "x")\n/* coreError(404, "y") */'),
    ).toEqual([]);
  });

  it("抓得到新写的大写码", () => {
    expect(
      scanUpperCodes(
        'const body = { code: "SOMETHING_BAD", message: "m" };',
      ).map((entry) => entry.code),
    ).toEqual(["SOMETHING_BAD"]);
    expect(scanUpperCodes('{ code: "not_found" }')).toEqual([]);
  });
});
