import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { contractEntries } from "@armadra/shared";
import { install as installAgents } from "../agent";
import { insertApproval } from "../agent/approvals";
import { createBoard } from "../canvas/boards";
import { install as installCanvas } from "../canvas/routes";
import { install as installDependencies } from "../dependencies";
import type { DependencyService } from "../dependencies/service";
import { installRoutes as installHookRoutes } from "../hook/routes";
import type { HookService } from "../hook/service";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import type { AuthorizationSubject } from "../identity/authorize";
import { installRouteGuard, resetRouteGuard } from "../identity/gate";
import { type ShareRole, roleScopes } from "../identity/roles";
import { createRouteGuard } from "../identity/route-access";
import { type Scope, permits, scope } from "../identity/scopes";
import { install as installModels } from "../models";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { type JsonValue, canonicalJson } from "./message";

/**
 * agents 域的对偶测试（契约 §39；工程规范化包 §3 ④）。
 *
 * 与 `parity-terminals.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条
 * handler、旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新
 * procedure。成功的答案按 `canonicalJson` 逐字节相等；失败的码、状态与原话相等
 * （procedure 多一个 `requestId`）。会改动状态的动作（标已读、答审批、拒收、
 * 取消依赖）每个答法各用自己的对象，比较前把每次都会变的字段换成占位。
 *
 * 最后两节单独写：
 *
 *   * **投递门**（契约 §22、§23）：服务器壳上的成员经旧路径与 procedure 被同一道
 *     路由门拦下——没有 `approval:answer` 的人答不了审批与关闭确认（不替人回答
 *     权限提示与对话框），别的画布上的成员读不到这块画布的节点、投递、连线与
 *     依赖（不跨工作空间读）。拦下的码、状态与原话两条路一样。
 *   * 入参**形状**错：procedure 与旧路径由契约的入参校验先答 `bad_request`（带
 *     `details.issues`），路由表原 handler 答它自己的那句话，只比码与状态。
 */

let core: Fixture;
let base: string;
let workspaceId: string;
let otherWorkspaceId: string;
let boardId: string;
let dependencies: DependencyService;
const configDir = { value: "" };

beforeAll(async () => {
  // 集成的修复会读 CLI 自己的配置目录：指到临时目录，不碰开发者的 HOME。
  core = fixture([
    installWorkspaces,
    installCanvas,
    installAgents,
    installModels,
    (context) => installHookRoutes(context, {} as HookService),
    (context) => {
      dependencies = installDependencies(context);
    },
  ]);
  configDir.value = join(core.directory, "claude-config");
  mkdirSync(configDir.value, { recursive: true });
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir.value);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  core.server.admission((request) => {
    const who = request.headers["x-parity-as"];
    return typeof who === "string"
      ? { identity: { subject: subject(who) } }
      : {};
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  workspaceId = await createWorkspace("agents", core.directory);
  const otherRoot = join(core.directory, "other");
  mkdirSync(otherRoot);
  otherWorkspaceId = await createWorkspace("other", otherRoot);
  boardId = createBoard(core.database, workspaceId, "Board").id;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await dependencies.stop();
  await core.server.close();
  core.close();
});

async function createWorkspace(name: string, rootPath: string) {
  const created = await core.call("POST", "/api/workspaces", {
    name,
    rootPath,
  });
  expect(created.status).toBe(200);
  return (created.body as { id: string }).id;
}

/* -------------------------------- 三种答法 -------------------------------- */

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** 迁移前的答法：路由表里那条 handler。 */
async function table(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const answer = await core.call(method, path, body);
  return { status: answer.status, body: answer.body };
}

/** 旧路径，经 HTTP；`as` 是服务器壳上的成员（投递门一节）。 */
async function legacy(
  method: string,
  path: string,
  body?: unknown,
  as?: string,
): Promise<Answer> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as !== undefined) headers["x-parity-as"] = as;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** 新 procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(
  name: string,
  input?: unknown,
  as?: string,
): Promise<Answer> {
  const response = await fetch(`${base}/api/rpc/${name.replace(".", "/")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(as === undefined ? {} : { "x-parity-as": as }),
    },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

/** 每个对象、每次调用都会变的字段。 */
const VOLATILE = new Set([
  "id",
  "nodeId",
  "downstreamNodeId",
  "upstreamNodeId",
  "requestId",
  "answeredAt",
  "updatedAt",
  "resolvedAt",
  "expiresAt",
  "createdAt",
]);

function stable(value: unknown, volatile: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map((one) => stable(one, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    // 路由表的 handler 答的是对象，`undefined` 的键在线上本来就不存在。
    if (field === undefined) continue;
    out[key] = volatile.has(key) ? "<volatile>" : stable(field, volatile);
  }
  return out;
}

const NOTHING = new Set<string>();

/** 三种答法：状态一样（procedure 成功恒为 200），体规范化后逐字节相等。 */
function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  volatile: ReadonlySet<string> = NOTHING,
): void {
  const text = (answer: Answer) => canonicalJson(stable(answer.body, volatile));
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  expect(text(rest), "旧路径的体").toBe(text(old));
  expect(text(rpc), "procedure 的体").toBe(text(old));
}

/* --------------------------------- 夹具 --------------------------------- */

/** 板上一个终端节点（带 Agent 时是 Agent 节点），返回它的 id。 */
function agentNode(title: string, agentId: string | null = "claude"): string {
  const id = uuidV7();
  const now = rfc3339();
  core.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
        "labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', ?, '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
    )
    .run(
      id,
      boardId,
      title,
      JSON.stringify(
        agentId === null
          ? { kind: "terminal" }
          : { kind: "terminal", agent: { id: agentId } },
      ),
      now,
      now,
    );
  return id;
}

/** 节点报过一次状态（于是路由门也认得它在哪块画布上）。 */
function statusRow(
  nodeId: string,
  patch: { agentId?: string; transcriptPath?: string; workspace?: string } = {},
): void {
  core.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, " +
        "updated_at, transcript_path) VALUES (?, ?, ?, 'done', 1, 1, 0, ?, ?) " +
        "ON CONFLICT(node_id) DO UPDATE SET unread = 1",
    )
    .run(
      nodeId,
      patch.workspace ?? workspaceId,
      patch.agentId ?? "claude",
      rfc3339(),
      patch.transcriptPath ?? null,
    );
}

function approval(nodeId: string, workspace = workspaceId): string {
  const pendingId = `p-${uuidV7()}`;
  const collab = {
    database: core.database,
  } as unknown as Parameters<typeof insertApproval>[0];
  insertApproval(collab, {
    pendingId,
    nodeId,
    workspaceId: workspace,
    request: { tool: "Bash" },
  });
  return pendingId;
}

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

/* ------------------------------ §39.1 目录与集成 ------------------------------ */

describe("目录、模型菜单与集成", () => {
  it("list：本机认得的 Agent", async () => {
    const answers = [
      await table("GET", "/api/agents"),
      await legacy("GET", "/api/agents"),
      await procedure("agents.list"),
    ] as const;
    expect(answers[0].status).toBe(200);
    expect(
      (answers[0].body as { id: string }[]).some((row) => row.id === "claude"),
    ).toBe(true);
    expectParity(answers);
  });

  it("models：不认识的 Agent 与不合法的 id 都是 404，原话不同", async () => {
    for (const agentId of ["nobody", "no such agent"]) {
      const path = `/api/agents/${encodeURIComponent(agentId)}/models`;
      const answers = [
        await table("GET", `/api/agents/${agentId}/models`),
        await legacy("GET", path),
        await procedure("agents.models", { agentId }),
      ] as const;
      expect(answers[0].status, agentId).toBe(404);
      expectParity(answers);
    }
  });

  it("integration：读、装、卸、修（只写数据目录与临时的 CLI 配置目录）", async () => {
    // 装与卸要找得到 hook 客户端；这台机器上找不到时域答 404，两条路照样一致。
    const verbs: readonly [string, string, string][] = [
      ["GET", "", "agents.integration"],
      ["POST", "/install", "agents.installIntegration"],
      ["POST", "/uninstall", "agents.uninstallIntegration"],
      ["POST", "/repair", "agents.repairIntegration"],
    ];
    for (const [method, suffix, name] of verbs) {
      const path = `/api/agents/claude/integration${suffix}`;
      const answers = [
        await table(method, path),
        await legacy(method, path),
        await procedure(name, { agentId: "claude" }),
      ] as const;
      if (method === "GET" || suffix === "/repair") {
        expect(answers[0].status, name).toBe(200);
        expect(answers[0].body).toMatchObject({ agentId: "claude" });
      }
      expectParity(answers);
    }
  });

  it("integration：不认识的 Agent 由集成域拒绝，码与原话一样", async () => {
    for (const [method, suffix, name] of [
      ["GET", "", "agents.integration"],
      ["POST", "/install", "agents.installIntegration"],
    ] as const) {
      const path = `/api/agents/nobody/integration${suffix}`;
      const answers = [
        await table(method, path),
        await legacy(method, path),
        await procedure(name, { agentId: "nobody" }),
      ] as const;
      expect(answers[0].status, name).toBeGreaterThanOrEqual(400);
      expect(answers[0].status, name).toBeLessThan(500);
      expectParity(answers);
    }
  });

  it("ama 的模型密钥：设、读、清，答案里从来没有值", async () => {
    const key = "sk-parity-not-real";
    const path = "/api/agents/ama/credentials/anthropic";
    const set = [
      await table("PUT", path, { apiKey: key }),
      await legacy("PUT", path, { apiKey: key }),
      await procedure("agents.setAmaCredential", {
        provider: "anthropic",
        apiKey: key,
      }),
    ] as const;
    expect(set[0].status).toBe(200);
    for (const answer of set) {
      expect(JSON.stringify(answer.body)).not.toContain(key);
    }
    expectParity(set);

    const read = [
      await table("GET", "/api/agents/ama/credentials"),
      await legacy("GET", "/api/agents/ama/credentials"),
      await procedure("agents.amaCredentials"),
    ] as const;
    expect(JSON.stringify(read[0].body)).not.toContain(key);
    expectParity(read);

    const cleared = [
      await table("DELETE", path),
      await legacy("DELETE", path),
      await procedure("agents.clearAmaCredential", { provider: "anthropic" }),
    ] as const;
    expect(
      (cleared[0].body as { providers: { isSet: boolean }[] }).providers.some(
        (entry) => entry.isSet,
      ),
    ).toBe(false);
    expectParity(cleared);
  });

  it("ama 的模型密钥：不认识的供应商、不是一行的值，由域拒绝", async () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["chatgpt", { apiKey: "x" }],
      ["openai", { apiKey: "a\nb" }],
      ["openai", { apiKey: "   " }],
    ];
    for (const [provider, body] of cases) {
      const path = `/api/agents/ama/credentials/${provider}`;
      const answers = [
        await table("PUT", path, body),
        await legacy("PUT", path, body),
        await procedure("agents.setAmaCredential", { provider, ...body }),
      ] as const;
      expect(answers[0].status, provider).toBe(400);
      expectParity(answers);
    }
    const unknown = [
      await table("DELETE", "/api/agents/ama/credentials/chatgpt"),
      await legacy("DELETE", "/api/agents/ama/credentials/chatgpt"),
      await procedure("agents.clearAmaCredential", { provider: "chatgpt" }),
    ] as const;
    expect(unknown[0].status).toBe(400);
    expectParity(unknown);
  });
});

/* ------------------------------ §39.2 节点状态 ------------------------------ */

describe("节点状态：标已读、转录、改名建议", () => {
  it("markRead：每次先把未读放回去；从没报过的节点 404", async () => {
    const node = agentNode("Claude");
    statusRow(node);
    const answers: Answer[] = [];
    for (const ask of [
      () => table("POST", `/api/agent-status/${node}/read`),
      () => legacy("POST", `/api/agent-status/${node}/read`),
      () => procedure("agents.markRead", { nodeId: node }),
    ]) {
      statusRow(node);
      answers.push(await ask());
    }
    expect(answers[0]!.status).toBe(200);
    expect(answers[0]!.body).toMatchObject({ nodeId: node, unread: false });
    expectParity(
      answers as unknown as [Answer, Answer, Answer],
      new Set(["updatedAt"]),
    );

    const gone = [
      await table("POST", `/api/agent-status/${UNKNOWN}/read`),
      await legacy("POST", `/api/agent-status/${UNKNOWN}/read`),
      await procedure("agents.markRead", { nodeId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("transcript：缺省、maxBytes、读不了的 CLI 501、没报过 404", async () => {
    const node = agentNode("Claude");
    const path = join(core.directory, `t-${node}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "整理依赖" } }),
        JSON.stringify({ type: "assistant", message: { content: "好的" } }),
      ].join("\n"),
    );
    statusRow(node, { transcriptPath: path });
    for (const [query, input] of [
      ["", {}],
      ["?maxBytes=4096", { maxBytes: 4096 }],
      ["?maxBytes=nope", { maxBytes: "nope" }],
    ] as const) {
      const route = `/api/agent-status/${node}/transcript${query}`;
      const answers = [
        await table("GET", route),
        await legacy("GET", route),
        await procedure("agents.transcript", { nodeId: node, ...input }),
      ] as const;
      expect(answers[0].status, query).toBe(200);
      expectParity(answers);
    }

    const opencode = agentNode("OpenCode", "opencode");
    statusRow(opencode, { agentId: "opencode" });
    const unreadable = [
      await table("GET", `/api/agent-status/${opencode}/transcript`),
      await legacy("GET", `/api/agent-status/${opencode}/transcript`),
      await procedure("agents.transcript", { nodeId: opencode }),
    ] as const;
    expect(unreadable[0].status).toBe(501);
    expect(unreadable[0].body).toMatchObject({ code: "unsupported" });
    expectParity(unreadable);

    const gone = [
      await table("GET", `/api/agent-status/${UNKNOWN}/transcript`),
      await legacy("GET", `/api/agent-status/${UNKNOWN}/transcript`),
      await procedure("agents.transcript", { nodeId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("suggestTitle：取转录首条用户消息；没报过 404", async () => {
    const node = agentNode("Claude");
    const path = join(core.directory, `s-${node}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({ type: "user", message: { content: "修登录页" } }),
    );
    statusRow(node, { transcriptPath: path });
    const answers = [
      await table("POST", `/api/agent-status/${node}/suggest-title`),
      await legacy("POST", `/api/agent-status/${node}/suggest-title`),
      await procedure("agents.suggestTitle", { nodeId: node }),
    ] as const;
    expect(answers[0].status).toBe(200);
    expectParity(answers);

    const gone = [
      await table("POST", `/api/agent-status/${UNKNOWN}/suggest-title`),
      await legacy("POST", `/api/agent-status/${UNKNOWN}/suggest-title`),
      await procedure("agents.suggestTitle", { nodeId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });
});

/* ------------------------------ §39.3 人的答复 ------------------------------ */

describe("人的答复：审批与关闭确认", () => {
  it("answerApproval：允许；再答 409；不存在 404；不认识的决定与缺决定 400", async () => {
    const node = agentNode("Claude");
    statusRow(node);
    const ids = [approval(node), approval(node), approval(node)];
    const answered = [
      await table("POST", `/api/approvals/${ids[0]}/answer`, {
        decision: "allow",
      }),
      await legacy("POST", `/api/approvals/${ids[1]}/answer`, {
        decision: "allow",
      }),
      await procedure("agents.answerApproval", {
        pendingId: ids[2],
        decision: "allow",
      }),
    ] as const;
    expect(answered[0].status).toBe(200);
    expect(answered[0].body).toMatchObject({ answer: "allow", route: "none" });
    expectParity(answered, VOLATILE);

    const again = [
      await table("POST", `/api/approvals/${ids[0]}/answer`, {
        decision: "deny",
      }),
      await legacy("POST", `/api/approvals/${ids[0]}/answer`, {
        decision: "deny",
      }),
      await procedure("agents.answerApproval", {
        pendingId: ids[0],
        decision: "deny",
      }),
    ] as const;
    expect(again[0].status).toBe(409);
    expectParity(again);

    const missing = [
      await table("POST", "/api/approvals/p-nobody/answer", {
        decision: "allow",
      }),
      await legacy("POST", "/api/approvals/p-nobody/answer", {
        decision: "allow",
      }),
      await procedure("agents.answerApproval", {
        pendingId: "p-nobody",
        decision: "allow",
      }),
    ] as const;
    expect(missing[0].status).toBe(404);
    expectParity(missing);

    const open = approval(node);
    for (const body of [
      { decision: "maybe" },
      {},
      { decision: "allow", expectedRevision: "1" },
    ]) {
      const answers = [
        await table("POST", `/api/approvals/${open}/answer`, body),
        await legacy("POST", `/api/approvals/${open}/answer`, body),
        await procedure("agents.answerApproval", { pendingId: open, ...body }),
      ] as const;
      expect(answers[0].status, JSON.stringify(body)).toBe(400);
      // 「expectedRevision 不是数」在契约上是形状错：只比码与状态。
      if (
        typeof (body as { expectedRevision?: unknown }).expectedRevision ===
        "string"
      ) {
        for (const answer of answers) {
          expect(answer.body).toMatchObject({ code: "bad_request" });
        }
        continue;
      }
      expectParity(answers);
    }
  });

  it("confirmControl：那边已经等超时了答 accepted: false，不是错误", async () => {
    const answers = [
      await table("POST", "/api/control/confirm/never-minted", {
        approve: true,
      }),
      await legacy("POST", "/api/control/confirm/never-minted", {
        approve: true,
      }),
      await procedure("agents.confirmControl", {
        requestId: "never-minted",
        approve: true,
      }),
    ] as const;
    expect(answers[0].body).toEqual({
      requestId: "never-minted",
      approve: true,
      accepted: false,
    });
    expectParity(answers);
  });
});

/* ---------------------------- §39.4 投递与上下文 ---------------------------- */

describe("投递记录、排队、谁读过我、连线", () => {
  function queueRow(id: string, target: string, workspace = workspaceId) {
    const now = Math.floor(Date.now() / 1000);
    core.database
      .prepare(
        "INSERT INTO agent_send_queue (id, workspace_id, source_node_id, target_node_id, origin, " +
          "message_key, body, hops, trail, created_at, expires_at, attempts, state, last_reason) " +
          "VALUES (?, ?, 'planner', ?, 'send', NULL, '不该出现的正文', 1, '[]', ?, ?, 0, 'queued', 'LEASE_HELD_BY_HUMAN')",
      )
      .run(id, workspace, target, now, now + 300);
  }

  it("deliveries：记录（缺省、limit）、排队，都不带正文；没有的工作空间 404", async () => {
    for (let index = 0; index < 3; index += 1) {
      core.database
        .prepare(
          "INSERT INTO agent_deliveries (trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt, body_chars, created_at) " +
            "VALUES (?, ?, 'a', 'b', 'delivered', 'echo', 42, ?)",
        )
        .run(`trace-${index}`, workspaceId, rfc3339());
    }
    const target = agentNode("Codex", "codex");
    queueRow("q-list-1", target);
    queueRow("q-list-2", target);
    const DELIVERIES = `/api/workspaces/${workspaceId}/deliveries`;
    for (const [query, input] of [
      ["", {}],
      ["?limit=2", { limit: 2 }],
      ["?limit=junk", { limit: "junk" }],
      [`?node=${target}`, { node: target }],
    ] as const) {
      const answers = [
        await table("GET", `${DELIVERIES}${query}`),
        await legacy("GET", `${DELIVERIES}${query}`),
        await procedure("agents.deliveries", { workspaceId, ...input }),
      ] as const;
      expect(answers[0].status, query).toBe(200);
      expect(JSON.stringify(answers[0].body)).not.toContain("不该出现的正文");
      expectParity(answers);
    }
    const gone = [
      await table("GET", `/api/workspaces/${UNKNOWN}/deliveries`),
      await legacy("GET", `/api/workspaces/${UNKNOWN}/deliveries`),
      await procedure("agents.deliveries", { workspaceId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("cancelDelivery：每条路拒收自己那一条；别的工作空间删不掉", async () => {
    const target = agentNode("Codex", "codex");
    for (const id of ["q-c-1", "q-c-2", "q-c-3"]) queueRow(id, target);
    const path = (id: string, ws = workspaceId) =>
      `/api/workspaces/${ws}/deliveries/${id}`;
    const answers = [
      await table("DELETE", path("q-c-1")),
      await legacy("DELETE", path("q-c-2")),
      await procedure("agents.cancelDelivery", {
        workspaceId,
        deliveryId: "q-c-3",
      }),
    ] as const;
    expect(answers[0].body).toEqual({ cancelled: true });
    expectParity(answers);

    queueRow("q-c-4", target);
    const foreign = [
      await table("DELETE", path("q-c-4", UNKNOWN)),
      await legacy("DELETE", path("q-c-4", UNKNOWN)),
      await procedure("agents.cancelDelivery", {
        workspaceId: UNKNOWN,
        deliveryId: "q-c-4",
      }),
    ] as const;
    expect(foreign[0].status).toBe(404);
    expectParity(foreign);
  });

  it("contextReads：总次数与最近几条，limit 的几种写法", async () => {
    const target = agentNode("Target");
    for (let index = 0; index < 4; index += 1) {
      core.database
        .prepare(
          "INSERT INTO context_reads (id, reader_node_id, target_node_id, verb, bytes, at_ms) " +
            "VALUES (?, ?, ?, 'context read', ?, ?)",
        )
        .run(uuidV7(), uuidV7(), target, 100 + index, 1_000 + index);
    }
    for (const [query, input] of [
      ["", {}],
      ["?limit=2", { limit: 2 }],
      ["?limit=0", { limit: 0 }],
      ["?limit=999", { limit: 999 }],
    ] as const) {
      const route = `/api/nodes/${target}/context-reads${query}`;
      const answers = [
        await table("GET", route),
        await legacy("GET", route),
        await procedure("agents.contextReads", { nodeId: target, ...input }),
      ] as const;
      expect(answers[0].status, query).toBe(200);
      expect(answers[0].body).toMatchObject({ total: 4 });
      expectParity(answers);
    }
  });

  it("putContextLinks：写连线；节点 id 不合法 400、工作空间不存在 404、超过 64 条 400", async () => {
    const node = agentNode("Linked");
    const other = agentNode("Other");
    const links = [{ id: other, title: "Other", kind: "terminal" }];
    const path = (ws: string, id: string) =>
      `/api/workspaces/${ws}/context-links/${id}`;
    const answers = [
      await table("PUT", path(workspaceId, node), { links }),
      await legacy("PUT", path(workspaceId, node), { links }),
      await procedure("agents.putContextLinks", {
        workspaceId,
        nodeId: node,
        links,
      }),
    ] as const;
    expect(answers[0].status).toBe(200);
    expectParity(answers, new Set(["updatedAt"]));

    const cases: readonly [string, string, unknown, number][] = [
      [workspaceId, "not-a-uuid", links, 400],
      [UNKNOWN, node, links, 404],
      [
        workspaceId,
        node,
        Array.from({ length: 65 }, () => ({
          id: uuidV7(),
          title: "x",
          kind: "terminal",
        })),
        400,
      ],
    ];
    for (const [ws, id, body, status] of cases) {
      const refused = [
        await table("PUT", path(ws, id), { links: body }),
        await legacy("PUT", path(ws, id), { links: body }),
        await procedure("agents.putContextLinks", {
          workspaceId: ws,
          nodeId: id,
          links: body,
        }),
      ] as const;
      expect(refused[0].status, `${ws} ${id}`).toBe(status);
      expectParity(refused);
    }
  });
});

/* ------------------------------ §39.5 依赖等待 ------------------------------ */

describe("依赖等待", () => {
  const DEPENDENCIES = () => `/api/workspaces/${workspaceId}/dependencies`;

  /** 等到同一个问题连问两次答得一样：服务在后台评估刚建的等待。 */
  async function settled(read: () => Promise<Answer>): Promise<void> {
    let previous = canonicalJson(stable((await read()).body, NOTHING));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const next = canonicalJson(stable((await read()).body, NOTHING));
      if (next === previous) return;
      previous = next;
    }
  }

  it("importLegacyDependencies：建一次，之后三条路答的都是那一份", async () => {
    const upstream = agentNode("Upstream");
    const downstream = agentNode("Downstream");
    const body = { nodeId: downstream, after: [upstream] };
    const first = await table("POST", DEPENDENCIES(), body);
    expect(first.status).toBe(200);
    await settled(() => table("GET", DEPENDENCIES()));
    const answers = [
      await table("POST", DEPENDENCIES(), body),
      await legacy("POST", DEPENDENCIES(), body),
      await procedure("agents.importLegacyDependencies", {
        workspaceId,
        ...body,
      }),
    ] as const;
    expect(answers[0].body).toMatchObject({
      launch: { nodeId: downstream },
    });
    expectParity(answers);

    for (const query of ["", `?nodeId=${downstream}`, "?all=true"]) {
      const input =
        query === ""
          ? {}
          : query.startsWith("?nodeId")
            ? { nodeId: downstream }
            : { all: true };
      const listed = [
        await table("GET", `${DEPENDENCIES()}${query}`),
        await legacy("GET", `${DEPENDENCIES()}${query}`),
        await procedure("agents.dependencies", { workspaceId, ...input }),
      ] as const;
      expect(listed[0].status, query).toBe(200);
      expectParity(listed);
    }
  });

  it("importLegacyDependencies：不是这个工作空间的节点 404，不是 Agent 节点 400", async () => {
    const plain = agentNode("Plain", null);
    const cases: readonly [string, Record<string, unknown>, number][] = [
      [otherWorkspaceId, { nodeId: agentNode("Elsewhere"), after: [] }, 404],
      [workspaceId, { nodeId: plain, after: [] }, 400],
      [workspaceId, { nodeId: "", after: [] }, 400],
    ];
    for (const [ws, body, status] of cases) {
      const path = `/api/workspaces/${ws}/dependencies`;
      const answers = [
        await table("POST", path, body),
        await legacy("POST", path, body),
        await procedure("agents.importLegacyDependencies", {
          workspaceId: ws,
          ...body,
        }),
      ] as const;
      expect(answers[0].status, JSON.stringify(body)).toBe(status);
      expectParity(answers);
    }
  });

  it("cancelDependency：每条路取消自己那一条；没有的 404", async () => {
    const dependencyIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await table("POST", DEPENDENCIES(), {
        nodeId: agentNode(`Down ${index}`),
        after: [agentNode(`Up ${index}`)],
      });
      const launch = (
        created.body as { launch: { dependencies: { id: string }[] } }
      ).launch;
      dependencyIds.push(launch.dependencies[0]!.id);
    }
    const path = (id: string) => `${DEPENDENCIES()}/${id}`;
    const answers = [
      await table("DELETE", path(dependencyIds[0]!)),
      await legacy("DELETE", path(dependencyIds[1]!)),
      await procedure("agents.cancelDependency", {
        workspaceId,
        dependencyId: dependencyIds[2],
      }),
    ] as const;
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({
      dependency: { state: "cancelled" },
    });
    expectParity(answers, new Set([...VOLATILE, "upstreamTitle"]));

    const gone = [
      await table("DELETE", path(UNKNOWN)),
      await legacy("DELETE", path(UNKNOWN)),
      await procedure("agents.cancelDependency", {
        workspaceId,
        dependencyId: UNKNOWN,
      }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });
});

/* -------------------------------- 投递门 --------------------------------- */

/**
 * 服务器壳上的成员：w1 = 本文件的工作空间，w2 = 另一块。角色经真的编译与
 * `permits`；对象属于哪块画布由真的库查询答（节点看 `agent_status`，审批看
 * `agent_approvals`）。
 */
const GRANTS: Record<string, Record<"w1" | "w2", ShareRole | undefined>> = {
  driver: { w1: "driver", w2: undefined },
  operator: { w1: "operator", w2: undefined },
  editor: { w1: "editor", w2: undefined },
  viewer: { w1: "viewer", w2: undefined },
  outsider: { w1: undefined, w2: "driver" },
  stranger: { w1: undefined, w2: undefined },
};

function subject(name: string): AuthorizationSubject {
  return {
    principalId: name,
    kind: "member",
    scopes: [scope("identity:read")],
  };
}

function granted(principalId: string): Scope[] {
  const grants = GRANTS[principalId];
  if (grants === undefined) return [];
  const out: Scope[] = [];
  if (grants.w1 !== undefined) out.push(...roleScopes(grants.w1, workspaceId));
  if (grants.w2 !== undefined) {
    out.push(...roleScopes(grants.w2, otherWorkspaceId));
  }
  return out;
}

describe("投递门：成员经旧路径与 procedure 被同一道路由门拦下", () => {
  beforeAll(() => {
    installRouteGuard(
      createRouteGuard({
        database: core.database,
        permits: (who, required) =>
          permits([...who.scopes, ...granted(who.principalId)], required),
        effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
      }),
    );
  });
  afterAll(() => resetRouteGuard());

  /** 旧路径与 procedure 对同一个成员答同一个码、状态与原话。 */
  async function both(
    as: string,
    method: string,
    path: string,
    body: unknown,
    name: string,
    input: unknown,
  ): Promise<[Answer, Answer]> {
    const rest = await legacy(method, path, body, as);
    const rpc = await procedure(name, input, as);
    expect(rpc.status, `${as} ${name}`).toBe(
      rest.status >= 400 ? rest.status : 200,
    );
    if (rest.status >= 400) {
      expect(rpc.body, `${as} ${name}`).toEqual(rest.body);
    }
    return [rest, rpc];
  }

  const FORBIDDEN = { code: "forbidden", message: "没有这项权限" };

  it("审批：没有 approval:answer 的人（viewer、editor）与别的画布上的 driver 答不了", async () => {
    const node = agentNode("Gate");
    statusRow(node);
    for (const as of ["viewer", "editor", "outsider", "stranger"]) {
      const pending = approval(node);
      const [rest] = await both(
        as,
        "POST",
        `/api/approvals/${pending}/answer`,
        { decision: "allow" },
        "agents.answerApproval",
        { pendingId: pending, decision: "allow" },
      );
      expect(rest.status, as).toBe(403);
      expect(rest.body).toEqual(FORBIDDEN);
      // 拦在门上：审批还开着，没有人替谁答。
      const row = core.database
        .prepare("SELECT answer FROM agent_approvals WHERE id = ?")
        .get(pending) as { answer: string | null };
      expect(row.answer, as).toBeNull();
    }
  });

  it("审批：这块画布上的 driver 答得了（两条路各答自己那一条）", async () => {
    const node = agentNode("Gate");
    statusRow(node);
    const viaRest = approval(node);
    const viaRpc = approval(node);
    const rest = await legacy(
      "POST",
      `/api/approvals/${viaRest}/answer`,
      { decision: "deny" },
      "driver",
    );
    const rpc = await procedure(
      "agents.answerApproval",
      { pendingId: viaRpc, decision: "deny" },
      "driver",
    );
    expect(rest.status).toBe(200);
    expect(rpc.status).toBe(200);
    expect(rest.body).toMatchObject({ answer: "deny" });
    expect(rpc.body).toMatchObject({ answer: "deny" });
  });

  it("关闭确认：成员一律答不了（查不到它在哪块画布上），owner 照旧", async () => {
    for (const as of ["driver", "viewer", "outsider"]) {
      const [rest] = await both(
        as,
        "POST",
        "/api/control/confirm/some-request",
        { approve: true },
        "agents.confirmControl",
        { requestId: "some-request", approve: true },
      );
      expect(rest.status, as).toBe(403);
      expect(rest.body).toEqual(FORBIDDEN);
    }
    const owner = await procedure("agents.confirmControl", {
      requestId: "some-request",
      approve: true,
    });
    expect(owner.status).toBe(200);
  });

  it("不跨工作空间读：别的画布上的成员读不到这块画布的节点、投递、连线与依赖", async () => {
    const node = agentNode("Private");
    statusRow(node);
    const reads: readonly [string, string, unknown, string, unknown][] = [
      [
        "GET",
        `/api/nodes/${node}/context-reads`,
        undefined,
        "agents.contextReads",
        { nodeId: node },
      ],
      [
        "GET",
        `/api/agent-status/${node}/transcript`,
        undefined,
        "agents.transcript",
        { nodeId: node },
      ],
      [
        "POST",
        `/api/agent-status/${node}/read`,
        undefined,
        "agents.markRead",
        { nodeId: node },
      ],
      [
        "GET",
        `/api/workspaces/${workspaceId}/deliveries`,
        undefined,
        "agents.deliveries",
        { workspaceId },
      ],
      [
        "GET",
        `/api/workspaces/${workspaceId}/dependencies`,
        undefined,
        "agents.dependencies",
        { workspaceId },
      ],
      [
        "PUT",
        `/api/workspaces/${workspaceId}/context-links/${node}`,
        { links: [] },
        "agents.putContextLinks",
        { workspaceId, nodeId: node, links: [] },
      ],
    ];
    for (const [method, path, body, name, input] of reads) {
      for (const as of ["outsider", "stranger"]) {
        const [rest] = await both(as, method, path, body, name, input);
        expect(rest.status, `${as} ${name}`).toBe(403);
        expect(rest.body).toEqual(FORBIDDEN);
      }
    }
    // 同一块画布上的 viewer 读得到（写不了连线）。
    const [seen] = await both(
      "viewer",
      "GET",
      `/api/nodes/${node}/context-reads`,
      undefined,
      "agents.contextReads",
      { nodeId: node },
    );
    expect(seen.status).toBe(200);
    const [write] = await both(
      "viewer",
      "PUT",
      `/api/workspaces/${workspaceId}/context-links/${node}`,
      { links: [] },
      "agents.putContextLinks",
      { workspaceId, nodeId: node, links: [] },
    );
    expect(write.status).toBe(403);
  });

  it("本机管理：成员改不了 ama 的密钥与集成；目录对至少被共享了一块画布的人放行", async () => {
    for (const as of ["driver", "viewer"]) {
      const [key] = await both(
        as,
        "PUT",
        "/api/agents/ama/credentials/openai",
        { apiKey: "sk-not-real" },
        "agents.setAmaCredential",
        { provider: "openai", apiKey: "sk-not-real" },
      );
      expect(key.status, as).toBe(403);
      const [install] = await both(
        as,
        "POST",
        "/api/agents/claude/integration/install",
        undefined,
        "agents.installIntegration",
        { agentId: "claude" },
      );
      expect(install.status, as).toBe(403);
    }
    const [listed] = await both(
      "viewer",
      "GET",
      "/api/agents",
      undefined,
      "agents.list",
      {},
    );
    expect(listed.status).toBe(200);
    const [hidden] = await both(
      "stranger",
      "GET",
      "/api/agents",
      undefined,
      "agents.list",
      {},
    );
    expect(hidden.status).toBe(403);
  });
});

/* ------------------------------ 入参形状错 ------------------------------ */

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("缺字段、类型不对：码与状态与原 handler 一致，procedure 带 issues", async () => {
    const node = agentNode("Shape");
    const cases: readonly [string, string, unknown, string, unknown][] = [
      [
        "POST",
        "/api/control/confirm/x",
        {},
        "agents.confirmControl",
        { requestId: "x" },
      ],
      [
        "PUT",
        "/api/agents/ama/credentials/openai",
        {},
        "agents.setAmaCredential",
        { provider: "openai" },
      ],
      [
        "POST",
        `/api/workspaces/${workspaceId}/dependencies`,
        { nodeId: node },
        "agents.importLegacyDependencies",
        { workspaceId, nodeId: node },
      ],
      [
        "PUT",
        `/api/workspaces/${workspaceId}/context-links/${node}`,
        { links: "nope" },
        "agents.putContextLinks",
        { workspaceId, nodeId: node, links: "nope" },
      ],
    ];
    for (const [method, path, body, name, input] of cases) {
      const old = await table(method, path, body);
      const rest = await legacy(method, path, body);
      const rpc = await procedure(name, input);
      for (const answer of [old, rest, rpc]) {
        expect(answer.status, name).toBe(400);
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------- 两张表 ------------------------------- */

describe("契约与 core 的两张表（agents）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("agents."),
  );

  /** 只经 procedure 的（§39.7 适配器的安装）：没有旧路径。 */
  const RPC_ONLY = new Set(["agents.adapterInstall", "agents.installAdapter"]);

  it("23 条都在契约里，除 §39.7 外每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [
        "adapterInstall",
        "amaCredentials",
        "answerApproval",
        "cancelDelivery",
        "cancelDependency",
        "clearAmaCredential",
        "confirmControl",
        "contextReads",
        "deliveries",
        "dependencies",
        "importLegacyDependencies",
        "installAdapter",
        "installIntegration",
        "integration",
        "list",
        "markRead",
        "models",
        "putContextLinks",
        "repairIntegration",
        "setAmaCredential",
        "suggestTitle",
        "transcript",
        "uninstallIntegration",
      ].map((name) => `agents.${name}`),
    );
    for (const entry of entries) {
      if (RPC_ONLY.has(entry.name)) {
        expect(entry.meta.legacy, entry.name).toBeUndefined();
        continue;
      }
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里", () => {
    for (const entry of entries) {
      if (RPC_ONLY.has(entry.name)) continue;
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = core.server.router.match(legacyRoute.path);
      expect(
        found?.entry.methods ?? ["GET", "POST", "PUT", "DELETE"],
      ).toContain(legacyRoute.method);
    }
  });

  it("答审批与关闭确认的要 approval:answer，与旧路径同一档", () => {
    for (const name of ["agents.answerApproval", "agents.confirmControl"]) {
      expect(entries.find((entry) => entry.name === name)?.meta.scope).toBe(
        "approval:answer",
      );
    }
  });

  it("绑在路径里工作空间上的，workspaceKey 都写了", () => {
    for (const entry of entries) {
      if (!entry.meta.legacy?.path.startsWith("/api/workspaces/")) continue;
      expect(entry.meta.workspaceKey, entry.name).toBe("workspaceId");
    }
  });
});
