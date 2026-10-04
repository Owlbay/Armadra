import { type ErrorResponse, badRequest, coreError } from "../http/errors";
import type { CoreRequest, HandlerResult } from "../http/router";
import type { JsonObject } from "../settings/local";
import {
  GATEWAY_LISTEN_CHOICES,
  GATEWAY_TLS_SOURCES,
} from "../settings/completion-settings";
import { canonicalOrigin } from "../identity/origin";
import { remoteAddress } from "../identity/http";

/**
 * `/api/gateway*` 的三条（契约 §17）。owner 才进得来——路由门按
 * `route-scopes.ts` 的 `settings:*` 判，成员只有工作空间授权，一律 403。
 *
 *   * `GET /api/gateway`：状态。
 *   * `PUT /api/gateway`：改配置（`gateway.*` 的子集，未给的键不动），然后
 *     按新配置开、关或重开；关掉即刻停止监听并断开经它进来的流。
 *   * `POST /api/gateway/pairing`：铸一张配对票，回网页链接与原生深链；私网
 *     档位上连同一枚 8 位短码。
 *   * `POST /api/gateway/pairing-code/exchange`：短码换票（契约 §24）。匿名——
 *     手机还没有身份，短码就是凭据；档位与限流在 Gateway 域里判。
 */

export interface PairingCodeExchange {
  readonly code: string;
  readonly remoteIp: string;
  /** 请求的来源（经 Gateway 时是页面来源，原生 App 是会话来源）。 */
  readonly origin: string | undefined;
}

export interface GatewayRouteDeps {
  status(): Record<string, unknown>;
  /** 写进设置并对账；壳托管（服务器壳）时答 409。 */
  configure(patch: JsonObject): Promise<ErrorResponse | undefined>;
  pair(input: {
    origin?: string;
    deviceName?: string;
  }): Record<string, unknown> | ErrorResponse;
  exchangeCode(input: PairingCodeExchange): HandlerResult;
}

export function getGateway(deps: GatewayRouteDeps): HandlerResult {
  return { status: 200, body: deps.status() };
}

export async function putGateway(
  deps: GatewayRouteDeps,
  request: CoreRequest,
): Promise<HandlerResult> {
  const parsed = parseConfig(request);
  if ("status" in parsed) return parsed;
  const refused = await deps.configure(parsed.patch);
  if (refused !== undefined) return refused;
  return { status: 200, body: deps.status() };
}

export function postPairing(
  deps: GatewayRouteDeps,
  request: CoreRequest,
): HandlerResult {
  let body: unknown;
  try {
    body = request.body.length === 0 ? {} : request.json();
  } catch {
    return badRequest("请求体不是 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("请求体必须是对象");
  }
  const input = body as Record<string, unknown>;
  const out: { origin?: string; deviceName?: string } = {};
  if (input.origin !== undefined) {
    if (typeof input.origin !== "string")
      return badRequest("origin 必须是字符串");
    out.origin = input.origin;
  }
  if (input.deviceName !== undefined) {
    if (
      typeof input.deviceName !== "string" ||
      input.deviceName.trim() === "" ||
      input.deviceName.length > 64
    ) {
      return badRequest("deviceName 必须是 1–64 个字符");
    }
    out.deviceName = input.deviceName.trim();
  }
  const answer = deps.pair(out);
  if ("status" in answer && "body" in answer) return answer as ErrorResponse;
  return { status: 200, body: answer };
}

export function postPairingCodeExchange(
  deps: GatewayRouteDeps,
  request: CoreRequest,
): HandlerResult {
  let body: unknown;
  try {
    body = request.json();
  } catch {
    return badRequest("请求体不是 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("请求体必须是对象");
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "code") return badRequest(`不认识的键：${key}`);
  }
  if (typeof input.code !== "string" || input.code.length > 32) {
    return badRequest("code 必须是字符串");
  }
  const origin = request.headers.origin;
  return deps.exchangeCode({
    code: input.code,
    remoteIp: remoteAddress(request),
    origin: typeof origin === "string" ? canonicalOrigin(origin) : undefined,
  });
}

const MAX_PATH = 4096;

/**
 * 只认识 `gateway.*` 的那几个键，值错了答 400 而不是让规范化悄悄退回缺省——
 * 设置页的下拉框和存下来的值不该不一致却没人被告知。
 */
export function parseConfig(
  request: CoreRequest,
): { patch: JsonObject } | ErrorResponse {
  let body: unknown;
  try {
    body = request.json();
  } catch {
    return badRequest("请求体不是 JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("请求体必须是对象");
  }
  const input = body as Record<string, unknown>;
  const patch: JsonObject = {};
  for (const key of Object.keys(input)) {
    if (!["enabled", "listen", "port", "publicOrigin", "tls"].includes(key)) {
      return badRequest(`不认识的键：${key}`);
    }
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      return badRequest("enabled 必须是布尔值");
    patch.enabled = input.enabled;
  }
  if (input.listen !== undefined) {
    if (
      !(GATEWAY_LISTEN_CHOICES as readonly unknown[]).includes(input.listen)
    ) {
      return badRequest(`listen 只能是 ${GATEWAY_LISTEN_CHOICES.join(" / ")}`);
    }
    patch.listen = input.listen as string;
  }
  if (input.port !== undefined) {
    if (
      typeof input.port !== "number" ||
      !Number.isInteger(input.port) ||
      input.port < 0 ||
      input.port > 65_535
    ) {
      return badRequest("port 必须是 0–65535 的整数");
    }
    patch.port = input.port;
  }
  if (input.publicOrigin !== undefined) {
    const value = input.publicOrigin;
    if (typeof value !== "string")
      return badRequest("publicOrigin 必须是字符串");
    if (value !== "" && !httpsOrigin(value)) {
      return badRequest(
        "publicOrigin 必须是一个 https 来源，例如 https://armadra.example",
      );
    }
    patch.publicOrigin = value;
  }
  if (input.tls !== undefined) {
    if (
      typeof input.tls !== "object" ||
      input.tls === null ||
      Array.isArray(input.tls)
    ) {
      return badRequest("tls 必须是对象");
    }
    const tls = input.tls as Record<string, unknown>;
    const out: JsonObject = {};
    for (const key of Object.keys(tls)) {
      if (!["source", "certFile", "keyFile", "acmeEmail"].includes(key)) {
        return badRequest(`不认识的键：tls.${key}`);
      }
    }
    if (tls.source !== undefined) {
      if (!(GATEWAY_TLS_SOURCES as readonly unknown[]).includes(tls.source)) {
        return badRequest(
          `tls.source 只能是 ${GATEWAY_TLS_SOURCES.join(" / ")}`,
        );
      }
      out.source = tls.source as string;
    }
    for (const key of ["certFile", "keyFile", "acmeEmail"] as const) {
      const value = tls[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > MAX_PATH) {
        return badRequest(`tls.${key} 必须是字符串`);
      }
      out[key] = value;
    }
    patch.tls = out;
  }
  return { patch };
}

function httpsOrigin(value: string): boolean {
  return canonicalOrigin(value) === value && value.startsWith("https://");
}

export const GATEWAY_MANAGED = coreError(
  409,
  "gateway_managed_by_shell",
  "这个 Gateway 由服务器壳的命令行参数配置，设置里改不了",
);

export const GATEWAY_NOT_RUNNING = coreError(
  409,
  "gateway_not_running",
  "对外服务没有在运行",
);
