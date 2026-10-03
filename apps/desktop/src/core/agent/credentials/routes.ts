import type { CoreRequest, HandlerResult } from "../../http/router";
import type { CoreServer } from "../../http/server";
import { CredentialError, type CredentialsDomain } from "./index";
import { kindRow } from "./inject";
import type { CredentialRow } from "./store";

/**
 * `/api/credentials*`（契约 §20.2）。只有 owner（路由门按全局 `settings:*`）。
 *
 * 值只进不出：新建与改值收 `value`，任何答复都只有 `isSet`。请求体里的值不进
 * 日志——这里一行日志也不写。
 */
export function installRoutes(
  server: CoreServer,
  domain: CredentialsDomain,
): void {
  const handle = (
    method: string,
    path: string,
    handler: (
      params: Readonly<Record<string, string>>,
      request: CoreRequest,
    ) => Promise<HandlerResult> | HandlerResult,
  ) => {
    server.router.handle(method, path, async (match, request) => {
      try {
        return await handler(match.params, request);
      } catch (failure) {
        return answerError(failure);
      }
    });
  };

  handle("GET", "/api/credentials", async () => {
    const available = domain.availability();
    const rows = domain.store.list();
    const entries = await Promise.all(rows.map((row) => entry(domain, row)));
    return {
      status: 200,
      body: {
        backend: domain.store.backendKind(),
        available: available.ok,
        ...(available.ok ? {} : { reason: available.error.code }),
        kinds: domain.kinds(),
        entries,
      },
    };
  });

  handle("POST", "/api/credentials", async (_params, request) => {
    const available = domain.availability();
    if (!available.ok) throw available.error;
    const body = object(request);
    const providerId = text(body.providerId, 120);
    const kind = text(body.kind, 60);
    const label = text(body.label, 200);
    const value = secret(body.value);
    if (
      providerId === undefined ||
      kind === undefined ||
      label === undefined ||
      value === undefined
    ) {
      throw badRequest("providerId, kind, label and value are required");
    }
    const row = kindRow(providerId, kind);
    if (row === undefined) {
      throw badRequest(`Unknown credential kind ${providerId} / ${kind}`);
    }
    if (!row.enabled) {
      throw new CredentialError(
        400,
        "credential_kind_disabled",
        `Credential kind ${kind} is not enabled`,
      );
    }
    const created = await domain.store.create({
      providerId,
      kind,
      label,
      value,
    });
    return { status: 201, body: await entry(domain, created) };
  });

  handle("PATCH", "/api/credentials/{ref}", async (params, request) => {
    const body = object(request);
    const label = body.label === undefined ? undefined : text(body.label, 200);
    const value = body.value === undefined ? undefined : secret(body.value);
    if (
      (body.label !== undefined && label === undefined) ||
      (body.value !== undefined && value === undefined) ||
      (label === undefined && value === undefined)
    ) {
      throw badRequest("label or value is required");
    }
    if (value !== undefined) {
      const available = domain.availability();
      if (!available.ok) throw available.error;
    }
    const updated = await domain.store.update(params.ref ?? "", {
      ...(label === undefined ? {} : { label }),
      ...(value === undefined ? {} : { value }),
    });
    if (updated === undefined) throw notFound();
    return { status: 200, body: await entry(domain, updated) };
  });

  handle("DELETE", "/api/credentials/{ref}", async (params) => {
    if (!(await domain.store.remove(params.ref ?? ""))) throw notFound();
    return { status: 204 };
  });
}

async function entry(domain: CredentialsDomain, row: CredentialRow) {
  return {
    ref: row.ref,
    providerId: row.providerId,
    kind: row.kind,
    label: row.label,
    isSet: await domain.store.isSet(row.ref),
    ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt }),
  };
}

function object(request: CoreRequest): Record<string, unknown> {
  let body: unknown;
  try {
    body = request.json();
  } catch {
    throw badRequest("The request body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("The request body must be an object");
  }
  return body as Record<string, unknown>;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? undefined : trimmed;
}

/** 值原样存（令牌里不该有首尾空白，有也是粘贴带进来的，去掉）。单行。 */
function secret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 8_192 || /[\r\n\0]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function badRequest(message: string): CredentialError {
  return new CredentialError(400, "bad_request", message);
}

function notFound(): CredentialError {
  return new CredentialError(
    404,
    "credential_not_found",
    "No such node credential",
  );
}

function answerError(failure: unknown): HandlerResult {
  if (failure instanceof CredentialError) {
    return {
      status: failure.status,
      body: { code: failure.code, message: failure.message },
    };
  }
  // 后端的失败只报代码：异常消息里可能有路径，绝不会有值，但也不必多说。
  const code =
    typeof failure === "object" &&
    failure !== null &&
    (failure as { code?: unknown }).code === "secret_unavailable"
      ? "credential_unavailable"
      : "internal";
  return {
    status: code === "internal" ? 500 : 503,
    body: {
      code,
      message:
        code === "internal"
          ? "The credential request failed"
          : "The secret store is unavailable",
    },
  };
}
