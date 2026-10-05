#!/usr/bin/env node
/**
 * 从契约（`packages/shared/src/contract/`）生成两样东西（工程规范化 §2.5、
 * 工程规范化包 §1.5）：
 *
 *   1. `docs/contracts/core-openapi.json`：每条 procedure 的入参与出参 schema
 *      （OpenAPI 3.1，给外部工具用）。路径是 RPC 的 `/api/rpc/<域>/<动词>`；
 *      线上的体是 `{ json }` 编码，这里的 schema 是 `json` 那一格的形状；失败一律
 *      是 `CoreError`（契约 §34.1）。
 *   2. `docs/contracts/core-json-api.md` 里每个
 *      `<!-- rpc:begin contract=§N.M -->…<!-- rpc:end -->` 标记块：按
 *      `meta.contract` 把那一节的 procedure 渲染成一张表。块外的散文不碰。
 *
 * `--check`：只比对，不写；有差异就列出来并以 1 退出（`pnpm contract:check`，
 * 在 `pnpm check` 里）。改形状改契约，不手改表。
 *
 * 读的是 `packages/shared/dist`：先 `pnpm libs:build`（`pnpm check` 第一步就是）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { format, resolveConfig } from "prettier";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const OPENAPI_FILE = join(ROOT, "docs/contracts/core-openapi.json");
export const MARKDOWN_FILE = join(ROOT, "docs/contracts/core-json-api.md");

const ERROR_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    requestId: { type: "string" },
    details: { type: "object" },
  },
  required: ["code", "message"],
};

/** 契约树 → 每条 procedure（与 `contractEntries` 同一个顺序）。 */
export function entriesOf(tree, prefix = []) {
  const found = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = [...prefix, key];
    if (value && typeof value === "object" && "~orpc" in value) {
      found.push({
        path,
        name: path.join("."),
        meta: value["~orpc"].meta ?? {},
        errors: Object.keys(value["~orpc"].errorMap ?? {}),
        procedure: value,
      });
    } else if (value && typeof value === "object") {
      found.push(...entriesOf(value, path));
    }
  }
  return found;
}

/** OpenAPI 文档：RPC 路径、`CoreError` 失败形状、`x-armadra` 元数据。 */
export async function buildDocument(contract, version) {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const raw = await generator.generate(contract, {
    info: {
      title: "Armadra core",
      version,
      description:
        "契约 procedure 的入参与出参（docs/contracts/core-json-api.md §34）。线上是 `POST /api/rpc/<域>/<动词>`，体按 `{ json }` 编码，下列 schema 是 `json` 那一格；失败一律是 `CoreError`。由 tools/contract/generate.mjs 生成，不要手改。",
    },
  });
  const entries = new Map(
    entriesOf(contract).map((entry) => [entry.name, entry]),
  );
  const paths = {};
  for (const [path, item] of Object.entries(raw.paths ?? {})) {
    for (const operation of Object.values(item)) {
      const entry = entries.get(operation.operationId);
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (Number(status) < 400) continue;
        operation.responses[status] = {
          description: response.description,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CoreError" },
            },
          },
        };
      }
      if (entry !== undefined) {
        operation["x-armadra"] = {
          contract: entry.meta.contract,
          scope: entry.meta.scope ?? null,
          since: entry.meta.since,
          ...(entry.meta.workspaceKey
            ? { workspaceKey: entry.meta.workspaceKey }
            : {}),
          ...(entry.meta.legacy ? { legacy: entry.meta.legacy } : {}),
          ...(entry.meta.deprecated
            ? { deprecated: entry.meta.deprecated }
            : {}),
        };
      }
    }
    paths[`/api/rpc${path}`] = item;
  }
  return {
    ...raw,
    paths,
    components: {
      ...raw.components,
      schemas: { ...raw.components?.schemas, CoreError: ERROR_SCHEMA },
    },
  };
}

/* ------------------------------ schema → 一行类型 ----------------------------- */

const escape = (text) => text.replace(/\|/g, "\\|");

/** JSON Schema → TypeScript 风格的一行；对象展开两层，再深的写 `{…}`。 */
export function typeOf(schema, document, depth = 2) {
  if (schema === undefined || schema === null) return "—";
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    const target = document.components?.schemas?.[name];
    return target === undefined ? name : typeOf(target, document, depth);
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && isJsonValue(union)) return "JSON";
  if (Array.isArray(union)) {
    return union.map((part) => typeOf(part, document, depth)).join(" | ");
  }
  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (type.length > 1) {
    return type
      .map((one) => typeOf({ ...schema, type: one }, document, depth))
      .join(" | ");
  }
  switch (type[0]) {
    case "string":
      return "string";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${wrap(typeOf(schema.items, document, depth))}[]`;
    case "object": {
      const properties = Object.entries(schema.properties ?? {});
      const extra = schema.additionalProperties;
      if (properties.length === 0 && extra && typeof extra === "object") {
        return `Record<string, ${typeOf(extra, document, depth)}>`;
      }
      if (properties.length === 0) return "{}";
      if (depth <= 0) return "{…}";
      const required = new Set(schema.required ?? []);
      return `{ ${properties
        .map(
          ([key, value]) =>
            `${key}${required.has(key) ? "" : "?"}: ${typeOf(value, document, depth - 1)}`,
        )
        .join(", ")} }`;
    }
    default:
      // 没有类型约束：任意 JSON（递归的 `jsonValueSchema` 展到底就是它）。
      return "JSON";
  }
}

/** 「任意 JSON」那个递归的并集（`jsonValueSchema`）：六种类型都在。 */
function isJsonValue(union) {
  const types = new Set(union.map((part) => part.type));
  return ["string", "number", "boolean", "null", "array", "object"].every(
    (type) => types.has(type),
  );
}

/** 出参是 `z.void()`：没有体。 */
const isVoid = (procedure) =>
  procedure["~orpc"].outputSchema?._zod?.def?.type === "void";

const wrap = (text) => (text.includes(" | ") ? `(${text})` : text);

function operationOf(document, name) {
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item)) {
      if (operation.operationId === name) return operation;
    }
  }
  return undefined;
}

/** 一节的表。 */
export function renderSection(entries, document, section) {
  const rows = entries
    .filter((entry) => entry.meta.contract === section)
    .map((entry) => {
      const operation = operationOf(document, entry.name);
      const body = operation?.requestBody;
      const inputSchema = body?.content?.["application/json"]?.schema;
      const input =
        inputSchema === undefined
          ? "无"
          : `${body.required ? "" : "可省 "}\`${escape(typeOf(inputSchema, document))}\``;
      const ok = Object.entries(operation?.responses ?? {}).find(
        ([status]) => Number(status) < 400,
      )?.[1];
      const outputSchema = ok?.content?.["application/json"]?.schema;
      const legacy = entry.meta.legacy;
      const kind =
        legacy === undefined
          ? "call"
          : legacy.method === "GET"
            ? "query"
            : "mutation";
      return [
        `\`${entry.name}\``,
        kind,
        input,
        outputSchema === undefined || isVoid(entry.procedure)
          ? "无"
          : `\`${escape(typeOf(outputSchema, document))}\``,
        entry.errors.length === 0
          ? "—"
          : entry.errors.map((code) => `\`${code}\``).join("、"),
        entry.meta.scope ? `\`${entry.meta.scope}\`` : "匿名",
        entry.meta.since ?? "—",
        legacy === undefined ? "—" : `\`${legacy.method} ${legacy.path}\``,
      ];
    });
  const header = [
    "procedure",
    "kind",
    "input",
    "output",
    "errors",
    "scope",
    "自",
    "原路径",
  ];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const BLOCK =
  /<!-- rpc:begin contract=(§\d+\.\d+) -->\n[\s\S]*?<!-- rpc:end -->/g;

/** 只换标记块里的内容；一节在契约里没有 procedure 是错误（块写错了节号）。 */
export function applyBlocks(markdown, entries, document) {
  const sections = new Set(entries.map((entry) => entry.meta.contract));
  const seen = new Set();
  const text = markdown.replace(BLOCK, (_whole, section) => {
    if (!sections.has(section)) {
      throw new Error(`标记块 ${section} 在契约里没有 procedure`);
    }
    seen.add(section);
    return `<!-- rpc:begin contract=${section} -->\n\n${renderSection(entries, document, section)}\n\n<!-- rpc:end -->`;
  });
  const missing = [...sections].filter((section) => !seen.has(section));
  if (missing.length > 0) {
    throw new Error(`契约里的这些节在文档里没有标记块：${missing.join("、")}`);
  }
  return text;
}

async function pretty(text, file) {
  const options = (await resolveConfig(file)) ?? {};
  return format(text, { ...options, filepath: file });
}

/** 生成两份文件应有的内容。 */
export async function generate({
  contract,
  version,
  markdown = readFileSync(MARKDOWN_FILE, "utf8"),
}) {
  const document = await buildDocument(contract, version);
  const entries = entriesOf(contract);
  return {
    openapi: await pretty(
      `${JSON.stringify(document, null, 2)}\n`,
      OPENAPI_FILE,
    ),
    markdown: await pretty(
      applyBlocks(markdown, entries, document),
      MARKDOWN_FILE,
    ),
  };
}

/**
 * 文档的版本是契约里最新的 `since`（协议 `major.minor`），不是应用版本：发版
 * 改应用版本号不该让生成的文档过期。
 */
export function contractVersion(contract) {
  const versions = entriesOf(contract)
    .map((entry) =>
      String(entry.meta.since ?? "0.0")
        .split(".")
        .map(Number),
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const latest = versions.at(-1) ?? [0, 0];
  return `${latest[0]}.${latest[1]}`;
}

async function loadContract() {
  const url = pathToFileURL(
    join(ROOT, "packages/shared/dist/contract/index.js"),
  );
  const { contract } = await import(url.href);
  return contract;
}

function current(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 两段文本第一处不同的行号，给 `--check` 的报告用。 */
function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return index + 1;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const contract = await loadContract();
  const wanted = await generate({
    contract,
    version: contractVersion(contract),
  });
  const files = [
    [OPENAPI_FILE, wanted.openapi],
    [MARKDOWN_FILE, wanted.markdown],
  ];
  const stale = files.filter(([file, text]) => current(file) !== text);
  if (check) {
    for (const [file, text] of stale) {
      console.error(
        `contract: ${relative(ROOT, file)} 与契约不一致（第 ${firstDifference(current(file), text)} 行起）；跑 node tools/contract/generate.mjs`,
      );
    }
    return stale.length === 0 ? 0 : 1;
  }
  for (const [file, text] of stale) {
    writeFileSync(file, text);
    console.log(`contract: 写了 ${relative(ROOT, file)}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
