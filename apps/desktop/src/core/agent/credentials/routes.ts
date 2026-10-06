import type { CredentialEntry, CredentialList } from "@armadra/shared";
import { CoreFailure } from "../../http/errors";
import type { CoreRequest, HandlerResult } from "../../http/router";
import {
  type DomainHandlers,
  INTERNAL_MESSAGE,
  registerProcedures,
} from "../../http/rpc";
import type { CoreServer } from "../../http/server";
import { CredentialError, type CredentialsDomain } from "./index";
import { kindRow } from "./inject";
import type { CredentialRow } from "./store";
import { audit } from "../../identity/audit";

/**
 * `/api/credentials*`（契约 §20.2）。只有 owner（路由门按全局 `settings:*`）。
 *
 * 值只进不出：新建与改值收 `value`，任何答复都只有 `isSet`。请求体里的值不进
 * 日志——这里一行日志也不写。
 *
 * 四个动作收成一份操作（{@link operations}），旧路径的 handler 与
 * `registerProcedures(server, "credentials", …)`（契约 §43.6）调同一份，拒绝都是
 * {@link CoreFailure}（`CredentialError` 是它的子类）：码、状态与原话一样。操作里
 * 抛出的别的错误（密钥后端的失败）一律先换成不带原因的固定拒绝再往外走——异常
 * 消息里可能有路径，门面又会把异常的消息写进日志，所以这里不让它出去。
 */
function operations(domain: CredentialsDomain) {
  return {
    list: async (): Promise<CredentialList> => {
      const available = domain.availability();
      const rows = domain.store.list();
      const entries = await Promise.all(rows.map((row) => entry(domain, row)));
      return {
        backend: domain.store.backendKind(),
        available: available.ok,
        ...(available.ok ? {} : { reason: available.error.code }),
        kinds: domain.kinds(),
        entries,
      };
    },
    create: async (body: Record<string, unknown>): Promise<CredentialEntry> => {
      const available = domain.availability();
      if (!available.ok) throw available.error;
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
      // 审计只记条目名与种类，值一个字节都不进（契约 §20）。
      audit({
        action: "credential.create",
        target: created.ref,
        detail: { providerId, kind },
      });
      return entry(domain, created);
    },
    update: async (
      ref: string,
      body: Record<string, unknown>,
    ): Promise<CredentialEntry> => {
      const label =
        body.label === undefined ? undefined : text(body.label, 200);
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
      const updated = await domain.store.update(ref, {
        ...(label === undefined ? {} : { label }),
        ...(value === undefined ? {} : { value }),
      });
      if (updated === undefined) throw notFound();
      audit({
        action: "credential.update",
        target: updated.ref,
        detail: { label: label !== undefined, value: value !== undefined },
      });
      return entry(domain, updated);
    },
    remove: async (ref: string): Promise<void> => {
      if (!(await domain.store.remove(ref))) throw notFound();
      audit({ action: "credential.delete", target: ref });
    },
  };
}

/** 操作里抛出的任何东西 → 拒绝；不是拒绝的只留代码，不带原因。 */
function refusal(failure: unknown): CoreFailure {
  if (failure instanceof CoreFailure) return failure;
  const unavailable =
    typeof failure === "object" &&
    failure !== null &&
    (failure as { code?: unknown }).code === "secret_unavailable";
  return unavailable
    ? new CoreFailure(
        503,
        "credential_unavailable",
        "The secret store is unavailable",
      )
    : new CoreFailure(500, "internal", INTERNAL_MESSAGE);
}

export function installRoutes(
  server: CoreServer,
  domain: CredentialsDomain,
): void {
  const run = operations(domain);
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

  handle("GET", "/api/credentials", async () => ({
    status: 200,
    body: await run.list(),
  }));
  handle("POST", "/api/credentials", async (_params, request) => ({
    status: 201,
    body: await run.create(object(request)),
  }));
  handle("PATCH", "/api/credentials/{ref}", async (params, request) => ({
    status: 200,
    body: await run.update(params.ref ?? "", object(request)),
  }));
  handle("DELETE", "/api/credentials/{ref}", async (params) => {
    await run.remove(params.ref ?? "");
    return { status: 204 };
  });

  // procedure（契约 §43.6）：入参已由门面按契约解析，拒绝抛 `CoreFailure`。
  const guard =
    <A extends unknown[], R>(work: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await work(...args);
      } catch (failure) {
        throw refusal(failure);
      }
    };
  registerProcedures(server, "credentials", {
    list: guard(() => run.list()),
    create: guard((input) => run.create(input)),
    update: guard(({ ref, ...rest }) => run.update(ref, rest)),
    remove: guard(({ ref }) => run.remove(ref)),
  } satisfies DomainHandlers<"credentials">);
}

async function entry(
  domain: CredentialsDomain,
  row: CredentialRow,
): Promise<CredentialEntry> {
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
  const refused = refusal(failure);
  return {
    status: refused.status,
    body: { code: refused.code, message: refused.message },
  };
}
