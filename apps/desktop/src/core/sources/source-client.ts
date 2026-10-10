/**
 * 对另一台 core 的调用：配对、换票、hello、经中继的 `cloud/login`（契约 §3、
 * §17.3、§24、§31）。外呼登记 `net/outbound.ts` 的 `sourceGateway`。
 *
 * 本机 core 在这里扮演原生 App：`Origin: https://localhost`，对端 Gateway 把它
 * 当 Bearer 模式（§17.4）——密钥在响应体的 `native` 里，不发 Cookie、不要 CSRF。
 * 经中继时多带 `Armadra-Relay-Token`（cloud-api §7）。
 */

import { fail } from "../http/errors";
import type { Transport } from "./http-client";

/** 本机 core 对别的源自称的来源：原生 App 的那一个，走 Bearer 模式。 */
export const CLIENT_ORIGIN = "https://localhost";

export const RELAY_TOKEN_HEADER = "armadra-relay-token";

export interface SourceAddress {
  /** Gateway 来源，或中继的 `relayBaseUrl`（带 `/s/<sourceId>` 路径）。 */
  readonly base: string;
  /** 信任锚指纹；空 = 系统信任。 */
  readonly fingerprint: string;
  /** 经中继时的令牌。 */
  readonly relayToken?: string;
}

export interface NativeCredentials {
  readonly hostId: string;
  readonly deviceId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAtMs: number;
  /** 这把会话是谁：设备显示名或主体名，只作提示。 */
  readonly principalHint: string;
}

export interface PairTicket {
  readonly origin: string;
  readonly ticket: string;
  readonly fingerprint: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function credentialsOf(body: unknown, hint?: string): NativeCredentials {
  const answer = record(body);
  const session = "session" in answer ? record(answer.session) : answer;
  const native = record(session.native);
  const device = record(session.device);
  const accessToken = str(native.accessToken);
  const refreshToken = str(native.refreshToken);
  if (accessToken === "" || refreshToken === "") {
    throw fail("source_unauthorized", "对端没有发原生会话");
  }
  const expires = session.expiresAtUnixMs;
  return {
    hostId: str(session.hostId),
    deviceId: str(device.deviceId),
    accessToken,
    refreshToken,
    accessExpiresAtMs:
      typeof expires === "number" && Number.isFinite(expires) ? expires : 0,
    principalHint: (hint ?? str(device.displayName)).slice(0, 256),
  };
}

/** 对端的失败 → 契约 §33 的码。对端原话不透传。 */
function rejected(status: number, body: unknown): never {
  const code = str(record(body).code);
  switch (code) {
    case "cloud_account_unlinked":
      throw fail("cloud_account_unlinked", "这个账号还没有关联到这台机器");
    case "source_offline":
      throw fail("source_offline", "这台机器当前不在线");
    // 按链接加入时邀请被拒（已用完、已撤销、与链接不符），或这台机器已不认这个远程服务。
    case "invitation_invalid":
      throw fail("invitation_invalid", "邀请无效或已用完");
    case "cloud_not_registered":
      throw fail("cloud_not_registered", "这台机器没有登记到这个远程服务");
    case "rate_limited":
    case "RESOURCE_EXHAUSTED":
      throw fail("rate_limited", "对端限流，请稍后重试");
    case "pairing_code_invalid":
    case "pairing_code_disabled":
    case "origin_mismatch":
      throw fail("source_unauthorized", "配对码无效或已过期");
    default:
      break;
  }
  if (status === 401 || status === 403 || status === 404) {
    throw fail("source_unauthorized", "对端拒绝了这份凭据");
  }
  if (status === 503) throw fail("source_offline", "这台机器当前不在线");
  throw fail("source_unreachable", `对端没能完成请求（${status}）`);
}

export class SourceClient {
  constructor(private readonly transport: Transport) {}

  private async call(
    address: SourceAddress,
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    body?: unknown,
    bearer?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { origin: CLIENT_ORIGIN };
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
    if (address.relayToken !== undefined && address.relayToken !== "") {
      headers[RELAY_TOKEN_HEADER] = address.relayToken;
    }
    const answer = await this.transport({
      method,
      url: `${address.base}${path}`,
      fingerprint: address.fingerprint,
      timeoutMs,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    return rejected(answer.status, answer.body);
  }

  /** `GET /api/identity/hello`：对端是谁。 */
  async hello(
    address: SourceAddress,
    timeoutMs: number,
  ): Promise<{ hostId: string; hostName: string }> {
    const body = record(
      await this.call(address, "GET", "/api/identity/hello", timeoutMs),
    );
    const hostId = str(body.hostId);
    if (!/^[0-9a-f]{32}$/.test(hostId)) {
      throw fail("source_unreachable", "这个地址不是一台 Armadra core");
    }
    // 对端的「主机名称」（契约 §61）；旧 core 不报是空串。
    return { hostId, hostName: str(body.hostName).trim().slice(0, 128) };
  }

  /** 8 位配对码换票（§24.2）。 */
  async exchangeCode(
    address: SourceAddress,
    code: string,
  ): Promise<PairTicket> {
    const body = record(
      await this.call(
        address,
        "POST",
        "/api/gateway/pairing-code/exchange",
        10_000,
        { code },
      ),
    );
    return {
      origin: str(body.origin),
      ticket: str(body.ticket),
      fingerprint: str(body.fingerprint),
    };
  }

  /** `POST /api/identity/pair`：票换原生会话。 */
  async pair(
    address: SourceAddress,
    ticket: string,
  ): Promise<NativeCredentials> {
    return credentialsOf(
      await this.call(address, "POST", "/api/identity/pair", 10_000, {
        ticket,
      }),
    );
  }

  /** `POST /api/identity/session/refresh`：旋转刷新令牌。 */
  async refresh(
    address: SourceAddress,
    refreshToken: string,
  ): Promise<NativeCredentials> {
    return credentialsOf(
      await this.call(
        address,
        "POST",
        "/api/identity/session/refresh",
        10_000,
        {},
        refreshToken,
      ),
    );
  }

  /**
   * `POST /api/identity/cloud/login`（§31）：断言换原生会话。按分享链接加入时
   * 多带邀请令牌（§31.3：没映射过的远程服务账号凭它建成员）。
   */
  async cloudLogin(
    address: SourceAddress,
    assertion: string,
    invitationToken?: string,
  ): Promise<NativeCredentials> {
    const body = record(
      await this.call(address, "POST", "/api/identity/cloud/login", 10_000, {
        assertion,
        ...(invitationToken === undefined ? {} : { invitationToken }),
      }),
    );
    return credentialsOf(body, str(record(body.principal).displayName));
  }
}
