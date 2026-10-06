import { CoreFailure } from "../http/errors";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import {
  type DomainHandlers,
  type RpcCall,
  registerProcedures,
} from "../http/rpc";
import type { CoreServer } from "../http/server";
import { DomainError } from "../workspaces/support";
import { workflowScheduleBridge } from "./registry";
import { taskRowJson } from "./task-runs";
import {
  type WorkflowService,
  draftJson,
  runJson,
  templateJson,
} from "./service";

/**
 * `/api/workflows/*`（契约 §15.2–§15.3、§15.7）与 `workflows.*` / `coordinator.*`
 * procedure（契约 §43.2、§43.3）。
 *
 * 一份操作（{@link workflowOperations}），两个入口：路由表里的旧路径 handler 先把
 * 路径参数、查询串与体读出来，`registerProcedures` 登记的 procedure 拿到的是门面按
 * 契约解析过的入参；两条路调同一份，拒绝的码与原话一样。拒绝一律抛
 * `DomainError`（`CoreFailure`）。
 *
 * 这一面的路径在 `http/routes.ts` 的表里，权限按前缀在 `http/route-scopes.ts`
 * 声明——读是 `canvas:read`，写是 `agent:launch`，关卡答复单列一行
 * （{@link GATE_SCOPE}）。路由门在进这里之前已经判过：服务器壳上按草案 / 运行 /
 * 画板查出画布（`identity/route-access.ts`），列表必须带 `boardId`。
 */

export const API_PREFIX = "/api/workflows/";

/**
 * 关卡答复要的权限（契约 §23）：运行所在画布上的 operator。放行或拦下一次
 * 运行与起跑同一档，不是替 Agent 代答，所以不是 `approval:answer`。
 * `http/route-scopes.ts` 的那一行与它一致（用例逐字比对）。
 */
export const GATE_SCOPE = "agent:launch";

/** 旧路径查询串与 procedure 入参里的可选字符串：空串当没给。 */
function optional(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function workflowOperations(service: WorkflowService) {
  const runBody = (id: string) => {
    const run = service.run(id);
    return { run: runJson(run, service.steps(id)) };
  };
  return {
    /* --------------------------------- 草案 -------------------------------- */
    drafts: (filter: { boardId?: unknown; status?: unknown }) => ({
      drafts: service
        .drafts({
          boardId: optional(filter.boardId),
          status: optional(filter.status),
        })
        .map(draftJson),
    }),
    draft: (draftId: string) => ({ draft: draftJson(service.draft(draftId)) }),
    confirmDraft: (
      draftId: string,
      body: { name?: unknown; draft?: unknown },
    ) => {
      const confirmed = service.confirm(draftId, {
        name: body.name,
        draft: body.draft,
      });
      return {
        draft: draftJson(confirmed.draft),
        template: templateJson(confirmed.template),
      };
    },
    discardDraft: (draftId: string) => ({
      draft: draftJson(service.discard(draftId)),
    }),

    /* --------------------------------- 模板 -------------------------------- */
    templates: () => ({ templates: service.templates().map(templateJson) }),
    createTemplate: (body: { name?: unknown; template?: unknown }) => ({
      template: templateJson(
        service.createTemplate({ name: body.name, template: body.template }),
      ),
    }),
    template: (templateId: string) => ({
      template: templateJson(service.template(templateId)),
    }),
    updateTemplate: (
      templateId: string,
      body: { name?: unknown; template?: unknown },
    ) => {
      const template = templateJson(
        service.updateTemplate(templateId, {
          name: body.name,
          template: body.template,
        }),
      );
      // 冻结在旧版本上的计划（契约 §15.6）：页面据此提示「更新到最新版本」。
      const frozenSchedules = (
        workflowScheduleBridge()?.frozen(templateId) ?? []
      ).map((item) => ({
        scheduleId: item.scheduleId,
        workspaceId: item.workspaceId,
        templateVersion: item.templateVersion,
        reason: item.reason,
        missingParams: item.missingParams,
        unknownParams: item.unknownParams,
      }));
      return { template, frozenSchedules };
    },
    upgradeSchedules: async (
      request: CoreRequest,
      templateId: string,
      workspaceId: string,
      ids: unknown,
    ) => {
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 200 ||
        !ids.every((item) => typeof item === "string" && item !== "")
      ) {
        throw new DomainError(
          400,
          "bad_request",
          "scheduleIds 必须是 1–200 个计划标识。",
        );
      }
      const bridge = workflowScheduleBridge();
      if (bridge === undefined) {
        throw new DomainError(409, "unsupported", "这台 core 没有自动化域。");
      }
      // 模板先得在：不在就 404，与其余模板路由一致。
      service.template(templateId);
      return bridge.upgrade(request, workspaceId, templateId, ids as string[]);
    },
    deleteTemplate: (templateId: string) => {
      service.deleteTemplate(templateId);
    },

    /* --------------------------------- 运行 -------------------------------- */
    runs: (filter: {
      templateId?: unknown;
      boardId?: unknown;
      limit?: unknown;
    }) => {
      const limit = optional(
        typeof filter.limit === "number" ? String(filter.limit) : filter.limit,
      );
      return {
        runs: service
          .runs({
            templateId: optional(filter.templateId),
            boardId: optional(filter.boardId),
            limit: limit === undefined ? undefined : Number(limit) || 50,
          })
          .map((run) => runJson(run, service.steps(run.id))),
      };
    },
    startRun: async (body: {
      templateId?: unknown;
      params?: unknown;
      boardId?: unknown;
    }) => {
      const run = await service.startRun({
        templateId: body.templateId,
        params: body.params,
        boardId: body.boardId,
      });
      return runBody(run.id);
    },
    run: (runId: string) => runBody(runId),
    cancelRun: async (runId: string) => {
      await service.cancel(runId);
      return runBody(runId);
    },
    answerGate: async (
      runId: string,
      stepId: string,
      body: { decision?: unknown; note?: unknown },
    ) => {
      await service.answerGate(runId, stepId, {
        decision: body.decision,
        note: body.note,
      });
      return runBody(runId);
    },

    /* ------------------------------ 协调者任务 ------------------------------ */
    tasks: (boardId: unknown) => ({
      tasks: service.tasks(optional(boardId)).map(taskRowJson),
    }),
    retryTask: (taskId: string) => ({
      task: taskRowJson(service.retryTask(taskId)),
    }),
  };
}

/** 旧路径的体：缺体当空对象（确认草案可以不带体），其余必须是 JSON 对象。 */
function jsonBody(
  request: CoreRequest,
  allowEmpty = false,
): Record<string, unknown> {
  if (allowEmpty && request.body.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = request.json<unknown>();
  } catch {
    throw new DomainError(400, "bad_request", "请求体不是合法的 JSON。");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError(400, "bad_request", "请求体必须是一个 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function query(request: CoreRequest, name: string): string | undefined {
  return optional(request.query.get(name) ?? undefined);
}

/** 装配：路由表里的旧路径与契约 procedure 调同一份操作。 */
export function installWorkflowRoutes(
  server: CoreServer,
  service: WorkflowService,
): void {
  const ops = workflowOperations(service);

  const route = (
    method: string,
    path: string,
    handler: (
      match: RouteMatch,
      request: CoreRequest,
    ) => HandlerResult | Promise<HandlerResult>,
  ): void => {
    server.router.handle(method, path, async (match, request) => {
      try {
        return await handler(match, request);
      } catch (error) {
        if (error instanceof CoreFailure) {
          const { status, body } = error.response();
          return { status, body };
        }
        throw error;
      }
    });
  };
  const ok = (body: unknown, status = 200): HandlerResult => ({
    status,
    body,
  });
  const param = (match: RouteMatch, name: string) =>
    match.params[name] as string;

  registerProcedures(server, "workflows", {
    drafts: (input: { boardId?: string; status?: string }) => ops.drafts(input),
    draft: ({ draftId }: { draftId: string }) => ops.draft(draftId),
    confirmDraft: ({
      draftId,
      ...body
    }: {
      draftId: string;
      name?: string;
      draft?: unknown;
    }) => ops.confirmDraft(draftId, body),
    discardDraft: ({ draftId }: { draftId: string }) =>
      ops.discardDraft(draftId),
    templates: () => ops.templates(),
    createTemplate: (input: { name?: string; template?: unknown }) =>
      ops.createTemplate(input),
    template: ({ templateId }: { templateId: string }) =>
      ops.template(templateId),
    updateTemplate: ({
      templateId,
      ...body
    }: {
      templateId: string;
      name?: string;
      template?: unknown;
    }) => ops.updateTemplate(templateId, body),
    upgradeSchedules: (
      {
        templateId,
        workspaceId,
        scheduleIds,
      }: {
        templateId: string;
        workspaceId?: string;
        scheduleIds?: string[];
      },
      call: RpcCall,
    ) =>
      ops.upgradeSchedules(
        call.request,
        templateId,
        // 旧路径把工作空间放在查询串里，门面只把体交给入参。
        workspaceId ?? call.request.query.get("workspaceId") ?? "",
        scheduleIds,
      ),
    deleteTemplate: ({ templateId }: { templateId: string }) =>
      ops.deleteTemplate(templateId),
    runs: (input: { templateId?: string; boardId?: string; limit?: unknown }) =>
      ops.runs(input),
    startRun: (input: {
      templateId?: string;
      params?: unknown;
      boardId?: string;
    }) => ops.startRun(input),
    run: ({ runId }: { runId: string }) => ops.run(runId),
    cancelRun: ({ runId }: { runId: string }) => ops.cancelRun(runId),
    answerGate: ({
      runId,
      stepId,
      ...body
    }: {
      runId: string;
      stepId: string;
      decision?: string;
      note?: string;
    }) => ops.answerGate(runId, stepId, body),
  } as unknown as DomainHandlers<"workflows">);
  registerProcedures(server, "coordinator", {
    tasks: ({ boardId }: { boardId?: string }) => ops.tasks(boardId),
    retry: ({ taskId }: { taskId: string }) => ops.retryTask(taskId),
  } as unknown as DomainHandlers<"coordinator">);

  const BASE = "/api/workflows";
  route("GET", `${BASE}/drafts`, (_match, request) =>
    ok(
      ops.drafts({
        boardId: query(request, "boardId"),
        status: query(request, "status"),
      }),
    ),
  );
  route("GET", `${BASE}/drafts/{draftId}`, (match) =>
    ok(ops.draft(param(match, "draftId"))),
  );
  route("POST", `${BASE}/drafts/{draftId}/confirm`, (match, request) =>
    ok(ops.confirmDraft(param(match, "draftId"), jsonBody(request, true))),
  );
  route("POST", `${BASE}/drafts/{draftId}/discard`, (match) =>
    ok(ops.discardDraft(param(match, "draftId"))),
  );

  route("GET", `${BASE}/templates`, () => ok(ops.templates()));
  route("POST", `${BASE}/templates`, (_match, request) =>
    ok(ops.createTemplate(jsonBody(request)), 201),
  );
  route("GET", `${BASE}/templates/{templateId}`, (match) =>
    ok(ops.template(param(match, "templateId"))),
  );
  route("PUT", `${BASE}/templates/{templateId}`, (match, request) =>
    ok(ops.updateTemplate(param(match, "templateId"), jsonBody(request))),
  );
  route(
    "POST",
    `${BASE}/templates/{templateId}/upgrade-schedules`,
    async (match, request) =>
      ok(
        await ops.upgradeSchedules(
          request,
          param(match, "templateId"),
          request.query.get("workspaceId") ?? "",
          jsonBody(request).scheduleIds,
        ),
      ),
  );
  route("DELETE", `${BASE}/templates/{templateId}`, (match) => {
    ops.deleteTemplate(param(match, "templateId"));
    return { status: 204 };
  });

  route("GET", `${BASE}/runs`, (_match, request) =>
    ok(
      ops.runs({
        templateId: query(request, "templateId"),
        boardId: query(request, "boardId"),
        limit: query(request, "limit"),
      }),
    ),
  );
  route("POST", `${BASE}/runs`, async (_match, request) =>
    ok(await ops.startRun(jsonBody(request)), 201),
  );
  route("GET", `${BASE}/runs/{runId}`, (match) =>
    ok(ops.run(param(match, "runId"))),
  );
  route("POST", `${BASE}/runs/{runId}/cancel`, async (match) =>
    ok(await ops.cancelRun(param(match, "runId"))),
  );
  route("POST", `${BASE}/runs/{runId}/gates/{stepId}`, async (match, request) =>
    ok(
      await ops.answerGate(
        param(match, "runId"),
        param(match, "stepId"),
        jsonBody(request),
      ),
    ),
  );

  route("GET", `${BASE}/tasks`, (_match, request) =>
    ok(ops.tasks(query(request, "boardId"))),
  );
  route("POST", `${BASE}/tasks/{taskId}/retry`, (match) =>
    ok(ops.retryTask(param(match, "taskId"))),
  );
}
