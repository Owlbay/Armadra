/**
 * 工作流模板改版之后的计划升级（契约 §15.6 的追加句）：`PUT` 模板答出冻结在
 * 旧版本上的计划，`upgrade-schedules` 把参数相容的改到新版本（原来启用的仍然
 * 启用），不相容的列出要人补或已经不认的参数。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type OpenedDatabase, openDatabase } from "../db/open";
import { allScopes } from "../identity/scopes";
import { IdentityService } from "../identity/service";
import { IdentityStore } from "../identity/store";
import type { CoreRequest } from "../http/router";
import { answerWorkflowRequest, workflowRoutes } from "../workflow/routes";
import {
  type WorkflowDomain,
  setWorkflowDomain,
  setWorkflowScheduleBridge,
} from "../workflow/registry";
import { WorkflowService } from "../workflow/service";
import type { WorkflowDraft } from "../workflow/types";
import { AutomationApi, apiFailure } from "./api";
import { ScheduleEngine } from "./engine";
import { FakeDispatcher } from "./fixture";
import { ScheduleService } from "./service";
import { ScheduleStore } from "./store";
import {
  paramCompatibility,
  workflowScheduleBridge,
  workflowTargetStatus,
} from "./workflow-target";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const ORIGIN = "http://127.0.0.1:1420";
const INSTANCE = "0123456789abcdef0123456789abcdef";

const closing: (() => void)[] = [];
const directories: string[] = [];
afterEach(() => {
  setWorkflowScheduleBridge(undefined);
  setWorkflowDomain(undefined);
  for (const close of closing.splice(0)) close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function body(
  params: WorkflowDraft["params"],
  version: number,
  prompt = "审查 {{scope}}",
): WorkflowDraft {
  return {
    version,
    title: "定时审查",
    params,
    roles: [{ id: "worker", agentId: "claude" }],
    links: [],
    steps: [{ id: "s1", kind: "prompt", role: "worker", prompt, after: [] }],
  };
}

describe("paramCompatibility", () => {
  const template = body(
    [
      { name: "scope", type: "string" },
      { name: "focus", type: "string", default: "all" },
    ],
    2,
  );

  it("参数都在、多出来的有缺省值：相容", () => {
    expect(paramCompatibility(template, { scope: "src" })).toEqual({
      reason: "compatible",
      missingParams: [],
      unknownParams: [],
    });
  });

  it("新模板要的参数没有值也没有缺省：要人补", () => {
    expect(paramCompatibility(template, {})).toMatchObject({
      reason: "missing_params",
      missingParams: ["scope"],
    });
  });

  it("存着的参数新模板里没有了：不相容", () => {
    expect(
      paramCompatibility(template, { scope: "src", gone: "x" }),
    ).toMatchObject({ reason: "param_mismatch", unknownParams: ["gone"] });
  });

  it("代入之后提示词超长：不相容", () => {
    const long = body(
      [{ name: "scope", type: "string" }],
      2,
      `${"字".repeat(1995)}{{scope}}`,
    );
    expect(paramCompatibility(long, { scope: "很长的参数值" })).toMatchObject({
      reason: "param_mismatch",
    });
  });
});

function setUp() {
  const directory = mkdtempSync(join(tmpdir(), "armadra-workflow-upgrade-"));
  directories.push(directory);
  const opened: OpenedDatabase = openDatabase({
    file: join(directory, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const database = opened.database;
  database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ('ws', 'ws', ?, 'now', 'now')",
    )
    .run(directory);
  database
    .prepare(
      "INSERT INTO boards (id, workspace_id, name, created_at, updated_at) VALUES ('b', 'ws', 'b', 'now', 'now')",
    )
    .run();

  const identityStore = new IdentityStore(database);
  const identity = new IdentityService(identityStore, INSTANCE);
  const hostId = identityStore.hostId();
  const ticket = identity.issueBootstrap({
    hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
    deviceName: "本机桌面",
    scopes: allScopes(),
  });
  const credentials = identity.consumeBootstrap({
    ticket: ticket.ticket,
    hostId,
    instanceId: INSTANCE,
    origin: ORIGIN,
  });

  const store = new ScheduleStore(database);
  const authority: { service?: ScheduleService } = {};
  const engine = new ScheduleEngine({
    store,
    dispatcher: new FakeDispatcher(),
    authorizer: {
      verify: async (authorization, config) => {
        await authority.service?.verify(authorization, config);
      },
    },
    hostId,
    instanceId: "instance-1",
  });
  const schedules = new ScheduleService({
    store,
    engine,
    identity: identityStore,
    hostId,
  });
  authority.service = schedules;
  const api = new AutomationApi({ service: schedules, identity });

  const workflows = new WorkflowService({
    database,
    engine: {} as never,
    collab: () => undefined,
  });
  setWorkflowDomain({
    service: workflows,
    engine: {} as never,
    stop: async () => {},
  } as WorkflowDomain);
  setWorkflowScheduleBridge(
    workflowScheduleBridge({
      store,
      service: schedules,
      caller: (request, workspaceId, mutation) =>
        api.caller(request, workspaceId, mutation),
      failure: apiFailure,
    }),
  );
  const routes = workflowRoutes(workflows);

  function request(
    method: string,
    path: string,
    payload?: unknown,
    anonymous = false,
  ): CoreRequest {
    const [pathname, search = ""] = path.split("?");
    const text = payload === undefined ? "" : JSON.stringify(payload);
    return {
      method,
      path: pathname as string,
      query: new URLSearchParams(search),
      headers: {
        ...(anonymous ? {} : { origin: ORIGIN }),
        "content-type": "application/json",
        ...(anonymous
          ? {}
          : {
              authorization: `Bearer ${credentials.accessToken}`,
              "x-armadra-csrf": credentials.csrfToken,
            }),
      },
      body: Buffer.from(text, "utf8"),
      raw: { socket: {} } as never,
      json: <T>() => (text === "" ? {} : JSON.parse(text)) as T,
    };
  }

  async function workflow(
    method: string,
    path: string,
    payload?: unknown,
    anonymous = false,
  ) {
    const answer = await answerWorkflowRequest(
      routes,
      request(method, path, payload, anonymous),
    );
    return {
      status: answer.status,
      body: (answer.body ?? {}) as Record<string, unknown>,
    };
  }

  async function automation(method: string, path: string, payload?: unknown) {
    const chunks: Buffer[] = [];
    let status = 200;
    const response = {
      writeHead(code: number) {
        status = code;
        return response;
      },
      end(chunk?: Buffer) {
        if (chunk) chunks.push(chunk);
      },
      setHeader() {},
    };
    await api.handle(request(method, path, payload), response as never, {});
    const wire = Buffer.concat(chunks);
    return {
      status,
      body: (wire.byteLength === 0
        ? {}
        : JSON.parse(wire.toString("utf8"))) as Record<string, unknown>,
    };
  }

  return { hostId, store, workflow, automation };
}

type Fixture = ReturnType<typeof setUp>;

async function createTemplate(fixture: Fixture): Promise<string> {
  const created = await fixture.workflow("POST", "/api/workflows/templates", {
    name: "定时审查",
    template: body([{ name: "scope", type: "string" }], 1),
  });
  expect(created.status).toBe(201);
  return (created.body.template as { id: string }).id;
}

async function definePlan(
  fixture: Fixture,
  planId: string,
  templateId: string,
  activate: boolean,
) {
  const defined = await fixture.automation(
    "POST",
    "/api/automations/plans?workspaceId=ws",
    {
      planId,
      config: {
        workspaceId: "ws",
        title: planId,
        schedule: { cron: { expression: "0 9 * * *", timezone: "UTC" } },
        target: {
          executionHostId: fixture.hostId,
          kind: "AUTOMATION_TARGET_KIND_WORKFLOW_RUN",
          workflowRun: { templateId, templateVersion: 0, boardId: "b" },
        },
        misfirePolicy: "AUTOMATION_MISFIRE_POLICY_SKIP",
        concurrencyPolicy: "AUTOMATION_CONCURRENCY_POLICY_FORBID",
        misfireGraceMs: "60000",
        busyTtlMs: "60000",
      },
      payload: JSON.stringify({ params: { scope: "src" } }),
      expectedRevision: 0,
    },
  );
  expect(defined.status).toBe(200);
  if (!activate) return;
  const snapshot = defined.body as {
    plan: { configVersion: string };
    revision: number;
    configSha256: string;
  };
  const activated = await fixture.automation(
    "POST",
    `/api/automations/plans/${planId}/activate?workspaceId=ws`,
    {
      expectedRevision: snapshot.revision,
      configVersion: Number(snapshot.plan.configVersion),
      configSha256: snapshot.configSha256,
    },
  );
  expect(activated.status).toBe(200);
}

async function plan(fixture: Fixture, planId: string) {
  const listed = await fixture.automation(
    "GET",
    "/api/automations/plans?workspaceId=ws",
  );
  const found = (
    listed.body.plans as {
      plan: {
        id: string;
        state: string;
        config: { target: { workflowRun: { templateVersion: number } } };
      };
    }[]
  ).find((item) => item.plan.id === planId);
  return found!.plan;
}

describe("模板升级", () => {
  it("改模板列出冻结的计划；相容的升到新版本，启用的仍启用", async () => {
    const fixture = setUp();
    const templateId = await createTemplate(fixture);
    await definePlan(fixture, "plan-a", templateId, true);
    await definePlan(fixture, "plan-b", templateId, false);

    const updated = await fixture.workflow(
      "PUT",
      `/api/workflows/templates/${templateId}`,
      {
        template: body(
          [
            { name: "scope", type: "string" },
            { name: "focus", type: "string", default: "all" },
          ],
          2,
        ),
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.frozenSchedules).toEqual([
      {
        scheduleId: "plan-a",
        workspaceId: "ws",
        templateVersion: 1,
        reason: "compatible",
        missingParams: [],
        unknownParams: [],
      },
      {
        scheduleId: "plan-b",
        workspaceId: "ws",
        templateVersion: 1,
        reason: "compatible",
        missingParams: [],
        unknownParams: [],
      },
    ]);

    const upgraded = await fixture.workflow(
      "POST",
      `/api/workflows/templates/${templateId}/upgrade-schedules?workspaceId=ws`,
      { scheduleIds: ["plan-a", "plan-b", "plan-missing"] },
    );
    expect(upgraded.status).toBe(200);
    expect(
      (upgraded.body.upgraded as { scheduleId: string }[]).map(
        (item) => item.scheduleId,
      ),
    ).toEqual(["plan-a", "plan-b"]);
    expect(upgraded.body.frozen).toEqual([
      {
        scheduleId: "plan-missing",
        reason: "not_found",
        missingParams: [],
        unknownParams: [],
      },
    ]);

    const a = await plan(fixture, "plan-a");
    expect(a.state).toBe("AUTOMATION_PLAN_STATE_ACTIVE");
    expect(a.config.target.workflowRun.templateVersion).toBe(2);
    const b = await plan(fixture, "plan-b");
    expect(b.state).toBe("AUTOMATION_PLAN_STATE_DRAFT");
    expect(b.config.target.workflowRun.templateVersion).toBe(2);
    // 升级之后探测回到 ready：到点按新版本跑。
    expect(
      workflowTargetStatus("ws", {
        workflowRun: { templateId, templateVersion: 2, boardId: "b" },
      } as never).state,
    ).toBe("ready");

    // 再改一次：已是最新版的计划不再出现在冻结列表外的地方，同时升级是幂等的。
    const again = await fixture.workflow(
      "POST",
      `/api/workflows/templates/${templateId}/upgrade-schedules?workspaceId=ws`,
      { scheduleIds: ["plan-a"] },
    );
    expect(again.body.frozen).toEqual([]);
  });

  it("不相容的不动，列出要补或不认的参数", async () => {
    const fixture = setUp();
    const templateId = await createTemplate(fixture);
    await definePlan(fixture, "plan-a", templateId, true);

    const missing = await fixture.workflow(
      "PUT",
      `/api/workflows/templates/${templateId}`,
      {
        template: body(
          [
            { name: "scope", type: "string" },
            { name: "owner", type: "string" },
          ],
          2,
        ),
      },
    );
    expect(missing.body.frozenSchedules).toMatchObject([
      {
        scheduleId: "plan-a",
        reason: "missing_params",
        missingParams: ["owner"],
      },
    ]);
    const refused = await fixture.workflow(
      "POST",
      `/api/workflows/templates/${templateId}/upgrade-schedules?workspaceId=ws`,
      { scheduleIds: ["plan-a"] },
    );
    expect(refused.body).toEqual({
      upgraded: [],
      frozen: [
        {
          scheduleId: "plan-a",
          reason: "missing_params",
          missingParams: ["owner"],
          unknownParams: [],
        },
      ],
    });
    const untouched = await plan(fixture, "plan-a");
    expect(untouched.state).toBe("AUTOMATION_PLAN_STATE_ACTIVE");
    expect(untouched.config.target.workflowRun.templateVersion).toBe(1);

    const renamed = await fixture.workflow(
      "PUT",
      `/api/workflows/templates/${templateId}`,
      {
        template: body(
          [{ name: "target", type: "string", default: "src" }],
          3,
          "审查 {{target}}",
        ),
      },
    );
    expect(renamed.body.frozenSchedules).toMatchObject([
      {
        scheduleId: "plan-a",
        reason: "param_mismatch",
        unknownParams: ["scope"],
      },
    ]);
  });

  it("请求体不对、认不出调用方时答 `{ code, message }`", async () => {
    const fixture = setUp();
    const templateId = await createTemplate(fixture);
    const empty = await fixture.workflow(
      "POST",
      `/api/workflows/templates/${templateId}/upgrade-schedules?workspaceId=ws`,
      { scheduleIds: [] },
    );
    expect(empty).toMatchObject({ status: 400, body: { code: "bad_request" } });
    const unknown = await fixture.workflow(
      "POST",
      "/api/workflows/templates/nope/upgrade-schedules?workspaceId=ws",
      { scheduleIds: ["plan-a"] },
    );
    expect(unknown).toMatchObject({ status: 404, body: { code: "not_found" } });
    const anonymous = await fixture.workflow(
      "POST",
      `/api/workflows/templates/${templateId}/upgrade-schedules?workspaceId=ws`,
      { scheduleIds: ["plan-a"] },
      true,
    );
    // 没报来源的调用认不出主体：与自动化面同一个分档。
    expect(anonymous).toMatchObject({
      status: 403,
      body: { code: "forbidden" },
    });
  });
});
