import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { EventBus } from "../bus";
import { openDatabase, type OpenedDatabase } from "../db/open";
import { GithubCredentialSource } from "../github/types";
import { CredentialService } from "../github/credentials";
import {
  type FakeGithub,
  fakeGithub,
  memorySecrets,
  migrationsDir,
  stubGh,
} from "../github/fixture";
import { API_PREFIX, GITHUB_METHODS, GithubHttp } from "../github/http";
import { GithubService } from "../github/service";
import { GithubStore } from "../github/store";
import { type RpcHandle, installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import {
  IdentityService,
  IdentityStore,
  identityInstanceId,
} from "../identity";
import { createLoopbackAdmission } from "../identity/loopback";
import { allScopes, scope } from "../identity/scopes";
import { WsTickets } from "../identity/transport";
import { createLog, nodePlatform } from "../platform";
import { type JsonValue, canonicalJson } from "./message";

/**
 * github 域的对偶测试（契约 §41.1；工程规范化包 §3 ④）。
 *
 * 旧的 `POST /api/github/<动词>?workspaceId=` 是整段自己认证的原样路由，不在路由表
 * 里、也不挂契约的旧路径，所以这里的三方比较少一方：同一份夹具问两次——旧路径与
 * 新 procedure（`POST /api/rpc/github/<动词>`），两条路都带着真的会话（准入门
 * 核验，来源、Bearer、CSRF 与会话在 core 的 `CoreServer` 里判）。成功的答案按
 * `canonicalJson` 逐字节相等；失败的码、状态与原话相等（procedure 多一个
 * `requestId`）。远端假的是一台进程内的 GitHub；时间固定，所以 `observedAt…`
 * 也相等。
 *
 * 错误码一律 snake_case：旧路径与 procedure 答同一个拼法（契约 §41.1）。
 */

const ORIGIN = "http://127.0.0.1:5173";
const WORKSPACE = "ws-1";
const NOW = 1_800_000_000_000;
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const REPO = { owner: "octo", name: "repo", apiBase: "", host: "" };

let github: FakeGithub;
let server: CoreServer;
let handle: RpcHandle;
let opened: OpenedDatabase;
let dataDir: string;
let base: string;
let owner: { accessToken: string; csrfToken: string };
let reader: { accessToken: string; csrfToken: string };

function issueJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    node_id: "I_1",
    number: 7,
    title: "An issue",
    body: "body text",
    state: "open",
    user: { login: "octocat", id: 5 },
    labels: [{ name: "todo", color: "ffffff" }],
    comments: 2,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    html_url: "https://github.com/octo/repo/issues/7",
    ...overrides,
  };
}

function pullJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    node_id: "PR_1",
    number: 3,
    title: "A pull request",
    body: "pull body",
    state: "open",
    user: { login: "octocat", id: 5 },
    base: { ref: "main", sha: OTHER_SHA },
    head: { ref: "feature", sha: SHA, repo: { full_name: "octo/repo" } },
    mergeable: true,
    mergeable_state: "clean",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    html_url: "https://github.com/octo/repo/pull/3",
    ...overrides,
  };
}

beforeAll(async () => {
  github = await fakeGithub();
  dataDir = mkdtempSync(join(tmpdir(), "armadra-parity-github-"));
  opened = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir: migrationsDir(),
  });
  const identityStore = new IdentityStore(opened.database);
  const instanceId = identityInstanceId();
  const identity = new IdentityService(identityStore, instanceId);
  const hostId = identityStore.hostId();
  const pair = (scopes: ReturnType<typeof allScopes>, deviceName: string) => {
    const { ticket } = identity.issueBootstrap({
      hostId,
      instanceId,
      origin: ORIGIN,
      deviceName,
      scopes,
    });
    return identity.consumeBootstrap({
      ticket,
      hostId,
      instanceId,
      origin: ORIGIN,
    });
  };
  owner = pair(allScopes(), "owner-device");
  // 只读一块工作空间：写与别的工作空间都不许。
  reader = pair([scope("github:read", WORKSPACE, hostId)], "reader-device");

  const store = new GithubStore(opened.database);
  const credentials = new CredentialService({
    store,
    secrets: memorySecrets(),
    gh: stubGh(),
    client: {
      fetch: (input, init) =>
        globalThis.fetch(
          String(input).replace("https://api.github.com", github.base),
          init,
        ),
      sleep: async () => {},
    },
    now: () => NOW,
  });
  github.route("GET /user", { body: { login: "octocat" } });
  await credentials.configure(
    GithubCredentialSource.TOKEN_REF,
    "ghp_pasted_token_value",
    "",
    0,
  );
  const service = new GithubService({
    store,
    credentials,
    hostId,
    now: () => NOW,
  });
  const http = new GithubHttp({ service, identity });

  const platform = nodePlatform({
    dataDir,
    appVersion: "0.0.0-test",
    isPackaged: false,
    log: createLog("error"),
  });
  server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  server.admission(
    createLoopbackAdmission({ service: identity, tickets: new WsTickets() }),
  );
  server.raw(API_PREFIX, (request, response, cors) =>
    http.handle(request, response, cors),
  );
  http.register(server);
  handle = installContract(server, { validateOutput: true, platform });
  const listener = server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  github.route("GET /repos/octo/repo", {
    body: {
      id: 1,
      full_name: "octo/repo",
      default_branch: "main",
      allow_merge_commit: true,
      allow_squash_merge: false,
      allow_rebase_merge: false,
      permissions: { push: true },
    },
  });
  github.route("GET /repos/octo/repo/issues", { body: [issueJson()] });
  github.route("GET /repos/octo/repo/issues/7", { body: issueJson() });
  github.route("GET /repos/octo/repo/issues/7/comments", {
    body: [
      {
        id: 11,
        user: { login: "octocat", id: 5 },
        body: "first!",
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
        html_url: "https://github.com/octo/repo/issues/7#issuecomment-11",
      },
    ],
  });
  github.route("POST /repos/octo/repo/issues", {
    status: 201,
    body: issueJson({ number: 8, title: "New one" }),
  });
  github.route("PATCH /repos/octo/repo/issues/7", {
    body: issueJson({ state: "closed" }),
  });
  github.route("POST /repos/octo/repo/issues/7/comments", {
    status: 201,
    body: {
      id: 12,
      user: { login: "octocat", id: 5 },
      body: "noted",
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
      html_url: "https://github.com/octo/repo/issues/7#issuecomment-12",
    },
  });
  github.route("GET /repos/octo/repo/pulls", { body: [pullJson()] });
  github.route("GET /repos/octo/repo/pulls/3", { body: pullJson() });
  github.route("GET /repos/octo/repo/pulls/3/files", { body: [] });
  github.route("GET /repos/octo/repo/pulls/3/reviews", { body: [] });
  github.route("GET /repos/octo/repo/pulls/3/comments", { body: [] });
  github.route("GET /repos/octo/repo/issues/3/comments", { body: [] });
  github.route(`GET /repos/octo/repo/commits/${SHA}/check-runs`, {
    body: {
      total_count: 1,
      check_runs: [
        {
          id: 1,
          name: "ci",
          status: "completed",
          conclusion: "success",
          app: { name: "Actions" },
          html_url: "https://github.com/octo/repo/runs/1",
          started_at: "2026-09-02T00:00:00Z",
          completed_at: "2026-09-02T00:01:00Z",
        },
      ],
    },
  });
  github.route(`GET /repos/octo/repo/commits/${SHA}/status`, {
    body: { state: "success", statuses: [] },
  });
});

afterAll(async () => {
  await server.close();
  opened.close();
  await github.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

type Session = { accessToken: string; csrfToken: string };

const headersFor = (session: Session) => ({
  "content-type": "application/json",
  origin: ORIGIN,
  authorization: `Bearer ${session.accessToken}`,
  "x-armadra-csrf": session.csrfToken,
});

/** 旧路径：`POST /api/github/<kebab>?workspaceId=`。 */
async function legacy(
  method: string,
  body: Record<string, unknown>,
  session: Session = owner,
  workspaceId = WORKSPACE,
): Promise<Answer> {
  const verb = method.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const { workspaceId: _ignored, ...rest } = body;
  const response = await fetch(
    `${base}${API_PREFIX}${verb}?workspaceId=${workspaceId}`,
    {
      method: "POST",
      headers: headersFor(session),
      body: JSON.stringify(rest),
    },
  );
  return { status: response.status, body: await response.json() };
}

/** 新 procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(
  method: string,
  body: Record<string, unknown>,
  session: Session = owner,
  workspaceId = WORKSPACE,
): Promise<Answer> {
  const name = method.charAt(0).toLowerCase() + method.slice(1);
  const response = await fetch(`${base}/api/rpc/github/${name}`, {
    method: "POST",
    headers: headersFor(session),
    body: JSON.stringify({ json: { workspaceId, ...body } }),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: parsed.json };
  expect(typeof parsed.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = parsed;
  return { status: response.status, body: rest };
}

const text = (answer: Answer) =>
  canonicalJson((answer.body ?? null) as JsonValue);

/** 两条路问同一个问题，答案逐字节相等。 */
async function same(
  method: string,
  body: Record<string, unknown> = {},
  session: Session = owner,
  workspaceId = WORKSPACE,
): Promise<Answer> {
  const before = await legacy(method, body, session, workspaceId);
  const after = await procedure(method, body, session, workspaceId);
  expect(after.status, method).toBe(before.status);
  expect(text(after), method).toBe(text(before));
  return after;
}

describe("github：读", () => {
  it("凭据状态：零值照写，令牌不进答案", async () => {
    const answer = await same("GetCredential");
    expect(answer.body).toMatchObject({
      available: true,
      accountLogin: "octocat",
    });
    expect(JSON.stringify(answer.body)).not.toContain("ghp_pasted_token_value");
  });

  it("仓库、Issue 列表（不带正文）、详情、状态映射", async () => {
    await same("ResolveRepository", {
      remoteUrl: "https://github.com/octo/repo.git",
    });
    const listed = await same("ListIssues", { repository: REPO });
    const issues = (listed.body as { issues: { body: string }[] }).issues;
    expect(issues[0]?.body).toBe("");
    const issue = await same("GetIssue", { repository: REPO, number: "7" });
    expect(issue.body).toMatchObject({
      issue: { number: "7", body: "body text" },
    });
    await same("GetStatusMapping", { repository: REPO });
    await same("ListReferences", {});
  });

  it("PR 列表、详情与检查汇总", async () => {
    await same("ListPulls", { repository: REPO });
    const pull = await same("GetPull", { repository: REPO, number: "3" });
    expect(pull.body).toMatchObject({ pull: { number: "3" } });
    const checks = await same("GetChecks", { repository: REPO, number: "3" });
    expect(checks.body).toMatchObject({ headSha: SHA });
  });
});

describe("github：写", () => {
  it("新建、评论、改状态", async () => {
    const created = await same("CreateIssue", {
      repository: REPO,
      title: "New one",
      body: "x",
    });
    expect(created.status).toBe(200);
    await same("CommentIssue", {
      repository: REPO,
      number: "7",
      body: "noted",
    });
    const closed = await same("SetIssueState", {
      repository: REPO,
      number: "7",
      state: "GITHUB_ISSUE_STATE_CLOSED",
      expectedUpdatedAtUnixMs: String(Date.parse("2026-09-02T00:00:00Z")),
    });
    expect(closed.body).toMatchObject({ state: "GITHUB_ISSUE_STATE_CLOSED" });
  });

  it("远端在写之前动过：conflict，一个字节都不写出去", async () => {
    const before = github.requests.filter((r) => r.method === "PATCH").length;
    const answer = await same("SetIssueState", {
      repository: REPO,
      number: "7",
      state: "GITHUB_ISSUE_STATE_CLOSED",
      expectedUpdatedAtUnixMs: "1",
    });
    expect(answer).toMatchObject({ status: 409, body: { code: "conflict" } });
    expect(github.requests.filter((r) => r.method === "PATCH")).toHaveLength(
      before,
    );
  });

  it("连接：连、列、解除（两条路各用自己的目标，答案结构相等）", async () => {
    const reference = (targetId: string) => ({
      workspaceId: WORKSPACE,
      forge: "github",
      repository: REPO,
      kind: "GITHUB_REFERENCE_KIND_ISSUE",
      number: "7",
      targetKind: "GITHUB_REFERENCE_TARGET_KIND_BRANCH",
      targetId,
      title: "An issue",
    });
    const viaLegacy = await legacy("LinkReference", {
      reference: reference("one"),
      expectedRevision: "0",
    });
    const viaProcedure = await procedure("LinkReference", {
      reference: reference("two"),
      expectedRevision: "0",
    });
    expect(viaLegacy.status).toBe(200);
    expect(viaProcedure.status).toBe(200);
    const shape = (answer: Answer) =>
      Object.keys(answer.body as Record<string, unknown>).sort();
    expect(shape(viaProcedure)).toEqual(shape(viaLegacy));
    const listed = await same("ListReferences", {});
    expect(
      (listed.body as { references: unknown[] }).references.length,
    ).toBeGreaterThanOrEqual(2);
    const first = viaLegacy.body as { referenceId: string; revision: string };
    const second = viaProcedure.body as {
      referenceId: string;
      revision: string;
    };
    const dropped = await legacy("UnlinkReference", {
      referenceId: first.referenceId,
      expectedRevision: first.revision,
    });
    expect(dropped.body).toMatchObject({ unlinked: true });
    const droppedByProcedure = await procedure("UnlinkReference", {
      referenceId: second.referenceId,
      expectedRevision: second.revision,
    });
    expect(droppedByProcedure.body).toMatchObject({ unlinked: true });
  });
});

describe("github：拒绝", () => {
  it("没有工作空间的授权、读只给读：forbidden，两条路同一句", async () => {
    // 只读会话写一次。
    const write = await same(
      "CreateIssue",
      { repository: REPO, title: "nope" },
      reader,
    );
    expect(write).toMatchObject({ status: 403, body: { code: "forbidden" } });
    // 授权只在 ws-1：读 ws-2 也不行。
    const elsewhere = await same("GetCredential", {}, reader, "ws-2");
    expect(elsewhere).toMatchObject({
      status: 403,
      body: { code: "forbidden" },
    });
    // 只读会话读得到自己的工作空间。
    const read = await same("GetCredential", {}, reader);
    expect(read.status).toBe(200);
  });

  it("未知的仓库：not_found；入参解不开：bad_request；写之前的校验：bad_request", async () => {
    const missing = await same("GetIssue", {
      repository: { ...REPO, name: "missing" },
      number: "9",
    });
    expect(missing).toMatchObject({ status: 404, body: { code: "not_found" } });
    const invalid = await same("CreateIssue", {
      repository: REPO,
      title: "",
    });
    expect(invalid).toMatchObject({
      status: 400,
      body: { code: "bad_request", message: "Invalid GitHub request" },
    });
    // 不是数字的 int64：fromJson 解不开。
    const garbage = await same("GetIssue", { repository: REPO, number: "x" });
    expect(garbage).toMatchObject({ status: 400, body: { code: "bad_request" } });
  });

  it("远端限流、远端 5xx：码是 snake_case，远端原话不外传", async () => {
    github.once("GET /repos/octo/repo/issues/7", {
      status: 429,
      headers: { "retry-after": "1" },
      body: { message: "remote said <script>no</script>" },
    });
    github.once("GET /repos/octo/repo/issues/7", {
      status: 429,
      headers: { "retry-after": "1" },
      body: { message: "remote said <script>no</script>" },
    });
    const legacyAnswer = await legacy("GetIssue", {
      repository: REPO,
      number: "7",
    });
    const procedureAnswer = await procedure("GetIssue", {
      repository: REPO,
      number: "7",
    });
    for (const answer of [legacyAnswer, procedureAnswer]) {
      expect(answer.status).toBe(429);
      expect(answer.body).toMatchObject({ code: "rate_limited" });
      expect(JSON.stringify(answer.body)).not.toContain("<script>");
    }
    expect(text(procedureAnswer)).toBe(text(legacyAnswer));
  });

  it("没有会话：401 unauthenticated；procedure 同样", async () => {
    const response = await fetch(`${base}/api/rpc/github/getCredential`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ json: { workspaceId: WORKSPACE } }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });
});

describe("契约与实现", () => {
  it("github.* 的 24 个 procedure 与动词表一一对应，都有实现", () => {
    const entries = contractEntries().filter(
      (entry) => entry.path[0] === "github",
    );
    expect(entries).toHaveLength(24);
    expect(entries.map((entry) => entry.path[1]).sort()).toEqual(
      GITHUB_METHODS.map(
        (method) => method.charAt(0).toLowerCase() + method.slice(1),
      ).sort(),
    );
    for (const entry of entries) {
      expect(handle.implemented, entry.name).toContain(entry.name);
      expect(entry.meta.workspaceKey, entry.name).toBe("workspaceId");
      expect(entry.meta.legacy, entry.name).toBeUndefined();
    }
  });

  it("读是 github:read，写是 github:write", () => {
    const writes = new Set([
      "configureCredential",
      "revokeCredential",
      "createIssue",
      "updateIssue",
      "setIssueState",
      "commentIssue",
      "putStatusMapping",
      "moveIssue",
      "createPull",
      "submitReview",
      "rerunChecks",
      "mergePull",
      "deleteBranch",
      "linkReference",
      "unlinkReference",
    ]);
    for (const entry of contractEntries()) {
      if (entry.path[0] !== "github") continue;
      expect(entry.meta.scope, entry.name).toBe(
        writes.has(entry.path[1] as string) ? "github:write" : "github:read",
      );
    }
  });
});
