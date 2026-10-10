/**
 * 测试用的对端：一个假的个人中转（`/v1/*` 子集）与几台假的 core（Gateway 与经
 * 中继的那一面），都挂在一个 {@link Transport} 上，不开端口。
 *
 * 形状照 armadra-cloud 的 cloud-api §2、§4、§10 与 core 契约 §3、§24、§31：刷新
 * 令牌每次旋转，旧令牌再出现即撤销整台设备（`session_revoked`）——并发换票的
 * 毛病在这里会真的把自己登出。
 */

import { fail } from "../http/errors";
import type { OutboundAnswer, OutboundRequest, Transport } from "./http-client";
import type { SecretBackend } from "../secrets/backend";

export const ISSUER = "https://relay.test";
export const RELAY_FP = "a".repeat(64);
export const GATEWAY = "https://gw.test:8443";
export const GATEWAY_FP = "b".repeat(64);
export const PEER_ID = "1".repeat(32);
export const RELAYED_ID = "2".repeat(32);
export const ACCOUNT = "owner";
/** 假中继认的挑战令牌（契约 §62）。 */
export const CHALLENGE_TOKEN = "turnstile-ok";
export const PASSWORD = "correct horse battery staple";

let counter = 0;
function token(prefix: string): string {
  counter += 1;
  return `${prefix}-secret-${counter}-${Math.random().toString(36).slice(2)}`;
}

function json(status: number, body: unknown): OutboundAnswer {
  return { status, body };
}

/** 一组会旋转的刷新令牌：旧的再出现就整组作废。 */
class Rotating {
  private current = new Map<string, string>();
  private retired = new Map<string, string>();
  private revoked = new Set<string>();

  issue(device: string): string {
    const value = token(`refresh-${device}`);
    this.current.set(value, device);
    return value;
  }

  rotate(
    value: string,
  ): { device: string; next: string } | "revoked" | "unknown" {
    const device = this.current.get(value);
    if (device !== undefined && !this.revoked.has(device)) {
      this.current.delete(value);
      this.retired.set(value, device);
      return { device, next: this.issue(device) };
    }
    const reused = this.retired.get(value);
    if (reused !== undefined) {
      this.revoked.add(reused);
      return "revoked";
    }
    return "unknown";
  }

  revokeAll(): void {
    for (const device of this.current.values()) this.revoked.add(device);
  }
}

export interface FakeCore {
  readonly hostId: string;
  tickets: Set<string>;
  readonly sessions: Rotating;
  /** 经中继时要求的令牌；`undefined` = 直连面。 */
  readonly requireRelayToken: boolean;
  cloudLogins: number;
  refuseCloudLogin?: string;
  /** 最近一次 `cloud/login` 带的邀请令牌。 */
  lastInvitation?: string;
  /** hello 报的「主机名称」（契约 §61）；不给不报。 */
  hostName?: string;
}

/** 假中继上的一条分享链接（cloud-api §5）。 */
export interface FakeLink {
  readonly secret: string;
  readonly sourceId: string;
  state: "ok" | "expired" | "exhausted" | "revoked";
  uses: number;
  /** `links.create` 建的才有这些（契约 §33.9 的列表用）。 */
  label?: string;
  role?: string;
  invitationId?: string;
  maxUses?: number | null;
  expiresAtMs?: number;
  createdAtMs?: number;
  /** 协议 1.1 的分享范围（`links.scope` 能力）。 */
  scope?: Record<string, unknown>;
}

export interface FakeWorld {
  readonly transport: Transport;
  readonly requests: OutboundRequest[];
  /** 下线的地址前缀：请求它们一律当作连不上。 */
  readonly down: Set<string>;
  /** 每个地址前缀要求的指纹。 */
  readonly fingerprints: Map<string, string>;
  readonly cloud: {
    sessions: Rotating;
    accessTokens: Set<string>;
    locked: boolean;
    online: boolean;
    assertions: number;
    sources: { sourceId: string; name: string }[];
    links: Map<string, FakeLink>;
    /** `platform.info` 报的能力。 */
    capabilities: string[];
    /** `platform.info` 报的服务端名称（契约 §61）；空串不报。 */
    name: string;
    /**
     * `platform.info.challenge`（契约 §62）：`null` 不要求；要求时登录必须带
     * `challenge.token === "turnstile-ok"`，其余答 `challenge_invalid`。
     */
    challenge: { siteKey: string; scope: string[] } | null;
  };
  readonly cores: Map<string, FakeCore>;
  /** 直连 hello 不回答（等超时）。 */
  readonly slow: Set<string>;
  /** 每一个发出去的字符串（请求体与头），扫凭据用。 */
  readonly sentSecrets: string[];
}

function bearer(request: OutboundRequest): string {
  const value = request.headers?.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function body(request: OutboundRequest): Record<string, unknown> {
  return typeof request.body === "object" && request.body !== null
    ? (request.body as Record<string, unknown>)
    : {};
}

export function fakeWorld(): FakeWorld {
  const cloudSessions = new Rotating();
  const accessTokens = new Set<string>();
  const cores = new Map<string, FakeCore>();
  const makeCore = (hostId: string, requireRelayToken: boolean): FakeCore => ({
    hostId,
    tickets: new Set(["ticket-1"]),
    sessions: new Rotating(),
    requireRelayToken,
    cloudLogins: 0,
  });
  cores.set(GATEWAY, makeCore(PEER_ID, false));
  cores.set(`${ISSUER}/s/${RELAYED_ID}`, makeCore(RELAYED_ID, true));
  cores.set(`${ISSUER}/s/${PEER_ID}`, makeCore(PEER_ID, true));

  const world: FakeWorld = {
    requests: [],
    down: new Set(),
    fingerprints: new Map([
      [ISSUER, RELAY_FP],
      [GATEWAY, GATEWAY_FP],
    ]),
    cloud: {
      sessions: cloudSessions,
      accessTokens,
      locked: false,
      online: true,
      assertions: 0,
      sources: [
        { sourceId: RELAYED_ID, name: "studio" },
        { sourceId: PEER_ID, name: "laptop" },
      ],
      links: new Map(),
      capabilities: [
        "auth.password",
        "links.source-invite",
        "links.update",
        "links.scope",
        "me.stream",
      ],
      name: "",
      challenge: null,
    },
    cores,
    slow: new Set(),
    sentSecrets: [],
    transport: async (request) => {
      world.requests.push(request);
      world.sentSecrets.push(
        JSON.stringify(request.body ?? null),
        JSON.stringify(request.headers ?? {}),
      );
      const url = new URL(request.url);
      for (const prefix of world.down) {
        if (request.url.startsWith(prefix)) {
          throw fail("source_unreachable", "连不上");
        }
      }
      const pinned = world.fingerprints.get(url.origin);
      if (pinned !== undefined && request.fingerprint !== pinned) {
        throw fail("fingerprint_mismatch", "指纹不对");
      }
      // 远程服务。
      if (url.origin === ISSUER && !url.pathname.startsWith("/s/")) {
        return cloud(world, request, url.pathname);
      }
      // 某台 core（直连或经中继）。
      for (const [base, core] of cores) {
        if (request.url.startsWith(`${base}/`)) {
          if (world.slow.has(base) && url.pathname.endsWith("/hello")) {
            await new Promise((done) =>
              setTimeout(done, request.timeoutMs + 5),
            );
            throw fail("source_unreachable", "超时");
          }
          return peer(world, core, request, request.url.slice(base.length));
        }
      }
      throw fail("source_unreachable", "连不上");
    },
  };
  return world;
}

function sessionBody(world: FakeWorld, refreshToken: string, device: string) {
  const accessToken = token("cloud-access");
  world.cloud.accessTokens.add(accessToken);
  return {
    session: {
      accessToken,
      refreshToken,
      accessExpiresAtMs: Date.now() + 15 * 60_000,
      expiresAtMs: Date.now() + 30 * 86_400_000,
      account: {
        accountId: `acct:${ACCOUNT}`,
        email: null,
        displayName: ACCOUNT,
        emailVerified: false,
      },
      device: { deviceId: device },
    },
  };
}

/** `links.list` / `links.update` 的一行（cloud-api §5 `linkSummary`）。 */
function linkSummary(linkId: string, link: FakeLink): Record<string, unknown> {
  return {
    linkId,
    kind: "source_invite",
    label: link.label ?? "",
    role: link.role ?? "viewer",
    sourceId: link.sourceId,
    url: `${ISSUER}/j/${linkId}`,
    uses: link.uses,
    maxUses: link.state === "exhausted" ? link.uses : (link.maxUses ?? null),
    expiresAtMs:
      link.state === "expired"
        ? Date.now() - 1
        : (link.expiresAtMs ?? Date.now() + 86_400_000),
    createdAtMs: link.createdAtMs ?? 0,
    revokedAtMs: link.state === "revoked" ? Date.now() : null,
    ...(link.scope === undefined ? {} : { scope: link.scope }),
  };
}

async function cloud(
  world: FakeWorld,
  request: OutboundRequest,
  path: string,
): Promise<OutboundAnswer> {
  const input = body(request);
  if (path === "/.well-known/armadra-platform") {
    return json(200, {
      mode: "personal",
      ...(world.cloud.name === "" ? {} : { name: world.cloud.name }),
      issuer: ISSUER,
      protocol: { major: 0, minor: 1 },
      capabilities: [...world.cloud.capabilities],
      relay: { addressing: "path" },
      webApp: null,
      ...(world.cloud.challenge === null
        ? {}
        : {
            challenge: { provider: "turnstile", ...world.cloud.challenge },
          }),
    });
  }
  if (path === "/v1/auth/login") {
    if (world.cloud.challenge?.scope.includes("auth.login")) {
      const challenge = input.challenge as { token?: unknown } | undefined;
      if (challenge === undefined) {
        return json(400, { code: "challenge_required", message: "need" });
      }
      if (challenge.token !== CHALLENGE_TOKEN) {
        return json(400, { code: "challenge_invalid", message: "bad" });
      }
    }
    if (world.cloud.locked) {
      return json(429, {
        code: "account_locked",
        message: "locked",
        details: { retryAfterMs: 60_000 },
      });
    }
    if (input.account !== ACCOUNT || input.password !== PASSWORD) {
      return json(401, { code: "credentials_invalid", message: "nope" });
    }
    const device = `dev-${Math.random().toString(36).slice(2, 8)}`;
    return json(
      200,
      sessionBody(world, world.cloud.sessions.issue(device), device),
    );
  }
  if (path === "/v1/auth/refresh") {
    const rotated = world.cloud.sessions.rotate(String(input.refreshToken));
    if (rotated === "revoked") {
      return json(401, { code: "session_revoked", message: "revoked" });
    }
    if (rotated === "unknown") {
      return json(401, { code: "session_expired", message: "expired" });
    }
    return json(200, sessionBody(world, rotated.next, rotated.device));
  }
  const accept = /^\/v1\/links\/([0-9a-f]+)\/accept$/.exec(path);
  if (accept !== null) {
    const link = world.cloud.links.get(accept[1] as string);
    if (link === undefined || link.state === "revoked") {
      return json(404, { code: "link_invalid", message: "no" });
    }
    if (input.secret !== link.secret) {
      return json(403, { code: "link_secret_invalid", message: "no" });
    }
    if (link.state === "expired") {
      return json(410, { code: "link_expired", message: "no" });
    }
    if (
      link.state === "exhausted" ||
      (link.maxUses != null && link.uses >= link.maxUses)
    ) {
      return json(410, { code: "link_exhausted", message: "no" });
    }
    link.uses += 1;
    const device = `guest-${Math.random().toString(36).slice(2, 8)}`;
    return json(200, {
      sourceId: link.sourceId,
      relayOrigin: ISSUER,
      relayBaseUrl: `${ISSUER}/s/${link.sourceId}`,
      assertion: token(`assertion-${link.sourceId}`),
      relayToken: token("relay"),
      guestSession: sessionBody(
        world,
        world.cloud.sessions.issue(device),
        device,
      ).session,
    });
  }
  const access = bearer(request);
  if (!world.cloud.accessTokens.has(access)) {
    return json(401, { code: "unauthenticated", message: "no" });
  }
  if (path === "/v1/auth/logout") return json(200, {});
  if (path === "/v1/me/sources") {
    return json(200, {
      sources: world.cloud.sources.map((one) => ({
        ...one,
        kind: "desktop",
        online: world.cloud.online,
        lastSeenAtMs: null,
        owner: true,
        via: "owner",
        relayOrigin: ISSUER,
        coreVersion: "0.0.0",
      })),
    });
  }
  if (path === "/v1/links" && request.method === "POST") {
    // `links.create`（cloud-api §5、§10）：只有 source_invite，答一次性的 secret。
    if (input.kind !== "source_invite" || typeof input.sourceId !== "string") {
      return json(400, { code: "bad_request", message: "kind" });
    }
    // 不报 `links.scope` 的旧中继不认 `scope`（严格的请求 schema 答 400）。
    if (
      input.scope !== undefined &&
      !world.cloud.capabilities.includes("links.scope")
    ) {
      return json(400, { code: "bad_request", message: "scope" });
    }
    const linkId = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    const secret = token("link");
    world.cloud.links.set(linkId, {
      secret,
      sourceId: input.sourceId,
      state: "ok",
      uses: 0,
      label: String(input.label ?? ""),
      role: String(input.role ?? ""),
      invitationId: String(input.invitationId ?? ""),
      maxUses: typeof input.maxUses === "number" ? input.maxUses : null,
      expiresAtMs: Number(input.expiresAtMs),
      createdAtMs: Date.now(),
      ...(typeof input.scope === "object" && input.scope !== null
        ? { scope: input.scope as Record<string, unknown> }
        : {}),
    });
    return json(200, {
      linkId,
      url: `${ISSUER}/j/${linkId}`,
      secret,
      expiresAtMs: Number(input.expiresAtMs),
    });
  }
  if (path === "/v1/links" && request.method === "GET") {
    const sourceId = new URL(request.url).searchParams.get("sourceId");
    return json(200, {
      links: [...world.cloud.links]
        .filter(([, link]) => sourceId === null || link.sourceId === sourceId)
        .map(([linkId, link]) => linkSummary(linkId, link)),
    });
  }
  const linkPath = /^\/v1\/links\/([0-9a-f]+)$/.exec(path);
  if (linkPath !== null && request.method === "PATCH") {
    // `links.update`（cloud-api §5）：只改备注。
    const linkId = linkPath[1] as string;
    const link = world.cloud.links.get(linkId);
    if (link === undefined)
      return json(404, { code: "not_found", message: "no" });
    link.label = String(input.label ?? "").trim();
    return json(200, linkSummary(linkId, link));
  }
  if (linkPath !== null && request.method === "DELETE") {
    const link = world.cloud.links.get(linkPath[1] as string);
    if (link === undefined || link.state === "revoked") {
      return json(404, { code: "not_found", message: "no" });
    }
    link.state = "revoked";
    return json(200, {});
  }
  const owned = /^\/v1\/sources\/([0-9a-f]{32})$/.exec(path);
  if (owned !== null && request.method === "DELETE") {
    // `sources.revoke`（cloud-api §4）：删掉目录里的这个源；没有答 not_found。
    const index = world.cloud.sources.findIndex(
      (one) => one.sourceId === owned[1],
    );
    if (index < 0) return json(404, { code: "not_found", message: "no" });
    world.cloud.sources.splice(index, 1);
    return json(200, {});
  }
  const match = /^\/v1\/sources\/([0-9a-f]{32})\/assertion$/.exec(path);
  if (match !== null) {
    world.cloud.assertions += 1;
    const sourceId = match[1] as string;
    return json(200, {
      assertion: token(`assertion-${sourceId}`),
      assertionExpiresAtMs: Date.now() + 300_000,
      relayToken: token("relay"),
      relayTokenExpiresAtMs: Date.now() + 3_600_000,
      relayOrigin: ISSUER,
      relayBaseUrl: `${ISSUER}/s/${sourceId}`,
      online: world.cloud.online,
    });
  }
  return json(404, { code: "not_found", message: path });
}

function nativeBody(core: FakeCore, refreshToken: string, device: string) {
  return {
    hostId: core.hostId,
    device: {
      deviceId: device,
      principalId: "p-owner",
      displayName: "owner",
      role: "owner",
      createdAtUnixMs: 1,
      revision: 1,
    },
    scopes: [],
    expiresAtUnixMs: Date.now() + 15 * 60_000,
    csrfToken: "csrf",
    native: { accessToken: token("core-access"), refreshToken },
  };
}

async function peer(
  world: FakeWorld,
  core: FakeCore,
  request: OutboundRequest,
  path: string,
): Promise<OutboundAnswer> {
  if (request.headers?.origin !== "https://localhost") {
    return json(403, { code: "PERMISSION_DENIED", message: "origin" });
  }
  if (
    core.requireRelayToken &&
    !(request.headers?.["armadra-relay-token"] ?? "")
  ) {
    return json(401, { code: "unauthenticated", message: "relay token" });
  }
  const input = body(request);
  if (path === "/api/identity/hello") {
    return json(200, {
      hostId: core.hostId,
      protocol: { major: 1, minor: 3 },
      ...(core.hostName ? { hostName: core.hostName } : {}),
    });
  }
  if (path === "/api/gateway/pairing-code/exchange") {
    if (input.code !== "ABCD-2345") {
      return json(404, { code: "pairing_code_invalid", message: "no" });
    }
    return json(200, {
      origin: GATEWAY,
      ticket: "ticket-1",
      fingerprint: GATEWAY_FP,
    });
  }
  if (path === "/api/identity/pair") {
    if (!core.tickets.delete(String(input.ticket))) {
      return json(401, { code: "UNAUTHENTICATED", message: "ticket" });
    }
    const device = `core-dev-${Math.random().toString(36).slice(2, 8)}`;
    return json(200, nativeBody(core, core.sessions.issue(device), device));
  }
  if (path === "/api/identity/session/refresh") {
    const rotated = core.sessions.rotate(bearer(request));
    if (typeof rotated === "string") {
      return json(401, { code: "UNAUTHENTICATED", message: "refresh" });
    }
    return json(200, nativeBody(core, rotated.next, rotated.device));
  }
  if (path === "/api/identity/cloud/login") {
    core.cloudLogins += 1;
    if (core.refuseCloudLogin !== undefined) {
      return json(401, { code: core.refuseCloudLogin, message: "refused" });
    }
    if (typeof input.invitationToken === "string") {
      core.lastInvitation = input.invitationToken;
    }
    if (!String(input.assertion).startsWith(`assertion-${core.hostId}`)) {
      return json(401, { code: "cloud_assertion_invalid", message: "bad" });
    }
    const device = `cloud-dev-${Math.random().toString(36).slice(2, 8)}`;
    return json(200, {
      session: nativeBody(core, core.sessions.issue(device), device),
      principal: {
        principalId: "p-owner",
        kind: "owner",
        displayName: ACCOUNT,
      },
      created: false,
    });
  }
  return json(404, { code: "NOT_FOUND", message: path });
}

/** 内存里的密钥后端，可读出全部值（断言凭据只在这里）。 */
export function memoryBackend(): SecretBackend & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    kind: "file",
    values,
    get: async (name) => values.get(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
  };
}
