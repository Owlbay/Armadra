import type { ServerResponse } from "node:http";
import type { CoreRequest } from "../http/router";
import { DomainError } from "../workspaces/support";
import {
  type WorkflowService,
  draftJson,
  runJson,
  templateJson,
} from "./service";

/**
 * `/api/workflows/*`（契约 §15.2–§15.3）。
 *
 * 整段挂在 `server.raw` 上（与自动化、OAuth 同一种装法）：这一面的路径不进
 * `http/routes.ts` 那张表，权限按前缀在 `http/route-scopes.ts` 声明——读是
 * `canvas:read`，写是 `agent:launch`。路由门在进这里之前已经判过。
 *
 * 所有失败都是 `{ code, message }`，`code` 是 snake_case。
 */

export const API_PREFIX = "/api/workflows/";

interface Answer {
  readonly status: number;
  readonly body?: unknown;
}

type Groups = Readonly<Record<string, string>>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: (
    request: CoreRequest,
    groups: Groups,
  ) => Answer | Promise<Answer>;
}

const ID = "(?<id>[^/]+)";

export function workflowRoutes(service: WorkflowService): readonly Route[] {
  const runBody = (id: string) => {
    const run = service.run(id);
    return { run: runJson(run, service.steps(id)) };
  };
  return [
    /* --------------------------------- 草案 -------------------------------- */
    {
      method: "GET",
      pattern: /^\/api\/workflows\/drafts$/,
      handle: (request) => ({
        status: 200,
        body: {
          drafts: service
            .drafts({
              boardId: query(request, "boardId"),
              status: query(request, "status"),
            })
            .map(draftJson),
        },
      }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/api/workflows/drafts/${ID}$`),
      handle: (_request, groups) => ({
        status: 200,
        body: { draft: draftJson(service.draft(groups.id as string)) },
      }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/api/workflows/drafts/${ID}/confirm$`),
      handle: (request, groups) => {
        const body = jsonObject(request, true);
        const confirmed = service.confirm(groups.id as string, {
          name: body.name,
          draft: body.draft,
        });
        return {
          status: 200,
          body: {
            draft: draftJson(confirmed.draft),
            template: templateJson(confirmed.template),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/api/workflows/drafts/${ID}/discard$`),
      handle: (_request, groups) => ({
        status: 200,
        body: { draft: draftJson(service.discard(groups.id as string)) },
      }),
    },

    /* --------------------------------- 模板 -------------------------------- */
    {
      method: "GET",
      pattern: /^\/api\/workflows\/templates$/,
      handle: () => ({
        status: 200,
        body: { templates: service.templates().map(templateJson) },
      }),
    },
    {
      method: "POST",
      pattern: /^\/api\/workflows\/templates$/,
      handle: (request) => {
        const body = jsonObject(request);
        return {
          status: 201,
          body: {
            template: templateJson(
              service.createTemplate({
                name: body.name,
                template: body.template,
              }),
            ),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/api/workflows/templates/${ID}$`),
      handle: (_request, groups) => ({
        status: 200,
        body: { template: templateJson(service.template(groups.id as string)) },
      }),
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/api/workflows/templates/${ID}$`),
      handle: (request, groups) => {
        const body = jsonObject(request);
        return {
          status: 200,
          body: {
            template: templateJson(
              service.updateTemplate(groups.id as string, {
                name: body.name,
                template: body.template,
              }),
            ),
          },
        };
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/api/workflows/templates/${ID}$`),
      handle: (_request, groups) => {
        service.deleteTemplate(groups.id as string);
        return { status: 204 };
      },
    },

    /* --------------------------------- 运行 -------------------------------- */
    {
      method: "GET",
      pattern: /^\/api\/workflows\/runs$/,
      handle: (request) => {
        const limit = query(request, "limit");
        return {
          status: 200,
          body: {
            runs: service
              .runs({
                templateId: query(request, "templateId"),
                boardId: query(request, "boardId"),
                limit: limit === undefined ? undefined : Number(limit) || 50,
              })
              .map((run) => runJson(run, service.steps(run.id))),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/workflows\/runs$/,
      handle: async (request) => {
        const body = jsonObject(request);
        const run = await service.startRun({
          templateId: body.templateId,
          params: body.params,
          boardId: body.boardId,
        });
        return { status: 201, body: runBody(run.id) };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/api/workflows/runs/${ID}$`),
      handle: (_request, groups) => ({
        status: 200,
        body: runBody(groups.id as string),
      }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/api/workflows/runs/${ID}/cancel$`),
      handle: async (_request, groups) => {
        await service.cancel(groups.id as string);
        return { status: 200, body: runBody(groups.id as string) };
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/api/workflows/runs/${ID}/gates/(?<stepId>[^/]+)$`),
      handle: async (request, groups) => {
        const body = jsonObject(request);
        await service.answerGate(groups.id as string, groups.stepId as string, {
          decision: body.decision,
          note: body.note,
        });
        return { status: 200, body: runBody(groups.id as string) };
      },
    },
  ];
}

/** 一次请求 → `{ status, body }`。用例直接调它，不经 socket。 */
export async function answerWorkflowRequest(
  routes: readonly Route[],
  request: CoreRequest,
): Promise<Answer> {
  const candidates = routes.filter((route) => route.pattern.test(request.path));
  if (candidates.length === 0) {
    return {
      status: 404,
      body: { code: "not_found", message: "没有这个工作流路由" },
    };
  }
  const found = candidates.find((route) => route.method === request.method);
  if (found === undefined) {
    return {
      status: 405,
      body: { code: "method_not_allowed", message: "这个路由不收这个方法" },
    };
  }
  const groups = (found.pattern.exec(request.path)?.groups ?? {}) as Groups;
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(groups)) {
    decoded[key] = decodeURIComponent(value);
  }
  try {
    return await found.handle(request, decoded);
  } catch (error) {
    if (error instanceof DomainError) {
      return {
        status: error.status,
        body: { code: error.code, message: error.message },
      };
    }
    throw error;
  }
}

/** 挂在 `server.raw` 上的那个处理函数。 */
export function workflowRawHandler(service: WorkflowService) {
  const routes = workflowRoutes(service);
  return async (
    request: CoreRequest,
    response: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    let answer: Answer;
    try {
      answer = await answerWorkflowRequest(routes, request);
    } catch {
      answer = {
        status: 500,
        body: { code: "internal_error", message: "工作流请求处理失败" },
      };
    }
    if (answer.status === 204) {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const payload = Buffer.from(JSON.stringify(answer.body ?? null), "utf8");
    response.writeHead(answer.status, {
      ...cors,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  };
}

function query(request: CoreRequest, name: string): string | undefined {
  const value = request.query.get(name);
  return value === null || value === "" ? undefined : value;
}

function jsonObject(
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
