import { coreError } from "../http/errors";
import type { HandlerResult } from "../http/router";
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
 */

export const CLIENT_ERROR_ROUTE = "/api/diagnostics/client-error";

/** 限流按谁算：设备优先，其次 principal；本机 owner 是固定的一只桶。 */
function caller():
  | { readonly key: string }
  | { readonly refusal: HandlerResult } {
  const identity = requestIdentity();
  if (identity === undefined) return { key: "local" };
  const subject = identity.subject;
  if (subject.kind !== "owner" && subject.principalId === "") {
    return {
      refusal: coreError(401, "unauthenticated", "需要一个已登录的会话"),
    };
  }
  const device = identity.device?.deviceId;
  return {
    key:
      device !== undefined
        ? `device:${device}`
        : `principal:${subject.principalId}`,
  };
}

export function installRoutes(
  server: CoreServer,
  reports: ClientReports,
): void {
  const { router } = server;

  router.handle("GET", CLIENT_ERROR_ROUTE, () => {
    const who = caller();
    if ("refusal" in who) return who.refusal;
    return { status: 200, body: { enabled: reports.enabled() } };
  });

  router.handle("POST", CLIENT_ERROR_ROUTE, (_match, request) => {
    const who = caller();
    if ("refusal" in who) return who.refusal;
    if (!reports.enabled()) {
      return { status: 200, body: { accepted: false } };
    }
    let body: unknown;
    try {
      body = request.json();
    } catch {
      return coreError(400, "bad_request", "请求体不是合法的 JSON");
    }
    const outcome = reports.accept(who.key, body);
    switch (outcome.kind) {
      case "accepted":
        return { status: 202, body: { accepted: true } };
      case "disabled":
        return { status: 200, body: { accepted: false } };
      case "invalid":
        return coreError(400, "bad_request", outcome.message);
      case "limited": {
        const refused = coreError(429, "rate_limited", "页面错误报得太频繁");
        return {
          ...refused,
          headers: {
            "Retry-After": String(
              Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)),
            ),
          },
        };
      }
    }
  });
}
