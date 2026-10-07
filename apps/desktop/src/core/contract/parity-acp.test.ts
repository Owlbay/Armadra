import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "../acp/fixture";
import { createBoard } from "../canvas/boards";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import type { AuthorizationSubject } from "../identity/authorize";
import { installRouteGuard, resetRouteGuard } from "../identity/gate";
import { type ShareRole, roleScopes } from "../identity/roles";
import { createRouteGuard } from "../identity/route-access";
import { type Scope, permits, scope } from "../identity/scopes";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { type JsonValue, canonicalJson } from "./message";

/**
 * acp 域的对偶测试（契约 §43.1；工程规范化包 §3 ④）。
 *
 * 与 `parity-agents.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条
 * handler、旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新
 * procedure。会开会话的动作每个答法各用自己的节点，比较前把每次都会变的字段换成
 * 占位；失败的码、状态与原话相等（procedure 多一个 `requestId`）。
 *
 * 会话是真的终端管理器上的一行，ACP Agent 是真子进程（假 Agent）。
 *
 * 单独一节写**拒绝路径**（投递门）：服务器壳上的成员经旧路径与 procedure 被同一道
 * 路由门拦下——只读的人开不了会话、发不了提示；不是自己开的会话，要 driver 才写得
 * 进去，被拒时会话里什么都没写；别的画布上的人读不到镜像、也不能拿别的画布上的
 * 节点来起会话（不跨工作空间）；`acp.*` 里没有答审批的动词（审批走 `agents.*`，
 * `approval:answer`，由 `parity-agents` 守着）。
 */

let open: AcpCore;
let base: string;
let workspaceId: string;
let otherWorkspaceId: string;
let otherNode: string;

beforeAll(async () => {
  open = await acpCore();
  const core = open.core;
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
  workspaceId = open.workspaceId;
  const otherRoot = join(core.directory, "other");
  mkdirSync(otherRoot);
  const created = await core.call("POST", "/api/workspaces", {
    name: "other",
    rootPath: otherRoot,
  });
  expect(created.status).toBe(200);
  otherWorkspaceId = (created.body as { id: string }).id;
  const otherBoard = createBoard(core.database, otherWorkspaceId, "Other");
  otherNode = uuidV7();
  const now = rfc3339();
  core.database
    .prepare(
      "INSERT INTO nodes (id, board_id, type, title, color, x, y, width, height, " +
        "labels_json, note, data_json, created_at, updated_at) " +
        "VALUES (?, ?, 'terminal', 'Other', '#0a84ff', 0, 0, 240, 200, '[]', '', ?, ?, ?)",
    )
    .run(
      otherNode,
      otherBoard.id,
      JSON.stringify({ kind: "terminal", agent: { id: FAKE_AGENT } }),
      now,
      now,
    );
  // 节点报过一次状态，路由门才认得它在别的画布上（`lookups.nodeWorkspace`）。
  core.database
    .prepare(
      "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, updated_at) " +
        "VALUES (?, ?, ?, 'done', 0, 1, 0, ?)",
    )
    .run(otherNode, otherWorkspaceId, FAKE_AGENT, now);
});

afterAll(async () => {
  await open.core.server.close();
  await open.stop();
});

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
  const answer = await open.core.call(method, path, body);
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
  const text = await response.text();
  const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

/** 每个会话、每次调用都会变的字段。 */
const VOLATILE = new Set([
  "id",
  "sessionKey",
  "ownerNodeId",
  "workspaceId",
  "createdAt",
  "endedAt",
  "lastOutputAt",
  "turnId",
  "sessionId",
  "at",
  "updatedAt",
  "startedAt",
  "pid",
]);

function stable(value: unknown, volatile: ReadonlySet<string>): JsonValue {
  if (Array.isArray(value)) return value.map((one) => stable(one, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
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

const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const SESSIONS = "/api/acp/sessions";

/** 一次开会话的三种答法各用一个新节点。 */
async function perNode<T>(
  run: (kind: "table" | "legacy" | "rpc", nodeId: string) => Promise<T>,
): Promise<readonly [T, T, T]> {
  const out: T[] = [];
  for (const kind of ["table", "legacy", "rpc"] as const) {
    out.push(await run(kind, await open.node()));
  }
  return out as unknown as readonly [T, T, T];
}

function create(
  kind: "table" | "legacy" | "rpc",
  nodeId: string,
  extra: Record<string, unknown> = {},
): Promise<Answer> {
  const body = {
    workspaceId,
    nodeId,
    cwd: open.core.directory,
    agentId: FAKE_AGENT,
    ...extra,
  };
  if (kind === "table") return table("POST", SESSIONS, body);
  if (kind === "legacy") return legacy("POST", SESSIONS, body);
  return procedure("acp.createSession", body);
}

/** 一个开好的会话（用 table 答法开，供后面各读写用）。 */
async function session(prompt?: string) {
  const nodeId = await open.node();
  const created = await create("table", nodeId, prompt ? { prompt } : {});
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { nodeId, id: (created.body as { id: string }).id };
}

async function turnDone(sessionId: string): Promise<void> {
  await until(
    async () =>
      (await table("GET", `${SESSIONS}/${sessionId}/log`)).body as {
        entries: unknown[];
      },
    (log) => log.entries.length >= 2,
  );
}

/* -------------------------------- 开会话 -------------------------------- */

describe("开会话", () => {
  it("createSession：开出一行 ACP 终端会话，答的就是那一行", async () => {
    const answers = await perNode((kind, nodeId) => create(kind, nodeId));
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({
      backend: "acp",
      status: "running",
    });
    expectParity(answers, VOLATILE);
  });

  it("createSession：带 prompt 时作为第一条提示发出，同一个节点再开答同一行", async () => {
    const answers = await perNode((kind, nodeId) =>
      create(kind, nodeId, { prompt: "hello there" }),
    );
    for (const answer of answers) expect(answer.status).toBe(200);
    expectParity(answers, VOLATILE);
    const rpcRow = answers[2].body as { id: string; ownerNodeId: string };
    await turnDone(rpcRow.id);
    const again = await procedure("acp.createSession", {
      workspaceId,
      nodeId: rpcRow.ownerNodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
    });
    expect((again.body as { id: string }).id).toBe(rpcRow.id);
  });

  it("createSession：缺字段、不认识的 Agent、不认识的权限模式被拒，码与原话一样", async () => {
    const node = await open.node();
    const cases: readonly Record<string, unknown>[] = [
      {},
      { workspaceId, nodeId: node, cwd: open.core.directory },
      {
        workspaceId,
        nodeId: node,
        cwd: open.core.directory,
        agentId: "nobody",
      },
      {
        workspaceId,
        nodeId: node,
        cwd: open.core.directory,
        agentId: FAKE_AGENT,
        permissionMode: "nonsense",
      },
    ];
    for (const body of cases) {
      const answers = [
        await table("POST", SESSIONS, body),
        await legacy("POST", SESSIONS, body),
        await procedure("acp.createSession", body),
      ] as const;
      expect(answers[0].status, JSON.stringify(body)).toBeGreaterThanOrEqual(
        400,
      );
      expectParity(answers);
    }
  });
});

/* --------------------------------- 回合 --------------------------------- */

describe("回合、镜像、模式与模型", () => {
  it("prompt、log：一轮对话的转录与回合标识", async () => {
    const prompts = await perNode(async (kind, nodeId) => {
      const created = await create(kind, nodeId);
      const id = (created.body as { id: string }).id;
      const path = `${SESSIONS}/${id}/prompt`;
      const body = { text: "ping" };
      const answer =
        kind === "table"
          ? await table("POST", path, body)
          : kind === "legacy"
            ? await legacy("POST", path, body)
            : await procedure("acp.prompt", { sessionId: id, ...body });
      await turnDone(id);
      const log =
        kind === "table"
          ? await table("GET", `${SESSIONS}/${id}/log`)
          : kind === "legacy"
            ? await legacy("GET", `${SESSIONS}/${id}/log`)
            : await procedure("acp.log", { sessionId: id });
      return { answer, log };
    });
    expectParity(
      [prompts[0].answer, prompts[1].answer, prompts[2].answer],
      VOLATILE,
    );
    expect(prompts[0].answer.body).toMatchObject({
      turnId: expect.any(String),
    });
    expectParity([prompts[0].log, prompts[1].log, prompts[2].log], VOLATILE);
    const entries = (
      prompts[2].log.body as {
        entries: { role: string; blocks: { text?: string }[] }[];
      }
    ).entries;
    expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant"]);
    expect(entries[1]?.blocks[0]?.text).toBe("echo: ping");
  });

  it("log：增量读，after 在旧路径上是字符串、在 procedure 上是数字", async () => {
    const { id } = await session("once");
    await turnDone(id);
    const full = (await table("GET", `${SESSIONS}/${id}/log`)).body as {
      endOffset: number;
    };
    const answers = [
      await table("GET", `${SESSIONS}/${id}/log?after=${full.endOffset}`),
      await legacy("GET", `${SESSIONS}/${id}/log?after=${full.endOffset}`),
      await procedure("acp.log", { sessionId: id, after: full.endOffset }),
    ] as const;
    expect((answers[0].body as { entries: unknown[] }).entries).toEqual([]);
    expectParity(answers, VOLATILE);
    const text = await procedure("acp.log", {
      sessionId: id,
      after: String(full.endOffset),
    });
    expect(canonicalJson(stable(text.body, VOLATILE))).toBe(
      canonicalJson(stable(answers[0].body, VOLATILE)),
    );
  });

  it("setMode、setModel、cancel：成功答 204（procedure 恒为 200、无体）", async () => {
    const { id } = await session();
    const mode = await table("GET", `${SESSIONS}/${id}/log`);
    const modeId = (mode.body as { modes: { currentModeId: string } }).modes
      .currentModeId;
    const verbs: readonly [string, string, string, Record<string, unknown>][] =
      [
        ["POST", "mode", "acp.setMode", { modeId }],
        ["POST", "cancel", "acp.cancel", {}],
      ];
    for (const [method, tail, name, body] of verbs) {
      const path = `${SESSIONS}/${id}/${tail}`;
      const answers = [
        await table(method, path, body),
        await legacy(method, path, body),
        await procedure(name, { sessionId: id, ...body }),
      ] as const;
      expect(answers[0].status, name).toBe(204);
      expect(answers[1].status, name).toBe(204);
      expect(answers[2].status, name).toBe(200);
      expect(answers[2].body, name).toBeUndefined();
    }
    // 假 Agent 不给模型目录：落模型被拒，三条路一样。
    const path = `${SESSIONS}/${id}/model`;
    const model = { modelId: "nope" };
    const refused = [
      await table("PUT", path, model),
      await legacy("PUT", path, model),
      await procedure("acp.setModel", { sessionId: id, ...model }),
    ] as const;
    expect(refused[0].status).toBeGreaterThanOrEqual(400);
    expectParity(refused);
  });

  it("不存在的会话、缺字段：prompt、cancel、setMode、setModel、log 的拒绝一致", async () => {
    const { id } = await session();
    const cases: readonly [string, string, string, Record<string, unknown>][] =
      [
        ["POST", `${SESSIONS}/${UNKNOWN}/prompt`, "acp.prompt", { text: "x" }],
        ["POST", `${SESSIONS}/${UNKNOWN}/cancel`, "acp.cancel", {}],
        ["POST", `${SESSIONS}/${UNKNOWN}/mode`, "acp.setMode", { modeId: "x" }],
        [
          "PUT",
          `${SESSIONS}/${UNKNOWN}/model`,
          "acp.setModel",
          { modelId: "x" },
        ],
        ["GET", `${SESSIONS}/${UNKNOWN}/log`, "acp.log", {}],
        ["POST", `${SESSIONS}/${id}/prompt`, "acp.prompt", {}],
        ["POST", `${SESSIONS}/${id}/prompt`, "acp.prompt", { text: "  " }],
        ["POST", `${SESSIONS}/${id}/mode`, "acp.setMode", {}],
        ["PUT", `${SESSIONS}/${id}/model`, "acp.setModel", {}],
      ];
    for (const [method, path, name, body] of cases) {
      const input = { sessionId: path.split("/")[4], ...body };
      const answers = [
        await table(method, path, method === "GET" ? undefined : body),
        await legacy(method, path, method === "GET" ? undefined : body),
        await procedure(name, input),
      ] as const;
      expect(answers[0].status, `${name} ${path}`).toBeGreaterThanOrEqual(400);
      expectParity(answers);
    }
  });
});

/* ------------------------------- 驱动切换 ------------------------------- */

describe("切换驱动", () => {
  it("switchDriver：切到终端再切回，答 sessionId 与是否接回", async () => {
    const node = await open.node();
    await create("table", node);
    const path = (nodeId: string) => `/api/acp/nodes/${nodeId}/driver`;
    // 同一个驱动：已经活着，答它自己，resumed 为真。
    const same = [
      await table("POST", path(node), { driver: "acp" }),
      await legacy("POST", path(node), { driver: "acp" }),
      await procedure("acp.switchDriver", { nodeId: node, driver: "acp" }),
    ] as const;
    expect(same[0].status).toBe(200);
    expect(same[0].body).toMatchObject({ resumed: true });
    expectParity(same, VOLATILE);
  });

  it("switchDriver：不认识的驱动、不存在的节点被拒，码与原话一样", async () => {
    const node = await open.node();
    for (const [target, body, name] of [
      [node, { driver: "carrier-pigeon" }, "bad driver"],
      [node, {}, "no driver"],
      [UNKNOWN, { driver: "acp" }, "unknown node"],
    ] as const) {
      const answers = [
        await table("POST", `/api/acp/nodes/${target}/driver`, body),
        await legacy("POST", `/api/acp/nodes/${target}/driver`, body),
        await procedure("acp.switchDriver", { nodeId: target, ...body }),
      ] as const;
      expect(answers[0].status, name).toBeGreaterThanOrEqual(400);
      expectParity(answers);
    }
  });
});

/* -------------------------------- 投递门 --------------------------------- */

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
        database: open.core.database,
        permits: (who, required) =>
          permits([...who.scopes, ...granted(who.principalId)], required),
        effectiveScopes: (who) => [...who.scopes, ...granted(who.principalId)],
      }),
    );
  });
  afterAll(() => resetRouteGuard());

  const FORBIDDEN = { code: "forbidden", message: "没有这项权限" };

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

  it("只读与别的画布上的人开不了会话，一行都没多出来", async () => {
    const rowsBefore = open.core.database
      .prepare("SELECT count(*) AS n FROM terminal_sessions")
      .get() as { n: number };
    for (const as of ["viewer", "outsider", "stranger"]) {
      const node = await open.node();
      const body = {
        workspaceId,
        nodeId: node,
        cwd: open.core.directory,
        agentId: FAKE_AGENT,
      };
      const [rest] = await both(
        as,
        "POST",
        SESSIONS,
        body,
        "acp.createSession",
        body,
      );
      expect(rest.status, as).toBe(403);
      expect(rest.body).toEqual(FORBIDDEN);
    }
    const rowsAfter = open.core.database
      .prepare("SELECT count(*) AS n FROM terminal_sessions")
      .get() as { n: number };
    expect(rowsAfter.n).toBe(rowsBefore.n);
  });

  it("拿别的画布上的节点来起会话是跨工作空间，operator 与 driver 都被拒", async () => {
    for (const as of ["operator", "driver"]) {
      const body = {
        workspaceId,
        nodeId: otherNode,
        cwd: open.core.directory,
        agentId: FAKE_AGENT,
      };
      const [rest] = await both(
        as,
        "POST",
        SESSIONS,
        body,
        "acp.createSession",
        body,
      );
      expect(rest.status, as).toBe(403);
    }
  });

  it("operator 与 driver 开得了；记下创建者，旧路径与 procedure 各开自己的", async () => {
    const viaRest = await open.node();
    const viaRpc = await open.node();
    const rest = await legacy(
      "POST",
      SESSIONS,
      {
        workspaceId,
        nodeId: viaRest,
        cwd: open.core.directory,
        agentId: FAKE_AGENT,
      },
      "operator",
    );
    const rpc = await procedure(
      "acp.createSession",
      {
        workspaceId,
        nodeId: viaRpc,
        cwd: open.core.directory,
        agentId: FAKE_AGENT,
      },
      "operator",
    );
    expect(rest.status).toBe(200);
    expect(rpc.status).toBe(200);
    for (const row of [rest.body, rpc.body] as { id: string }[]) {
      const creator = open.core.database
        .prepare(
          "SELECT creator_principal_id AS c FROM terminal_sessions WHERE id = ?",
        )
        .get(row.id) as { c: string | null } | undefined;
      expect(creator?.c, row.id).toBe("operator");
    }
    // 自己开的会话 operator 写得进去；别人（driver 以外）开的写不进去，见下。
    const own = (rest.body as { id: string }).id;
    const prompt = await procedure(
      "acp.prompt",
      { sessionId: own, text: "mine" },
      "operator",
    );
    expect(prompt.status).toBe(200);
  });

  it("不是自己开的会话：viewer、editor、operator、别的画布上的人写不进去，会话里什么都没写；driver 写得进去", async () => {
    const { id } = await session("seed");
    await turnDone(id);
    const mirror = async () =>
      canonicalJson(
        stable((await table("GET", `${SESSIONS}/${id}/log`)).body, VOLATILE),
      );
    const before = await mirror();
    const writes: readonly [string, string, string, Record<string, unknown>][] =
      [
        ["POST", "prompt", "acp.prompt", { text: "intruder" }],
        ["POST", "cancel", "acp.cancel", {}],
        ["POST", "mode", "acp.setMode", { modeId: "x" }],
        ["PUT", "model", "acp.setModel", { modelId: "x" }],
      ];
    for (const as of ["viewer", "editor", "operator", "outsider", "stranger"]) {
      for (const [method, tail, name, body] of writes) {
        const [rest] = await both(
          as,
          method,
          `${SESSIONS}/${id}/${tail}`,
          body,
          name,
          { sessionId: id, ...body },
        );
        expect(rest.status, `${as} ${name}`).toBe(403);
        expect(rest.body).toEqual(FORBIDDEN);
      }
    }
    // 拦在门上：没有人替谁发过提示。
    expect(await mirror()).toBe(before);

    const driver = await procedure(
      "acp.prompt",
      { sessionId: id, text: "from the driver" },
      "driver",
    );
    expect(driver.status).toBe(200);
    await until(
      async () =>
        (await table("GET", `${SESSIONS}/${id}/log`)).body as {
          entries: unknown[];
        },
      (log) => log.entries.length >= 4,
    );
  });

  it("读镜像是看终端：同画布的 viewer 读得到，别的画布上的人读不到", async () => {
    const { id } = await session();
    for (const [as, status] of [
      ["viewer", 200],
      ["driver", 200],
      ["outsider", 403],
      ["stranger", 403],
    ] as const) {
      const [rest, rpc] = await both(
        as,
        "GET",
        `${SESSIONS}/${id}/log`,
        undefined,
        "acp.log",
        { sessionId: id },
      );
      expect(rest.status, as).toBe(status);
      expect(rpc.status, as).toBe(status === 200 ? 200 : 403);
    }
  });

  it("切换别人节点的驱动要 driver；自己开的会话所在节点 operator 就够", async () => {
    const node = await open.node();
    await create("table", node);
    for (const as of ["viewer", "editor", "operator", "outsider", "stranger"]) {
      const [rest] = await both(
        as,
        "POST",
        `/api/acp/nodes/${node}/driver`,
        { driver: "acp" },
        "acp.switchDriver",
        { nodeId: node, driver: "acp" },
      );
      expect(rest.status, as).toBe(403);
      expect(rest.body).toEqual(FORBIDDEN);
    }
    const driver = await procedure(
      "acp.switchDriver",
      { nodeId: node, driver: "acp" },
      "driver",
    );
    expect(driver.status).toBe(200);
  });

  it("acp.* 里没有答审批的动词：审批与 elicitation 的答复在 agents.*（approval:answer）", () => {
    const names = contractEntries()
      .filter((entry) => entry.name.startsWith("acp."))
      .map((entry) => entry.name);
    expect(names.some((name) => /approv|answer|elicit/i.test(name))).toBe(
      false,
    );
  });
});

/* ------------------------------ 入参形状错 ------------------------------ */

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("类型不对：码与状态与原 handler 一致，procedure 带 issues", async () => {
    const { id } = await session();
    const cases: readonly [string, string, unknown, string, unknown][] = [
      [
        "POST",
        SESSIONS,
        { workspaceId: 5 },
        "acp.createSession",
        { workspaceId: 5 },
      ],
      [
        "POST",
        `${SESSIONS}/${id}/prompt`,
        { text: 5 },
        "acp.prompt",
        { sessionId: id, text: 5 },
      ],
      [
        "POST",
        `${SESSIONS}/${id}/mode`,
        { modeId: ["x"] },
        "acp.setMode",
        { sessionId: id, modeId: ["x"] },
      ],
      [
        "POST",
        "/api/acp/nodes/n/driver",
        { driver: 1 },
        "acp.switchDriver",
        { nodeId: "n", driver: 1 },
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

describe("契约与 core 的两张表（acp）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("acp."),
  );

  it("7 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [
        "cancel",
        "createSession",
        "log",
        "prompt",
        "setMode",
        "setModel",
        "switchDriver",
      ].map((name) => `acp.${name}`),
    );
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里并有人认领", () => {
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = open.core.server.router.match(legacyRoute.path);
      expect(found?.entry.methods ?? []).toContain(legacyRoute.method);
      expect(
        open.core.server.router.claimed(
          legacyRoute.method,
          found?.entry.path as string,
        ),
        entry.name,
      ).toBe(true);
    }
  });
});
