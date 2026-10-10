/**
 * 对远程服务 `/v1/*` 的调用（契约 §33；远程服务一侧的形状见 armadra-cloud 的
 * cloud-api §2、§4、§10）。外呼登记 `net/outbound.ts` 的 `cloudApi`。
 *
 * 只实现个人中转用到的那几条：`platform.info`、`auth.login`、`auth.refresh`、
 * `auth.logout`、`auth.changePassword`（契约 §63）、`me.sources`、`sources.assertion`、
 * `sources.revoke`、`links.accept`，
 * 以及分享链接的 `links.create` / `links.list` / `links.update` / `links.revoke`（契约 §33.9、§33.10）。SaaS 的设备码登录等能力就绪
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
  /** 服务端名称（协议包 0.3.1 起可选，契约 §61）；旧中继不报是空串。 */
  readonly name: string;
  readonly issuer: string;
  readonly capabilities: readonly string[];
  /** 服务端要求的挑战（cloud-api §16，协议包 0.3.5 起）；不要求就没有。 */
  readonly challenge?: PlatformChallenge;
}

/** `platform.info.challenge`：`scope` 里的 procedure 登录 / 加入时必须带挑战令牌。 */
export interface PlatformChallenge {
  readonly provider: "turnstile";
  readonly siteKey: string;
  readonly scope: readonly string[];
}

/** 解出 `platform.info.challenge`；形状不对当作没有（不要求）。 */
function challengeOf(value: unknown): PlatformChallenge | undefined {
  const raw = record(value);
  const siteKey = str(raw.siteKey).trim();
  if (raw.provider !== "turnstile" || siteKey === "") return undefined;
  const scope = Array.isArray(raw.scope)
    ? raw.scope.filter((one): one is string => typeof one === "string")
    : [];
  return { provider: "turnstile", siteKey, scope };
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

/** `links.create` 的答案（cloud-api §5、§10）：`secret` 只在这一次出现。 */
export interface CreatedLink {
  readonly linkId: string;
  readonly url: string;
  readonly secret: string;
  readonly expiresAtMs: number;
}

/** 分享范围（cloud-api `linkScope`，协议 1.1 起；中继报 `links.scope` 能力才发）。 */
export interface LinkScope {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly readOnly?: boolean;
}

/** `links.list` 的一行（cloud-api §5 `linkSummary`）。 */
export interface LinkSummary {
  readonly linkId: string;
  readonly kind: string;
  readonly label: string;
  readonly role: string;
  readonly sourceId: string;
  readonly url: string;
  readonly uses: number;
  readonly maxUses: number | null;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
  /** 中继记着的分享范围；旧中继没有。 */
  readonly scope?: LinkScope;
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
  if (code === "bad_request" && during === "建分享链接") {
    throw fail("bad_request", "远程服务不接受这条链接的参数");
  }
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
    // 改口令（cloud-api §18）：新口令不合策略，码原样透传，页面按码取文案。
    case "password_too_short":
      throw fail("password_too_short", "新口令太短");
    case "password_too_long":
      throw fail("password_too_long", "新口令太长");
    case "password_contains_name":
      throw fail("password_contains_name", "新口令不能包含账号名");
    case "password_too_common":
      throw fail("password_too_common", "新口令太常见");
    case "password_breached":
      throw fail("password_breached", "新口令出现在泄露的口令表里");
    // 挑战（cloud-api §16）：缺失与无效分开，页面按码取文案。
    case "challenge_required":
      throw fail("challenge_required", "远程服务要求先完成人机验证");
    case "challenge_invalid":
      throw fail("challenge_invalid", "人机验证没有通过");
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
      if (
        during === "取断言" ||
        during === "删除源" ||
        during === "撤销分享链接" ||
        during === "改分享链接备注"
      ) {
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

/** `links.list` / `links.update` 的一行；`linkId` 不像样的丢掉（`null`）。 */
function scopeOf(value: unknown): LinkScope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = record(value);
  const scope: {
    workspaceId?: string;
    sessionId?: string;
    readOnly?: boolean;
  } = {};
  if (typeof row.workspaceId === "string") scope.workspaceId = row.workspaceId;
  if (typeof row.sessionId === "string") scope.sessionId = row.sessionId;
  if (row.readOnly === true) scope.readOnly = true;
  return Object.keys(scope).length === 0 ? undefined : scope;
}

function linkSummaryOf(value: unknown): LinkSummary | null {
  const row = record(value);
  const linkId = str(row.linkId);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(linkId)) return null;
  return {
    linkId,
    kind: str(row.kind),
    label: str(row.label),
    role: str(row.role),
    sourceId: str(row.sourceId),
    url: str(row.url),
    uses: num(row.uses),
    maxUses: typeof row.maxUses === "number" ? row.maxUses : null,
    expiresAtMs: num(row.expiresAtMs),
    createdAtMs: num(row.createdAtMs),
    revokedAtMs: typeof row.revokedAtMs === "number" ? row.revokedAtMs : null,
    ...(scopeOf(row.scope) === undefined ? {} : { scope: scopeOf(row.scope) }),
  };
}

export class RemoteClient {
  constructor(
    private readonly transport: Transport,
    private readonly device: DeviceInput,
  ) {}

  private async call(
    endpoint: RemoteEndpoint,
    method: "GET" | "POST" | "PATCH" | "DELETE",
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
    const challenge = challengeOf(body.challenge);
    return {
      mode,
      name: str(body.name).trim().slice(0, 128),
      issuer: str(body.issuer),
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter(
            (one): one is string => typeof one === "string",
          )
        : [],
      ...(challenge === undefined ? {} : { challenge }),
    };
  }

  async login(
    endpoint: RemoteEndpoint,
    account: string,
    password: string,
    challengeToken?: string,
  ): Promise<CloudSession> {
    const body = await this.call(endpoint, "POST", "/v1/auth/login", "登录", {
      account,
      password,
      device: this.device,
      ...(challengeToken === undefined || challengeToken === ""
        ? {}
        : { challenge: { provider: "turnstile", token: challengeToken } }),
    });
    if ("mfa" in record(body)) {
      // 个人中转没有二次验证；SaaS 的 MFA 随 SaaS 登录一起再做。
      throw fail("not_implemented", "这个远程服务要求二次验证，当前版本不支持");
    }
    return sessionOf(body);
  }

  /**
   * 改口令（cloud-api §18）：要这台设备的访问令牌与旧口令。答这台设备换了刷新令牌的
   * 新会话；账号的其它设备由远程服务撤销。
   */
  async changePassword(
    endpoint: RemoteEndpoint,
    accessToken: string,
    password: string,
    newPassword: string,
    challengeToken?: string,
  ): Promise<CloudSession> {
    return sessionOf(
      await this.call(
        endpoint,
        "POST",
        "/v1/auth/password",
        "改口令",
        {
          password,
          newPassword,
          ...(challengeToken === undefined || challengeToken === ""
            ? {}
            : { challenge: { provider: "turnstile", token: challengeToken } }),
        },
        accessToken,
      ),
    );
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

  /** `POST /v1/links`（owner）：建一条指向本机邀请的 `source_invite` 链接。 */
  async createLink(
    endpoint: RemoteEndpoint,
    accessToken: string,
    input: {
      sourceId: string;
      invitationId: string;
      label: string;
      role: string;
      expiresAtMs: number;
      maxUses: number;
      /** 只在中继报 `links.scope` 能力时给（调用方判）。 */
      scope?: LinkScope;
    },
  ): Promise<CreatedLink> {
    const body = record(
      await this.call(
        endpoint,
        "POST",
        "/v1/links",
        "建分享链接",
        { kind: "source_invite", ...input },
        accessToken,
      ),
    );
    const linkId = str(body.linkId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(linkId) || str(body.url) === "") {
      throw fail("source_unreachable", "远程服务建链接的答案不完整");
    }
    return {
      linkId,
      url: str(body.url),
      secret: str(body.secret),
      expiresAtMs: num(body.expiresAtMs),
    };
  }

  /** `GET /v1/links?sourceId=`（owner）：这个源的全部链接，含已撤销与过期的。 */
  async listLinks(
    endpoint: RemoteEndpoint,
    accessToken: string,
    sourceId: string,
  ): Promise<LinkSummary[]> {
    const body = record(
      await this.call(
        endpoint,
        "GET",
        `/v1/links?sourceId=${encodeURIComponent(sourceId)}`,
        "读取分享链接",
        undefined,
        accessToken,
      ),
    );
    const rows = Array.isArray(body.links) ? body.links : [];
    return rows.flatMap((value) => {
      const row = linkSummaryOf(value);
      return row === null ? [] : [row];
    });
  }

  /**
   * `PATCH /v1/links/{linkId}`（owner，cloud-api §5 `links.update`）：只改备注，
   * 答改过之后的链接摘要。没有答 `not_found`。
   */
  async updateLink(
    endpoint: RemoteEndpoint,
    accessToken: string,
    linkId: string,
    label: string,
  ): Promise<LinkSummary> {
    const row = linkSummaryOf(
      await this.call(
        endpoint,
        "PATCH",
        `/v1/links/${encodeURIComponent(linkId)}`,
        "改分享链接备注",
        { label },
        accessToken,
      ),
    );
    if (row === null || row.linkId !== linkId) {
      throw fail("source_unreachable", "远程服务改备注的答案不完整");
    }
    return row;
  }

  /** `DELETE /v1/links/{linkId}`（owner）：撤销链接与它名下的访客。没有答 `not_found`。 */
  async revokeLink(
    endpoint: RemoteEndpoint,
    accessToken: string,
    linkId: string,
  ): Promise<void> {
    await this.call(
      endpoint,
      "DELETE",
      `/v1/links/${encodeURIComponent(linkId)}`,
      "撤销分享链接",
      undefined,
      accessToken,
    );
  }
}
