import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { install as installAssets } from "../assets/routes";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type Kit, expectParity, startKit } from "./parity-kit";

/**
 * 输出到画板的代码块的对偶测试（契约 §37.3，`files.exportText`）。
 *
 * 同一份夹具问三次：路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。三种答法写同一个文件名，答案逐字节
 * 相等；拒绝的码、状态与原话相等。
 */

const EXPORT_ID = "0199a3c4-1b2c-7d3e-8f40-123456789abc";

let core: Fixture;
let kit: Kit;
let root: string;
let workspaceId: string;
let readOnlyId: string;

beforeAll(async () => {
  core = fixture([installWorkspaces, installAssets]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  kit = await startKit(core.server, () => undefined);
  root = join(core.directory, "project");
  mkdirSync(root);
  workspaceId = (
    (await core.call("POST", "/api/workspaces", { name: "w", rootPath: root }))
      .body as { id: string }
  ).id;
  const frozen = join(core.directory, "frozen");
  mkdirSync(frozen);
  readOnlyId = (
    (
      await core.call("POST", "/api/workspaces", {
        name: "frozen",
        rootPath: frozen,
        permissions: { read: true, write: false, execute: false },
      })
    ).body as { id: string }
  ).id;
});

afterAll(async () => {
  await core.server.close();
  core.close();
});

const path = (id: string, exportId = EXPORT_ID) =>
  `/api/workspaces/${id}/exports/${exportId}/text`;

async function three(
  id: string,
  exportId: string,
  body: Record<string, unknown>,
) {
  return [
    await kit.table("POST", path(id, exportId), body),
    await kit.legacy("POST", path(id, exportId), body),
    await kit.procedure("files.exportText", {
      workspaceId: id,
      exportId,
      ...body,
    }),
  ] as const;
}

describe("files.exportText（§37.3）", () => {
  it("写进工作区的导出目录，答路径与字节数", async () => {
    const answers = await three(workspaceId, EXPORT_ID, {
      name: "snippet.ts",
      content: "export const x = 1;\n",
    });
    expectParity(answers);
    expect(answers[0].body).toMatchObject({
      relativePath: `.armadra/exports/acp/${EXPORT_ID}/snippet.ts`,
      bytes: 20,
    });
    const written = (answers[2].body as { path: string }).path;
    expect(readFileSync(written, "utf8")).toBe("export const x = 1;\n");
  });

  it("拒绝：码、状态与原话一样", async () => {
    // 文件名不是一个普通的名字。
    expectParity(
      await three(workspaceId, EXPORT_ID, { name: "../x", content: "x" }),
    );
    // 来源节点 id 不对。
    expectParity(
      await three(workspaceId, "not-a-uuid", { name: "a.txt", content: "x" }),
    );
    // 缺内容。
    expectParity(await three(workspaceId, EXPORT_ID, { name: "a.txt" }));
    // 只读的工作空间。
    expectParity(
      await three(readOnlyId, EXPORT_ID, { name: "a.txt", content: "x" }),
    );
    // 没有这个工作空间。
    expectParity(
      await three("missing", EXPORT_ID, { name: "a.txt", content: "x" }),
    );
  });

  it("scope 与路由表给旧路径的一致，绑工作空间", () => {
    const entry = contractEntries().find(
      (one) => one.name === "files.exportText",
    )!;
    const legacy = entry.meta.legacy!;
    expect(entry.meta.workspaceKey).toBe("workspaceId");
    expect(routeScope(legacy.method, legacy.path)?.permission).toBe(
      entry.meta.scope,
    );
    expect(core.server.router.match(legacy.path)?.entry.methods).toContain(
      "POST",
    );
  });
});
