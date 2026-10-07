import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordNodeCreator } from "../../desktop/src/core/identity/creators";
import { serve } from "./serve";
import { tempDir } from "../../desktop/src/core/testing/temp-dir";

/**
 * 装配级用例：契约 §23 的角色阶梯在服务器壳上真的生效。
 *
 * 一个 owner（配对出来的管理员），w1 上两个 operator（A、B）、一个 driver、
 * 一个 editor、一个 viewer，外加只在 w2 上的局外人。回答的是：
 *
 *   1. operator 起的终端，他自己写得进、答得了上面的审批；另一个 operator 不行，
 *      driver 行；
 *   2. 创建者 = 触发者：A 的协调者建的节点（`node_creators` 记着 A），不管谁的
 *      页面替它起终端，创建者都是 A；
 *   3. ACP 与工作流按会话 / 节点 / 画板 / 运行查出画布再判，不再一律 403；
 *      工作流关卡要 operator。
 *
 * 断言只看路由门：放行的请求之后答 200 还是 400 / 404 / 409 是各域的事，这里
 * 只要求「不是 403」。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../desktop/src/core/db/migrations");

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface Person {
  readonly cookie: string;
  readonly csrf: string;
  readonly principalId: string;
}

let running: Awaited<ReturnType<typeof serve>>;
let origin: string;
let admin: Person;
let operatorA: Person;
let operatorB: Person;
let driver: Person;
let editor: Person;
let viewer: Person;
let outsider: Person;
let w1: string;
let w2: string;
let board: string;

function call(
  path: string,
  options: { method?: string; person?: Person; body?: unknown } = {},
): Promise<Answer> {
  const url = new URL(path, origin);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((done, failed) => {
    const headers: Record<string, string> = { origin };
    if (options.person !== undefined) {
      headers.cookie = options.person.cookie;
      headers["x-armadra-csrf"] = options.person.csrf;
    }
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

function person(answer: Answer): Person {
  const cookies = answer.headers["set-cookie"] as string[];
  const body = JSON.parse(answer.body) as {
    csrfToken: string;
    device: { principalId: string };
  };
  return {
    cookie: cookies
      .map((value) => (value.split(";")[0] as string).trim())
      .join("; "),
    csrf: body.csrfToken,
    principalId: body.device.principalId,
  };
}

async function join_(
  role: string,
  workspaceId: string,
  displayName: string,
): Promise<Person> {
  const issued = await call("/api/identity/invitations", {
    method: "POST",
    person: admin,
    body: { role, targetWorkspaceId: workspaceId },
  });
  expect(issued.status).toBe(201);
  const { token } = JSON.parse(issued.body) as { token: string };
  const answer = await call("/api/identity/register", {
    method: "POST",
    body: { token, displayName, password: "correct horse battery" },
  });
  expect(answer.status).toBe(201);
  return person(answer);
}

async function workspace(name: string): Promise<string> {
  const root = tempDir(`armadra-roles-${name}-`);
  writeFileSync(join(root, "README.md"), name);
  const created = await call("/api/workspaces", {
    method: "POST",
    person: admin,
    body: { name, rootPath: root },
  });
  expect(created.status).toBe(200);
  return (JSON.parse(created.body) as { id: string }).id;
}

/** 这个人发这个请求，路由门放不放行（403 之外的一切都算放行）。 */
async function passes(
  who: Person,
  path: string,
  method = "POST",
  body: unknown = {},
): Promise<boolean> {
  const answer = await call(path, {
    method,
    person: who,
    ...(method === "GET" ? {} : { body }),
  });
  return answer.status !== 403;
}

async function openTerminal(who: Person, nodeId?: string): Promise<string> {
  const answer = await call("/api/terminals", {
    method: "POST",
    person: who,
    body: {
      workspaceId: w1,
      cwd: tmpdir(),
      ...(nodeId === undefined ? {} : { nodeId }),
    },
  });
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { id: string }).id;
}

/**
 * 已经有一个终端行：创建者写死（「谁起的」由上面的 HTTP 用例覆盖）。Windows 的
 * CI 上服务器壳起不了真终端，审批与 ACP 的判定只要行在就够。
 */
function terminalRow(creator: string): string {
  const id = randomUUID();
  database()
    .prepare(
      "INSERT INTO terminal_sessions (id, workspace_id, cwd, shell, status, created_at, creator_principal_id) " +
        "VALUES (?, ?, ?, 'sh', 'exited', ?, ?)",
    )
    .run(id, w1, tmpdir(), new Date().toISOString(), creator);
  return id;
}

/** 服务器壳在 Windows 的 CI 上起不了真终端（没有会话宿主）。 */
const spawns = process.platform !== "win32";

async function creatorOf(sessionId: string): Promise<string> {
  const answer = await call(`/api/terminals/${sessionId}`, { person: viewer });
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { creatorPrincipalId: string })
    .creatorPrincipalId;
}

function database() {
  return running.core.db.database;
}

function pendingApproval(sessionId: string): string {
  const id = randomUUID();
  database()
    .prepare(
      "INSERT INTO agent_approvals (id, node_id, workspace_id, request_json, created_at, session_id) " +
        "VALUES (?, ?, ?, '{}', ?, ?)",
    )
    .run(id, randomUUID(), w1, new Date().toISOString(), sessionId);
  return id;
}

beforeAll(async () => {
  const dataDir = tempDir("armadra-server-roles-");
  const webRoot = tempDir("armadra-web-roles-");
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
  running = await serve({
    listen: { host: "127.0.0.1", port: 0 },
    publicOrigins: [],
    dataDir,
    webRoot,
    deviceName: "管理员的电脑",
    pairing: true,
    env: {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    },
    stdout: () => {},
    moduleDir: here,
  });
  origin = running.origin;
  const paired = await call("/api/identity/pair", {
    method: "POST",
    body: { ticket: running.pairingTicket },
  });
  expect(paired.status).toBe(200);
  admin = person(paired);

  w1 = await workspace("w1");
  w2 = await workspace("w2");
  operatorA = await join_("operator", w1, "甲");
  operatorB = await join_("operator", w1, "乙");
  driver = await join_("driver", w1, "驾驶");
  editor = await join_("editor", w1, "编辑");
  viewer = await join_("viewer", w1, "只读");
  outsider = await join_("viewer", w2, "局外人");
  const created = await call(`/api/workspaces/${w1}/boards`, {
    method: "POST",
    person: admin,
    body: { name: "看板" },
  });
  expect(created.status).toBe(200);
  board = (JSON.parse(created.body) as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await running?.stop();
});

describe("自己起的终端（契约 §23.1）", () => {
  it.runIf(spawns)(
    "operator 写得进自己的，另一个 operator 与 editor 不行，driver 行",
    async () => {
      const mine = await openTerminal(operatorA);
      expect(await creatorOf(mine)).toBe(operatorA.principalId);
      const paste = `/api/terminals/${mine}/paste`;
      expect(await passes(operatorA, paste)).toBe(true);
      expect(await passes(operatorB, paste)).toBe(false);
      expect(await passes(editor, paste)).toBe(false);
      expect(await passes(viewer, paste)).toBe(false);
      expect(await passes(driver, paste)).toBe(true);
    },
  );

  it("审批：operator 答自己终端上的；别人起的、自动化起的只有 driver", async () => {
    const mine = terminalRow(operatorA.principalId);
    const others = terminalRow(driver.principalId);
    // 自动化冷启动起的终端：创建者是自动化的创建者，也就是 owner。
    const automated = terminalRow("");
    expect(await creatorOf(mine)).toBe(operatorA.principalId);

    const answer = (id: string) => `/api/approvals/${id}/answer`;
    const onMine = pendingApproval(mine);
    expect(await passes(operatorB, answer(onMine))).toBe(false);
    expect(await passes(editor, answer(onMine))).toBe(false);
    expect(
      await passes(operatorA, answer(onMine), "POST", { decision: "deny" }),
    ).toBe(true);
    const onOthers = pendingApproval(others);
    expect(await passes(operatorA, answer(onOthers))).toBe(false);
    expect(
      await passes(driver, answer(onOthers), "POST", { decision: "deny" }),
    ).toBe(true);
    const onAutomated = pendingApproval(automated);
    expect(await passes(operatorA, answer(onAutomated))).toBe(false);
    expect(
      await passes(driver, answer(onAutomated), "POST", { decision: "deny" }),
    ).toBe(true);
  });

  it.runIf(spawns)(
    "创建者 = 触发者：A 的协调者建的节点，谁的页面替它起终端都是 A 的",
    async () => {
      // `open-agent` / ama runner 在建节点时记下的那一笔。
      const nodeId = randomUUID();
      recordNodeCreator(
        database(),
        { nodeId, workspaceId: w1 },
        operatorA.principalId,
      );
      const byDriver = await openTerminal(driver, nodeId);
      expect(await creatorOf(byDriver)).toBe(operatorA.principalId);
      const byOwner = await openTerminal(admin, nodeId);
      expect(await creatorOf(byOwner)).toBe(operatorA.principalId);
      expect(await passes(operatorA, `/api/terminals/${byDriver}/paste`)).toBe(
        true,
      );
      expect(await passes(operatorB, `/api/terminals/${byDriver}/paste`)).toBe(
        false,
      );
      const onTeam = pendingApproval(byOwner);
      expect(await passes(operatorB, `/api/approvals/${onTeam}/answer`)).toBe(
        false,
      );
      expect(
        await passes(operatorA, `/api/approvals/${onTeam}/answer`, "POST", {
          decision: "deny",
        }),
      ).toBe(true);
      // 驱动切换按节点判；请求体故意不成立，放行之后由域答 400，不真的切。
      const driverSwitch = `/api/acp/nodes/${nodeId}/driver`;
      expect(await passes(operatorB, driverSwitch)).toBe(false);
      expect(await passes(operatorA, driverSwitch)).toBe(true);
    },
  );
});

describe("ACP 与工作流按对象落到画布（契约 §23.3）", () => {
  it("ACP：开会话要 operator，看镜像 viewer 就够，写别人的会话要 driver", async () => {
    const open = (who: Person) =>
      passes(who, "/api/acp/sessions", "POST", { workspaceId: w1 });
    expect(await open(editor)).toBe(false);
    expect(await open(outsider)).toBe(false);
    expect(await open(operatorA)).toBe(true);
    const mine = terminalRow(operatorA.principalId);
    expect(await passes(viewer, `/api/acp/sessions/${mine}/log`, "GET")).toBe(
      true,
    );
    expect(await passes(outsider, `/api/acp/sessions/${mine}/log`, "GET")).toBe(
      false,
    );
    const prompt = `/api/acp/sessions/${mine}/prompt`;
    expect(await passes(operatorB, prompt)).toBe(false);
    expect(await passes(operatorA, prompt)).toBe(true);
    expect(await passes(driver, prompt)).toBe(true);
  });

  it("工作流：列表要带画板，起跑与关卡要 operator，模板只读", async () => {
    const runs = `/api/workflows/runs?boardId=${board}`;
    expect(await passes(viewer, runs, "GET")).toBe(true);
    expect(await passes(outsider, runs, "GET")).toBe(false);
    expect(await passes(viewer, "/api/workflows/runs", "GET")).toBe(false);
    expect(await passes(admin, "/api/workflows/runs", "GET")).toBe(true);

    expect(await passes(operatorA, "/api/workflows/templates", "GET")).toBe(
      true,
    );
    expect(await passes(editor, "/api/workflows/templates", "GET")).toBe(false);
    expect(
      await passes(operatorA, "/api/workflows/templates", "POST", {
        name: "x",
        template: {},
      }),
    ).toBe(false);

    const start = (who: Person) =>
      passes(who, "/api/workflows/runs", "POST", {
        templateId: "missing",
        boardId: board,
      });
    expect(await start(editor)).toBe(false);
    expect(await start(operatorA)).toBe(true);

    const runId = randomUUID();
    // 快照要是真模板的形状：`{}` 没有 title，查运行时出参校验会失败（只打日志，
    // 用例只看 403 与否，所以以前一直是绿的）。
    const snapshot = JSON.stringify({
      version: 1,
      title: "关卡",
      params: [],
      roles: [],
      links: [],
      steps: [],
    });
    database()
      .prepare(
        "INSERT INTO workflow_runs (id, template_id, template_version, template_json, workspace_id, board_id, status, started_at) " +
          "VALUES (?, 'missing', 1, ?, ?, ?, 'waiting', ?)",
      )
      .run(runId, snapshot, w1, board, Date.now());
    const gate = `/api/workflows/runs/${runId}/gates/s1`;
    const decision = { decision: "approve" };
    expect(await passes(viewer, gate, "POST", decision)).toBe(false);
    expect(await passes(editor, gate, "POST", decision)).toBe(false);
    expect(await passes(outsider, gate, "POST", decision)).toBe(false);
    expect(await passes(operatorB, gate, "POST", decision)).toBe(true);
    const read = await call(`/api/workflows/runs/${runId}`, {
      method: "GET",
      person: viewer,
    });
    expect(read.status).toBe(200);
  });
});
