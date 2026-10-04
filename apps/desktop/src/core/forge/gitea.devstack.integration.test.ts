/**
 * 托管平台域对 dev-stack 的真 Gitea（`pnpm dev-stack up gitea`，`127.0.0.1:3000`，
 * 管理员 `armadra-dev`）：用管理员口令现建一个令牌与一个仓库，预置分支、文件、
 * issue 与 commit status，再经 `/api/forge/*` 走一遍识别 → 列表 → 关 issue → 建 PR →
 * 差异 → 检查 → 合并。结束时删掉仓库与令牌。
 *
 * `ARMADRA_DEV_STACK=1` 才跑；否则 skipped。地址用 `ARMADRA_GITEA_URL` 换，管理员
 * 口令取 `GITEA_ADMIN_PASSWORD`，没有就读 `tools/dev-stack/.data/dev.env`。
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { openFreshDatabase } from "../db/fresh.fixture";
import { tempDir } from "../testing/temp-dir";
import type { SecretBackend } from "../secrets/backend";
import { installRoutes } from "./routes";
import { ForgeService } from "./service";
import { ForgeStore } from "./store";

const enabled = process.env.ARMADRA_DEV_STACK === "1";
const root = (
  process.env.ARMADRA_GITEA_URL?.trim() || "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = "armadra-dev";

function adminPassword(): string {
  const fromEnv = process.env.GITEA_ADMIN_PASSWORD?.trim();
  if (fromEnv) return fromEnv;
  const file = resolve(here, "../../../../../tools/dev-stack/.data/dev.env");
  if (!existsSync(file))
    throw new Error(`没有 ${file}：先 pnpm dev-stack up gitea`);
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("GITEA_ADMIN_PASSWORD="));
  if (line === undefined)
    throw new Error("dev.env 里没有 GITEA_ADMIN_PASSWORD");
  return line.slice("GITEA_ADMIN_PASSWORD=".length).trim();
}

async function admin(
  method: string,
  path: string,
  body?: unknown,
  auth = `Basic ${Buffer.from(`${ADMIN}:${adminPassword()}`).toString("base64")}`,
): Promise<any> {
  const response = await fetch(`${root}/api/v1${path}`, {
    method,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text === "" ? undefined : JSON.parse(text);
}

describe.skipIf(!enabled)("dev-stack：gitea（§29）", () => {
  const suffix = randomBytes(4).toString("hex");
  const repoName = `forge-${suffix}`;
  const tokenName = `armadra-forge-test-${suffix}`;
  let token = "";
  let headSha = "";
  let issueNumber = 0;
  const secrets = new Map<string, string>();
  let call: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<{ status: number; body: any }>;

  beforeAll(async () => {
    const health = await fetch(`${root}/api/healthz`);
    expect(health.status).toBe(200);
    token = (
      await admin("POST", `/users/${ADMIN}/tokens`, {
        name: tokenName,
        scopes: ["write:repository", "write:issue", "read:user"],
      })
    ).sha1;
    const tokenAuth = `token ${token}`;
    // 建仓库要 `write:user`；用管理员口令建，令牌只留仓库与 issue 两项。
    await admin("POST", "/user/repos", {
      name: repoName,
      auto_init: true,
      default_branch: "main",
      private: true,
    });
    await admin(
      "POST",
      `/repos/${ADMIN}/${repoName}/branches`,
      { new_branch_name: "feature", old_branch_name: "main" },
      tokenAuth,
    );
    const written = await admin(
      "POST",
      `/repos/${ADMIN}/${repoName}/contents/hello.txt`,
      {
        branch: "feature",
        message: "add hello",
        content: Buffer.from("hello forge\n").toString("base64"),
      },
      tokenAuth,
    );
    headSha = written.commit.sha;
    await admin(
      "POST",
      `/repos/${ADMIN}/${repoName}/statuses/${headSha}`,
      {
        state: "success",
        context: "ci/test",
        target_url: `${root}/ci/1`,
        description: "ok",
      },
      tokenAuth,
    );
    issueNumber = (
      await admin(
        "POST",
        `/repos/${ADMIN}/${repoName}/issues`,
        { title: "forge issue", body: "issue body" },
        tokenAuth,
      )
    ).number;

    const directory = tempDir("armadra-forge-devstack-");
    const db = openFreshDatabase(
      resolve(directory, "canvas.db"),
      resolve(here, "../db/migrations"),
    );
    const backend: SecretBackend = {
      kind: "file",
      get: async (name) => secrets.get(name),
      set: async (name, value) => void secrets.set(name, value),
      delete: async (name) => void secrets.delete(name),
    };
    const service = new ForgeService({
      store: new ForgeStore(db.database),
      secrets: () => backend,
    });
    const router = new Router();
    installRoutes({ router } as unknown as CoreServer, service);
    call = async (method, path, body, query = {}) => {
      const encoded = Buffer.from(
        body === undefined ? "" : JSON.stringify(body),
      );
      return (await router.dispatch(method, path, {
        ...emptyRequest(method, path),
        query: new URLSearchParams(query),
        body: encoded,
        json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
      })) as { status: number; body: any };
    };
  }, 60_000);

  afterAll(async () => {
    if (token === "") return;
    await admin("DELETE", `/repos/${ADMIN}/${repoName}`).catch(() => undefined);
    await admin("DELETE", `/users/${ADMIN}/tokens/${tokenName}`).catch(
      () => undefined,
    );
  });

  it("配置、识别、issue、PR、差异、检查、合并", async () => {
    const host = new URL(root).hostname;
    const configured = await call("PUT", `/api/forge/configs/${host}`, {
      forge: "gitea",
      apiBase: root,
      token,
    });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({
      credential: true,
      accountLogin: ADMIN,
    });
    expect(JSON.stringify(configured.body)).not.toContain(token);

    const resolved = await call("POST", "/api/forge/resolve", {
      remoteUrl: `${root}/${ADMIN}/${repoName}.git`,
    });
    expect(resolved.body).toMatchObject({
      forge: "gitea",
      source: "config",
      credential: true,
      webUrl: `${root}/${ADMIN}/${repoName}`,
    });

    const repo = `/api/forge/repos/${host}/${ADMIN}/${repoName}`;
    const issues = await call("GET", `${repo}/issues`);
    expect(issues.status).toBe(200);
    expect(issues.body.items.map((issue: any) => issue.number)).toContain(
      issueNumber,
    );
    expect((await call("GET", `${repo}/issues/${issueNumber}`)).body.body).toBe(
      "issue body",
    );
    expect(
      (
        await call("PATCH", `${repo}/issues/${issueNumber}`, {
          state: "closed",
        })
      ).body.state,
    ).toBe("closed");

    const created = await call("POST", `${repo}/pulls`, {
      title: "add hello",
      body: "pr body",
      head: "feature",
      base: "main",
    });
    expect(created.status).toBe(201);
    const number = created.body.number as number;
    expect(created.body).toMatchObject({
      state: "open",
      headRef: "feature",
      headSha,
    });

    const files = await call("GET", `${repo}/pulls/${number}/files`);
    expect(files.body.files).toEqual([
      expect.objectContaining({
        path: "hello.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: expect.stringContaining("+hello forge"),
      }),
    ]);

    const checks = await call("GET", `${repo}/pulls/${number}/checks`);
    expect(checks.body).toEqual({
      headSha,
      rollup: "success",
      checks: [{ name: "ci/test", state: "success", url: `${root}/ci/1` }],
    });

    // Gitea 异步算合并性：等它算完再合。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const pull = await call("GET", `${repo}/pulls/${number}`);
      if (pull.body.mergeable === "mergeable") break;
      await new Promise((done) => setTimeout(done, 500));
    }
    expect(
      (
        await call("POST", `${repo}/pulls/${number}/merge`, {
          headSha: "0".repeat(40),
        })
      ).body.code,
    ).toBe("conflict");
    const merged = await call("POST", `${repo}/pulls/${number}/merge`, {
      method: "merge",
      headSha,
    });
    expect(merged.status).toBe(200);
    expect(merged.body.merged).toBe(true);
    expect(merged.body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await call("GET", `${repo}/pulls/${number}`)).body.state).toBe(
      "merged",
    );
    const closed = await call("GET", `${repo}/pulls`, undefined, {
      state: "closed",
    });
    expect(
      closed.body.items.map((pull: any) => [pull.number, pull.state]),
    ).toContainEqual([number, "merged"]);
  }, 60_000);
});
