import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { installContract } from "../http/rpc";
import { routeScope } from "../http/route-scopes";
import { install as installTerminals } from "../terminal/install";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { type JsonValue, canonicalJson } from "./message";

/**
 * terminals 域的对偶测试（契约 §38；工程规范化包 §3 ④）。
 *
 * 与 `parity-files.test.ts` 同一个做法：同一份夹具问三次——路由表里原来那条
 * handler、旧 REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新
 * procedure。成功的答案按 `canonicalJson` 逐字节相等；失败的码、状态与原话相等
 * （procedure 多一个 `requestId`）。会改动会话的操作（终止、重起、接管、新开）
 * 每个答法各用自己的会话，比较前把每次都会变的字段换成占位。
 *
 * 只有一类差别是有意的：入参的**形状**错（缺字段、类型不对）在 procedure 与旧路径
 * 上由契约的入参校验先答 `bad_request`（带 `details.issues`），路由表原 handler 答
 * 它自己的那句话。这一类只比码与状态，在最后一节单独写出来。
 *
 * 终端是真的 PTY（后端钉在 `direct`），所以整份在 Windows 上跳过。
 */

const describeUnix = process.platform === "win32" ? describe.skip : describe;

let core: Fixture;
let base: string;
let workspaceId: string;
let stopTerminals: () => Promise<void>;
const sessions: string[] = [];

beforeAll(async () => {
  core = fixture([
    installWorkspaces,
    (context) => {
      const domain = installTerminals(context, { configured: "direct" });
      stopTerminals = () => domain.stop();
    },
  ]);
  installContract(core.server, {
    validateOutput: true,
    platform: core.platform,
  });
  const listener = core.server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  workspaceId = (
    (
      await core.call("POST", "/api/workspaces", {
        name: "terminals",
        rootPath: core.directory,
      })
    ).body as { id: string }
  ).id;
});

afterAll(async () => {
  for (const id of sessions) {
    await core
      .call("POST", `/api/terminals/${id}/terminate`, { mode: "session" })
      .catch(() => undefined);
  }
  await stopTerminals();
  await core.server.close();
  core.close();
});

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

/** 旧路径，经 HTTP。 */
async function legacy(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : JSON.parse(text),
  };
}

/** 新 procedure；成功取 `json`，失败去掉 `requestId`。 */
async function procedure(name: string, input?: unknown): Promise<Answer> {
  const response = await fetch(`${base}/api/rpc/${name.replace(".", "/")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.ok) return { status: response.status, body: body.json };
  expect(typeof body.requestId).toBe("string");
  const { requestId: _requestId, ...rest } = body;
  return { status: response.status, body: rest };
}

/** 每个会话、每次调用都会变的字段。 */
const VOLATILE = new Set([
  "id",
  "sessionKey",
  "createdAt",
  "endedAt",
  "lastOutputAt",
  "pid",
  "exitCode",
  "expiresAt",
]);

function stable(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = VOLATILE.has(key) ? "<volatile>" : stable(field);
  }
  return out;
}

const text = (answer: Answer) => canonicalJson(stable(answer.body));

/** 三种答法：状态一样（procedure 成功恒为 200），体规范化后逐字节相等。 */
function expectParity([old, rest, rpc]: readonly [
  Answer,
  Answer,
  Answer,
]): void {
  expect(rest.status, "旧路径的状态").toBe(old.status);
  expect(rpc.status, "procedure 的状态").toBe(
    old.status >= 400 ? old.status : 200,
  );
  expect(text(rest), "旧路径的体").toBe(text(old));
  expect(text(rpc), "procedure 的体").toBe(text(old));
}

/** 起一个会话：安静地睡着，开头打一句话，给抓屏认。 */
async function spawn(
  script = "printf hello-parity; sleep 60",
): Promise<string> {
  const created = await core.call("POST", "/api/terminals", {
    workspaceId,
    cwd: core.directory,
    command: "/bin/sh",
    args: ["-c", script],
  });
  expect(created.status).toBe(200);
  const id = (created.body as { id: string }).id;
  sessions.push(id);
  return id;
}

async function until(
  read: () => Promise<Answer>,
  ready: (answer: Answer) => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (ready(await read())) return;
    if (Date.now() > deadline) throw new Error("条件一直没有成立");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const TERMINAL = "/api/terminals";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

/** 每个答法各用一个新会话，按顺序（旧 handler、旧路径、procedure）问。 */
async function perSession(
  ask: readonly [
    (id: string) => Promise<Answer>,
    (id: string) => Promise<Answer>,
    (id: string) => Promise<Answer>,
  ],
  script?: string,
): Promise<[Answer, Answer, Answer]> {
  const answers: Answer[] = [];
  for (const one of ask) answers.push(await one(await spawn(script)));
  return answers as [Answer, Answer, Answer];
}

describeUnix("只读：后端、会话行、抓屏、会话列表", () => {
  it("backend：后端与平台", async () => {
    const answers = [
      await table("GET", `${TERMINAL}/backend`),
      await legacy("GET", `${TERMINAL}/backend`),
      await procedure("terminals.backend"),
    ] as const;
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({
      effective: "direct",
      platform: "unix",
    });
    expectParity(answers);
  });

  it("get：存在与不存在", async () => {
    const id = await spawn();
    const path = `${TERMINAL}/${id}`;
    const found = [
      await table("GET", path),
      await legacy("GET", path),
      await procedure("terminals.get", { sessionId: id }),
    ] as const;
    expect(found[0].body).toMatchObject({
      kind: "terminal",
      backend: "direct",
    });
    expectParity(found);

    const missing = `${TERMINAL}/${UNKNOWN}`;
    const gone = [
      await table("GET", missing),
      await legacy("GET", missing),
      await procedure("terminals.get", { sessionId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expect(gone[0].body).toMatchObject({ code: "not_found" });
    expectParity(gone);
  });

  it("capture：缺省、行数、保留转义，以及不存在的会话", async () => {
    const id = await spawn();
    await until(
      () => table("GET", `${TERMINAL}/${id}/capture`),
      (answer) => JSON.stringify(answer.body).includes("hello-parity"),
    );
    const variants: readonly [string, Record<string, unknown>][] = [
      ["", {}],
      ["?lines=1", { lines: 1 }],
      ["?lines=20&escapes=true", { lines: 20, escapes: true }],
      ["?escapes=false", { escapes: false }],
    ];
    for (const [query, input] of variants) {
      const path = `${TERMINAL}/${id}/capture${query}`;
      const answers = [
        await table("GET", path),
        await legacy("GET", path),
        await procedure("terminals.capture", { sessionId: id, ...input }),
      ] as const;
      expect(answers[0].status, query).toBe(200);
      expectParity(answers);
    }
    const missing = `${TERMINAL}/${UNKNOWN}/capture`;
    const gone = [
      await table("GET", missing),
      await legacy("GET", missing),
      await procedure("terminals.capture", { sessionId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("sessions：没有终端节点时是空表，工作空间不存在也是", async () => {
    for (const id of [workspaceId, UNKNOWN]) {
      const path = `/api/workspaces/${id}/sessions`;
      expectParity([
        await table("GET", path),
        await legacy("GET", path),
        await procedure("terminals.sessions", { workspaceId: id }),
      ]);
    }
  });
});

describeUnix("开会话", () => {
  const body = () => ({ workspaceId, cwd: core.directory });

  it("create：三条路各开一个，行的形状一样", async () => {
    const answers: Answer[] = [];
    const asks = [
      (input: object) => table("POST", TERMINAL, input),
      (input: object) => legacy("POST", TERMINAL, input),
      (input: object) => procedure("terminals.create", input),
    ];
    for (const ask of asks) {
      const answer = await ask({
        ...body(),
        command: "/bin/sh",
        args: ["-c", "sleep 60"],
      });
      expect(answer.status).toBe(200);
      sessions.push((answer.body as { id: string }).id);
      answers.push(answer);
    }
    expect(answers[0]!.body).toMatchObject({
      kind: "terminal",
      ownerNodeId: null,
      backend: "direct",
      generation: 1,
    });
    expectParity(answers as unknown as [Answer, Answer, Answer]);
  });

  it("create：库里的工作空间 id 不是 RFC 变体的 UUID（探针与旧库如此）也照答，出参不比旧路径挑剔", async () => {
    const odd = "00000000-0000-0000-0000-0000000000aa";
    core.database
      .prepare(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        odd,
        "odd",
        join(core.directory, "odd"),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    const input = {
      workspaceId: odd,
      cwd: core.directory,
      command: "/bin/sh",
      args: ["-c", "sleep 60"],
    };
    const answers: Answer[] = [];
    for (const ask of [
      () => table("POST", TERMINAL, input),
      () => legacy("POST", TERMINAL, input),
      () => procedure("terminals.create", input),
    ]) {
      const answer = await ask();
      expect(answer.status).toBe(200);
      sessions.push((answer.body as { id: string }).id);
      answers.push(answer);
    }
    expect(answers[0]!.body).toMatchObject({ workspaceId: odd });
    expectParity(answers as unknown as [Answer, Answer, Answer]);
  });

  it("create：域里的拒绝——节点 id 不合法、Agent 缺节点", async () => {
    for (const input of [
      { ...body(), nodeId: "not-a-uuid" },
      { ...body(), agent: { id: "claude" } },
    ]) {
      const answers = [
        await table("POST", TERMINAL, input),
        await legacy("POST", TERMINAL, input),
        await procedure("terminals.create", input),
      ] as const;
      expect(answers[0].status).toBe(400);
      expect(answers[0].body).toMatchObject({ code: "bad_request" });
      expectParity(answers);
    }
  });
});

describeUnix("写：粘贴、滚动", () => {
  it("paste：回会话行；回车、过大、不存在的会话", async () => {
    const id = await spawn("cat");
    for (const input of [
      { text: "x", enter: false },
      { text: "line", enter: true },
      { text: "no-enter-flag" },
    ]) {
      const answers = [
        await table("POST", `${TERMINAL}/${id}/paste`, input),
        await legacy("POST", `${TERMINAL}/${id}/paste`, input),
        await procedure("terminals.paste", { sessionId: id, ...input }),
      ] as const;
      expect(answers[0].status).toBe(200);
      expectParity(answers);
    }
    const huge = { text: "x".repeat(200_001) };
    const refused = [
      await table("POST", `${TERMINAL}/${id}/paste`, huge),
      await legacy("POST", `${TERMINAL}/${id}/paste`, huge),
      await procedure("terminals.paste", { sessionId: id, ...huge }),
    ] as const;
    expect(refused[0].status).toBe(400);
    expect(refused[0].body).toMatchObject({
      message: "Pasted text is too large",
    });
    expectParity(refused);

    const missing = [
      await table("POST", `${TERMINAL}/${UNKNOWN}/paste`, { text: "x" }),
      await legacy("POST", `${TERMINAL}/${UNKNOWN}/paste`, { text: "x" }),
      await procedure("terminals.paste", { sessionId: UNKNOWN, text: "x" }),
    ] as const;
    expect(missing[0].status).toBe(404);
    expectParity(missing);
  });

  it("scroll：成功答 204，过大与不存在的会话被拒", async () => {
    const id = await spawn();
    const path = `${TERMINAL}/${id}/scroll`;
    const ok = [
      await table("POST", path, { lines: 3 }),
      await legacy("POST", path, { lines: 3 }),
      await procedure("terminals.scroll", { sessionId: id, lines: 3 }),
    ] as const;
    // 路由表与旧路径答 204，procedure 的成功恒为 200、无体。
    expect(ok[0].status).toBe(204);
    expect(ok[1].status).toBe(204);
    expect(ok[2].status).toBe(200);
    expect(ok[2].body).toBeUndefined();

    const far = { lines: 10_001 };
    const refused = [
      await table("POST", path, far),
      await legacy("POST", path, far),
      await procedure("terminals.scroll", { sessionId: id, ...far }),
    ] as const;
    expect(refused[0].status).toBe(400);
    expect(refused[0].body).toMatchObject({
      message: "Scroll distance is too large",
    });
    expectParity(refused);

    const missing = `${TERMINAL}/${UNKNOWN}/scroll`;
    const gone = [
      await table("POST", missing, { lines: 1 }),
      await legacy("POST", missing, { lines: 1 }),
      await procedure("terminals.scroll", { sessionId: UNKNOWN, lines: 1 }),
    ] as const;
    expect(gone[0].status).toBeGreaterThanOrEqual(400);
    expectParity(gone);
  });
});

describeUnix("写：终止、重起、唤醒、接管", () => {
  it("terminate：缺省与三种模式；已结束的再终止仍答它现在的样子", async () => {
    for (const mode of [
      undefined,
      "interrupt",
      "process",
      "session",
    ] as const) {
      const input = mode === undefined ? undefined : { mode };
      const answers = await perSession([
        (id) => table("POST", `${TERMINAL}/${id}/terminate`, input),
        (id) => legacy("POST", `${TERMINAL}/${id}/terminate`, input),
        (id) =>
          procedure("terminals.terminate", {
            sessionId: id,
            ...(input ?? {}),
          }),
      ]);
      expect(answers[0].status, String(mode)).toBe(200);
      expectParity(answers);
    }
    const again = await perSession([
      async (id) => {
        await core.call("POST", `${TERMINAL}/${id}/terminate`, {});
        return table("POST", `${TERMINAL}/${id}/terminate`, {});
      },
      async (id) => {
        await core.call("POST", `${TERMINAL}/${id}/terminate`, {});
        return legacy("POST", `${TERMINAL}/${id}/terminate`, {});
      },
      async (id) => {
        await core.call("POST", `${TERMINAL}/${id}/terminate`, {});
        return procedure("terminals.terminate", { sessionId: id });
      },
    ]);
    expect(again[0].status).toBe(200);
    expect(again[0].body).toMatchObject({ status: "terminated" });
    expectParity(again);

    const gone = [
      await table("POST", `${TERMINAL}/${UNKNOWN}/terminate`),
      await legacy("POST", `${TERMINAL}/${UNKNOWN}/terminate`),
      await procedure("terminals.terminate", { sessionId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expect(gone[0].body).toMatchObject({ message: "没有这个终端会话" });
    expectParity(gone);
  });

  it("recycle：同一个 session_key 的下一代；不存在的会话", async () => {
    const answers = await perSession([
      (id) => table("POST", `${TERMINAL}/${id}/recycle`),
      (id) => legacy("POST", `${TERMINAL}/${id}/recycle`),
      (id) => procedure("terminals.recycle", { sessionId: id }),
    ]);
    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toMatchObject({ generation: 2 });
    expectParity(answers);

    const gone = [
      await table("POST", `${TERMINAL}/${UNKNOWN}/recycle`),
      await legacy("POST", `${TERMINAL}/${UNKNOWN}/recycle`),
      await procedure("terminals.recycle", { sessionId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("wake：不属于节点的会话答 409 not_hibernated；不存在的会话 404", async () => {
    const id = await spawn();
    const refused = [
      await table("POST", `${TERMINAL}/${id}/wake`),
      await legacy("POST", `${TERMINAL}/${id}/wake`),
      await procedure("terminals.wake", { sessionId: id }),
    ] as const;
    expect(refused[0].status).toBe(409);
    expect(refused[0].body).toMatchObject({ code: "not_hibernated" });
    expectParity(refused);

    const gone = [
      await table("POST", `${TERMINAL}/${UNKNOWN}/wake`),
      await legacy("POST", `${TERMINAL}/${UNKNOWN}/wake`),
      await procedure("terminals.wake", { sessionId: UNKNOWN }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });

  it("drive：接管、交还；不存在的会话", async () => {
    for (const action of ["takeover", "release"] as const) {
      const answers = await perSession([
        async (id) => {
          if (action === "release") {
            await core.call("POST", `${TERMINAL}/${id}/drive`, {
              action: "takeover",
            });
          }
          return table("POST", `${TERMINAL}/${id}/drive`, { action });
        },
        async (id) => {
          if (action === "release") {
            await core.call("POST", `${TERMINAL}/${id}/drive`, {
              action: "takeover",
            });
          }
          return legacy("POST", `${TERMINAL}/${id}/drive`, { action });
        },
        async (id) => {
          if (action === "release") {
            await core.call("POST", `${TERMINAL}/${id}/drive`, {
              action: "takeover",
            });
          }
          return procedure("terminals.drive", { sessionId: id, action });
        },
      ]);
      expect(answers[0].status, action).toBe(200);
      expect(answers[0].body).toMatchObject({
        state: action === "takeover" ? "humanTakeover" : "free",
      });
      expectParity(answers);
    }
    const gone = [
      await table("POST", `${TERMINAL}/${UNKNOWN}/drive`, {
        action: "release",
      }),
      await legacy("POST", `${TERMINAL}/${UNKNOWN}/drive`, {
        action: "release",
      }),
      await procedure("terminals.drive", {
        sessionId: UNKNOWN,
        action: "release",
      }),
    ] as const;
    expect(gone[0].status).toBe(404);
    expectParity(gone);
  });
});

describeUnix("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("缺字段、类型不对：码与状态与原 handler 一致，旧路径与 procedure 带 issues", async () => {
    const id = await spawn();
    const cases: readonly [string, string, unknown, string, unknown][] = [
      [
        "POST",
        `${TERMINAL}/${id}/paste`,
        {},
        "terminals.paste",
        { sessionId: id },
      ],
      [
        "POST",
        `${TERMINAL}/${id}/scroll`,
        { lines: "far" },
        "terminals.scroll",
        { sessionId: id, lines: "far" },
      ],
      [
        "POST",
        `${TERMINAL}/${id}/drive`,
        { action: "explode" },
        "terminals.drive",
        { sessionId: id, action: "explode" },
      ],
      ["POST", TERMINAL, { workspaceId }, "terminals.create", { workspaceId }],
    ];
    for (const [method, path, body, name, input] of cases) {
      const old = await table(method, path, body);
      const rest = await legacy(method, path, body);
      const rpc = await procedure(name, input);
      expect(old.status, name).toBe(400);
      expect(rest.status, name).toBe(400);
      expect(rpc.status, name).toBe(400);
      for (const answer of [old, rest, rpc]) {
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

describe("契约与 core 的两张表（terminals）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("terminals."),
  );

  it("11 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      [
        "backend",
        "capture",
        "create",
        "drive",
        "get",
        "paste",
        "recycle",
        "scroll",
        "sessions",
        "terminate",
        "wake",
      ].map((name) => `terminals.${name}`),
    );
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里", () => {
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = core.server.router.match(legacyRoute.path);
      expect(found?.entry.methods, entry.name).toContain(legacyRoute.method);
    }
  });

  it("终端的字节流不进契约：WS 路径仍在路由表里，不是任何 procedure 的旧路径", () => {
    const streams = entries.map((entry) => entry.meta.legacy?.path ?? "");
    expect(streams.some((path) => path.endsWith("/ws"))).toBe(false);
    const socket = core.server.router.match("/api/terminals/{sessionId}/ws");
    expect(socket?.entry.implemented).toBe(true);
  });
});
