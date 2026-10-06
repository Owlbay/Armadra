/**
 * 对远程服务 `/v1/*` 的调用（契约 §33；远程服务一侧的形状见 armadra-cloud 的
 * cloud-api §2、§4、§10）。外呼登记 `net/outbound.ts` 的 `cloudApi`。
 *
 * 只实现个人中转用到的那几条：`platform.info`、`auth.login`、`auth.refresh`、
 * `auth.logout`、`me.sources`、`sources.assertion`、`sources.revoke`、`links.accept`。SaaS 的设备码登录等能力就绪
 * 后再加；在那之前 `service.ts` 对 `saas` 答 `not_implemented`。
 *
 * 线上编码是普通 JSON（上游 OpenAPI 编码），错误是 `{ code, message, … }`。这里把
 * 远程服务的码收拢成 core 契约 §33 的码；远程服务的原话不透传（它可能是别的
 * 语言，也不该把对端的内部细节带进本机的答案）。
 */

import { fail } from "../http/errors";
import type { Transport } from "./http-client";

export interface DeviceInput {
  readonly platform: "desktop" | "server";
  readonly name: string;
}

export interface CloudSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAtMs: number;
  readonly accountId: string;
  readonly displayName: string;
  readonly deviceId: string;
}

export interface PlatformInfo {
  readonly mode: "saas" | "personal";
  readonly issuer: string;
  readonly capabilities: readonly string[];
}

export interface RemoteSourceRow {
  readonly sourceId: string;
  readonly name: string;
  readonly kind: "desktop" | "server" | "hosted";
  readonly online: boolean;
  readonly lastSeenAtMs: number | null;
  readonly owner: boolean;
  readonly via: "owner" | "link" | "org";
  readonly relayOrigin: string;
  readonly coreVersion: string;
}

export interface SourceAssertion {
  readonly assertion: string;
  readonly assertionExpiresAtMs: number;
  readonly relayToken: string;
  readonly relayTokenExpiresAtMs: number;
  readonly relayOrigin: string;
  readonly relayBaseUrl: string;
  readonly online: boolean;
}

/** `links.accept` 的答案：访客会话，加上指向那个源的断言与中继令牌。 */
export interface AcceptedLink {
  readonly sourceId: string;
  readonly relayOrigin: string;
  readonly relayBaseUrl: string;
  readonly assertion: string;
  readonly relayToken: string;
  readonly guest: CloudSession;
}

/** 远程服务的一个地址：issuer 来源加它的 CA 指纹（空 = 系统信任）。 */
export interface RemoteEndpoint {
  readonly issuer: string;
  readonly fingerprint: string;
}

const TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sessionOf(body: unknown): CloudSession {
  const session = record(record(body).session);
  const account = record(session.account);
  const device = record(session.device);
  const accessToken = str(session.accessToken);
  const refreshToken = str(session.refreshToken);
  if (accessToken === "" || refreshToken === "") {
    // 浏览器来源的会话不带刷新令牌；core 不是浏览器，没有它就没法记住登录。
    throw fail("source_unreachable", "远程服务的答案里没有可保存的会话");
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresAtMs: num(session.accessExpiresAtMs),
    accountId: str(account.accountId),
    displayName: str(account.displayName),
    deviceId: str(device.deviceId),
  };
}

/** 远程服务的失败 → 契约 §33 的码。 */
function rejected(status: number, body: unknown, during: string): never {
  const answer = record(body);
  const code = str(answer.code);
  const details = record(answer.details);
  switch (code) {
    case "credentials_invalid":
    case "account_disabled":
      throw fail("credentials_invalid", "账号或口令不正确");
    case "account_locked":
      throw fail(
        "account_locked",
        "尝试次数过多，账号已暂时锁定",
        typeof details.retryAfterMs === "number"
          ? { retryAfterMs: details.retryAfterMs }
          : undefined,
      );
    case "rate_limited":
      throw fail("rate_limited", "远程服务限流，请稍后重试");
    case "session_expired":
    case "session_revoked":
    case "unauthenticated":
      throw fail("source_unauthorized", "远程服务的登录已失效");
    case "source_access_denied":
    case "source_revoked":
    case "forbidden":
      throw fail("source_unauthorized", "远程服务不再允许访问这个源");
    case "source_offline":
      throw fail("source_offline", "这台机器当前不在线");
    case "not_found":
      if (during === "取断言" || during === "删除源") {
        throw fail("not_found", "远程服务上没有这个源");
      }
      break;
    case "not_implemented":
      throw fail("not_implemented", "远程服务没有这项能力");
    // 分享链接（cloud-api §5）：码原样透传，页面按码取文案。
    case "link_invalid":
      throw fail("link_invalid", "分享链接不存在或已停用");
    case "link_expired":
      throw fail("link_expired", "分享链接已过期");
    case "link_exhausted":
      throw fail("link_exhausted", "分享链接的使用次数已用完");
    case "link_secret_invalid":
      throw fail("link_secret_invalid", "分享链接不完整");
    default:
      break;
  }
  if (status === 401) {
    throw fail("source_unauthorized", "远程服务的登录已失效");
  }
  throw fail("source_unreachable", `远程服务没能完成${during}（${status}）`);
}

export class RemoteClient {
  constructor(
    private readonly transport: Transport,
    private readonly device: DeviceInput,
  ) {}

  private async call(
    endpoint: RemoteEndpoint,
    method: "GET" | "POST" | "DELETE",
    path: string,
    during: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<unknown> {
    const answer = await this.transport({
      method,
      url: `${endpoint.issuer}${path}`,
      fingerprint: endpoint.fingerprint,
      timeoutMs: TIMEOUT_MS,
      ...(body === undefined ? {} : { body }),
      ...(accessToken === undefined
        ? {}
        : { headers: { authorization: `Bearer ${accessToken}` } }),
    });
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    return rejected(answer.status, answer.body, during);
  }

  async info(endpoint: RemoteEndpoint): Promise<PlatformInfo> {
    const body = record(
      await this.call(endpoint, "GET", "/.well-known/armadra-platform", "握手"),
    );
    const mode = body.mode;
    if (mode !== "saas" && mode !== "personal") {
      throw fail("source_unreachable", "这个地址不是一个远程服务");
    }
    return {
      mode,
      issuer: str(body.issuer),
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter(
            (one): one is string => typeof one === "string",
          )
        : [],
    };
  }

  async login(
    endpoint: RemoteEndpoint,
    account: string,
    password: string,
  ): Promise<CloudSession> {
    const body = await this.call(endpoint, "POST", "/v1/auth/login", "登录", {
      account,
      password,
      device: this.device,
    });
    if ("mfa" in record(body)) {
      // 个人中转没有二次验证；SaaS 的 MFA 随 SaaS 登录一起再做。
      throw fail("not_implemented", "这个远程服务要求二次验证，当前版本不支持");
    }
    return sessionOf(body);
  }

  async refresh(
    endpoint: RemoteEndpoint,
    refreshToken: string,
  ): Promise<CloudSession> {
    return sessionOf(
      await this.call(endpoint, "POST", "/v1/auth/refresh", "刷新", {
        refreshToken,
      }),
    );
  }

  async logout(endpoint: RemoteEndpoint, accessToken: string): Promise<void> {
    await this.call(
      endpoint,
      "POST",
      "/v1/auth/logout",
      "登出",
      {},
      accessToken,
    );
  }

  async sources(
    endpoint: RemoteEndpoint,
    accessToken: string,
  ): Promise<RemoteSourceRow[]> {
    const body = record(
      await this.call(
        endpoint,
        "GET",
        "/v1/me/sources",
        "读取源目录",
        undefined,
        accessToken,
      ),
    );
    const rows = Array.isArray(body.sources) ? body.sources : [];
    return rows.flatMap((value) => {
      const row = record(value);
      const sourceId = str(row.sourceId);
      if (!/^[0-9a-f]{32}$/.test(sourceId)) return [];
      const kind =
        row.kind === "server" || row.kind === "hosted" ? row.kind : "desktop";
      const via = row.via === "link" || row.via === "org" ? row.via : "owner";
      return [
        {
          sourceId,
          name: str(row.name),
          kind,
          online: row.online === true,
          lastSeenAtMs:
            typeof row.lastSeenAtMs === "number" ? row.lastSeenAtMs : null,
          owner: row.owner === true,
          via,
          relayOrigin: str(row.relayOrigin),
          coreVersion: str(row.coreVersion),
        } satisfies RemoteSourceRow,
      ];
    });
  }

  async assertion(
    endpoint: RemoteEndpoint,
    accessToken: string,
    sourceId: string,
  ): Promise<SourceAssertion> {
    const body = record(
      await this.call(
        endpoint,
        "POST",
        `/v1/sources/${sourceId}/assertion`,
        "取断言",
        { sourceId, device: this.device },
        accessToken,
      ),
    );
    const relayBaseUrl = str(body.relayBaseUrl);
    if (str(body.assertion) === "" || relayBaseUrl === "") {
      throw fail("source_unreachable", "远程服务的断言答案不完整");
    }
    return {
      assertion: str(body.assertion),
      assertionExpiresAtMs: num(body.assertionExpiresAtMs),
      relayToken: str(body.relayToken),
      relayTokenExpiresAtMs: num(body.relayTokenExpiresAtMs),
      relayOrigin: str(body.relayOrigin),
      relayBaseUrl: relayBaseUrl.replace(/\/+$/, ""),
      online: body.online !== false,
    };
  }

  /**
   * `DELETE /v1/sources/{sourceId}`（cloud-api §4 `sources.revoke`，要 owner 的会话）：
   * 删中继侧的源记录，隧道随之断开。中继上已经没有这个源答 `not_found`。
   */
  async revokeSource(
    endpoint: RemoteEndpoint,
    accessToken: string,
    sourceId: string,
  ): Promise<void> {
    await this.call(
      endpoint,
      "DELETE",
      `/v1/sources/${encodeURIComponent(sourceId)}`,
      "删除源",
      undefined,
      accessToken,
    );
  }

  /**
   * `POST /v1/links/{linkId}/accept`（匿名）：分享链接的秘密换访客会话、断言与
   * 中继令牌（cloud-api §5、§10）。秘密只在请求体里，不进日志。
   */
  async acceptLink(
    endpoint: RemoteEndpoint,
    linkId: string,
    secret: string,
  ): Promise<AcceptedLink> {
    const body = record(
      await this.call(
        endpoint,
        "POST",
        `/v1/links/${encodeURIComponent(linkId)}/accept`,
        "接受分享链接",
        { secret, device: this.device },
      ),
    );
    const sourceId = str(body.sourceId);
    const relayBaseUrl = str(body.relayBaseUrl);
    if (
      !/^[0-9a-f]{32}$/.test(sourceId) ||
      relayBaseUrl === "" ||
      str(body.assertion) === "" ||
      str(body.relayToken) === ""
    ) {
      throw fail("source_unreachable", "远程服务接受链接的答案不完整");
    }
    return {
      sourceId,
      relayOrigin: str(body.relayOrigin),
      relayBaseUrl: relayBaseUrl.replace(/\/+$/, ""),
      assertion: str(body.assertion),
      relayToken: str(body.relayToken),
      guest: sessionOf({ session: body.guestSession }),
    };
  }
}
