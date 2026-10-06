import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MARKDOWN_FILE,
  OPENAPI_FILE,
  applyBlocks,
  contractVersion,
  entriesOf,
  eventsOf,
  generate,
  main,
  typeOf,
} from "./generate.mjs";

/**
 * 契约文档生成器（工程规范化包 §1.5、§1.7）：仓库里的文件与契约一致；改一条
 * schema，生成的表就变；标记块写错了节号是错误。读 `packages/shared/dist`，先
 * `pnpm libs:build`。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const { contract } = await import(
  pathToFileURL(join(ROOT, "packages/shared/dist/contract/index.js")).href
);
const { z } = await import(
  pathToFileURL(join(ROOT, "packages/shared/node_modules/zod/index.js")).href
);

test("--check：仓库里的两份文件与契约一致", async () => {
  assert.equal(await main(["--check"]), 0);
});

test("改一条 schema，生成的表与 OpenAPI 都变", async () => {
  const version = contractVersion(contract);
  const before = await generate({ contract, version });
  const ping = contract.system.ping;
  const changed = {
    ...contract,
    system: {
      ...contract.system,
      ping: ping.output(z.object({ ts: z.number(), serverTs: z.string() })),
    },
  };
  const after = await generate({ contract: changed, version });
  assert.notEqual(after.markdown, before.markdown);
  assert.notEqual(after.openapi, before.openapi);
  assert.match(after.markdown, /serverTs: string/);
  // 块外的散文一个字都不动。
  const outside = (text) =>
    text.replace(/<!-- rpc:begin[\s\S]*?<!-- rpc:end -->/g, "");
  assert.equal(outside(after.markdown), outside(before.markdown));
});

test("标记块的节号在契约里没有 procedure 是错误；契约里的节没有块也是错误", () => {
  const entries = entriesOf(contract);
  const document = { paths: {}, components: {} };
  assert.throws(
    () =>
      applyBlocks(
        "<!-- rpc:begin contract=§99.1 -->\n<!-- rpc:end -->",
        entries,
        document,
      ),
    /§99\.1/,
  );
  assert.throws(() => applyBlocks("", entries, document), /没有标记块/);
});

test("类型渲染：对象展开两层，可选带问号，任意 JSON 写成 JSON", () => {
  const doc = { components: { schemas: {} } };
  assert.equal(
    typeOf(
      {
        type: "object",
        properties: {
          a: { type: "string" },
          b: {
            type: "object",
            properties: { c: { type: "object", properties: { d: {} } } },
          },
        },
        required: ["a"],
      },
      doc,
    ),
    "{ a: string, b?: { c?: {…} } }",
  );
  assert.equal(
    typeOf(
      {
        anyOf: ["string", "number", "boolean", "null", "array", "object"].map(
          (type) => ({ type }),
        ),
      },
      doc,
    ),
    "JSON",
  );
  assert.equal(
    typeOf(
      {
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      doc,
    ),
    "(string | null)[]",
  );
});

test("生成的 OpenAPI：RPC 路径、CoreError、x-armadra 元数据", () => {
  const document = JSON.parse(readFileSync(OPENAPI_FILE, "utf8"));
  assert.ok(document.paths["/api/rpc/workspaces/list"]);
  const list = document.paths["/api/rpc/workspaces/list"].post;
  assert.deepEqual(list["x-armadra"].legacy, {
    method: "GET",
    path: "/api/workspaces",
  });
  assert.equal(
    list.responses["403"].content["application/json"].schema.$ref,
    "#/components/schemas/CoreError",
  );
  assert.ok(readFileSync(MARKDOWN_FILE, "utf8").includes("contract=§34.4"));
});

test("订阅（契约 §35）：kind 是 subscription，出参列事件的 type，x-armadra 记背压与控制面", () => {
  const document = JSON.parse(readFileSync(OPENAPI_FILE, "utf8"));
  const events = document.paths["/api/rpc/workspaces/events"].post;
  assert.equal(events["x-armadra"].backpressure, "resubscribe");
  assert.equal(events["x-armadra"].transport, "/api/ws");
  const markdown = readFileSync(MARKDOWN_FILE, "utf8");
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith("| `workspaces.events`"));
  assert.ok(row?.includes("| subscription |"));
  assert.ok(row?.includes("`workspace.updated`"));
  assert.ok(row?.includes("`cursor`"));
  // 成员不全带 `type` 常量时照常写类型。
  const stream = {
    oneOf: [
      {
        type: "object",
        properties: {
          event: { const: "message" },
          data: { type: "object", properties: { n: { type: "integer" } } },
        },
      },
    ],
  };
  assert.equal(eventsOf(stream, document), "迭代 `{ n?: integer }`");
});
