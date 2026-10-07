import {
  CoreFailure,
  coreError,
  fail,
  failureResult,
  rateLimited,
} from "../http/errors";
import type { HandlerResult } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreServer } from "../http/server";
import { requestIdentity } from "../identity/gate";
import type { ClientReports } from "./client-report";

/**
 * `/api/diagnostics/client-error`（契约 §30）。
 *
 * 路由门不判（`http/route-scopes.ts` 的 `SELF_GUARDED`）：登录即可，这里自己认
 * 会话。桌面壳的本机请求没有请求身份，算本机 owner；服务器壳的匿名主体（没有
 * principal）答 401。
 *
 *   * `GET`：`{ enabled }`——页面据此决定收不收，关着时连监听都是空转。
 *   * `POST`：一条 `{ kind, name, message, stack }`；关着答 `{ accepted: false }`，
 *     不看请求体。
 *
 * 两个动作收成一份操作（{@link operations}），旧路径的 handler 与
 * `registerProcedures(server, "diagnostics", …)`（契约 §43.8）调同一份，拒绝都是
 * {@link CoreFailure}：码、状态与原话一样；限流的重试秒数在 `details`，HTTP 上
 * 同时给 `Retry-After` 头。上报的内容只经 {@link ClientReports} 剥离后才留下，
 * 原始请求体不进日志与答案。
 */

export const CLIENT_ERROR_ROUTE = "/api/diagnostics/client-error";

/** 限流按谁算：设备优先，其次 principal；本机 owner 是固定的一只桶。 */
function caller(): string {
  const identity = requestIdentity();
  if (identity === undefined) return "local";
  const subject = identity.subject;
  if (subject.kind !== "owner" && subject.principalId === "") {
    throw fail("unauthenticated", "需要一个已登录的会话");
  }
  const device = identity.device?.deviceId;
  return device !== undefined
    ? `device:${device}`
    : `principal:${subject.principalId}`;
}

/** 页面错误上报的操作：旧路径与 procedure 共用；拒绝抛 {@link CoreFailure}。 */
function operations(reports: ClientReports) {
  return {
    status: () => {
      caller();
      return { enabled: reports.enabled() };
    },
    /** `accepted` 是否真收下了；关着时答 `false`，不看 `body`。 */
    report: (body: () => unknown): { accepted: boolean } => {
      const key = caller();
      if (!reports.enabled()) return { accepted: false };
      const outcome = reports.accept(key, body());
      switch (outcome.kind) {
        case "accepted":
          return { accepted: true };
        case "disabled":
          return { accepted: false };
        case "invalid":
          throw fail("bad_request", outcome.message);
        case "limited":
          throw rateLimited("页面错误报得太频繁", outcome.retryAfterMs);
      }
    },
  };
}

function failed(error: unknown): HandlerResult {
  if (error instanceof CoreFailure) return failureResult(error);
  if (error instanceof SyntaxError) {
    return coreError(400, "bad_request", "请求体不是合法的 JSON");
  }
  throw error;
}

export function installRoutes(
  server: CoreServer,
  reports: ClientReports,
): void {
  const { router } = server;
  const run = operations(reports);

  router.handle("GET", CLIENT_ERROR_ROUTE, () => {
    try {
      return { status: 200, body: run.status() };
    } catch (error) {
      return failed(error);
    }
  });

  router.handle("POST", CLIENT_ERROR_ROUTE, (_match, request) => {
    try {
      const answer = run.report(() => request.json());
      return { status: answer.accepted ? 202 : 200, body: answer };
    } catch (error) {
      return failed(error);
    }
  });

  // procedure（契约 §43.8）：入参已由门面按契约解析，拒绝抛 `CoreFailure`。
  registerProcedures(server, "diagnostics", {
    clientErrorStatus: () => run.status(),
    reportClientError: (input) => run.report(() => input),
  } satisfies DomainHandlers<"diagnostics">);
}
