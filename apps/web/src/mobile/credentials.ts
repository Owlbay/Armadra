import {
  ACCESS_RENEW_LEAD_MS,
  createCachedCredentialProvider,
} from "../sources/credentials";
import {
  type CloudAuth,
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceAccess,
  type SourceDescriptor,
  SourceError,
  type Via,
} from "../sources/types";
import {
  type CloudOptions,
  CloudError,
  coreRefresh,
  thisDevice,
} from "../sources/cloud-client";
import { type RelayVault, createRelayedAccess } from "../sources/relay-access";
import { loadConnections } from "./connections";
import {
  type NativeBridge,
  type StoredSession,
  nativeBridge,
} from "./native-bridge";

/**
 * 手机的 {@link CredentialProvider}（客户端包 §4）：凭据从原生钥匙串读，一个源
 * 一份，写回的也是钥匙串，不进任何用户配置。
 *
 * - `direct`：钥匙串里这个源的会话；访问令牌快到期（或被拒）就用刷新令牌向
 *   Gateway 轮换，写回钥匙串。
 * - `relayed`：与中继托管的页面共用 `sources/relay-access.ts`，保管处是钥匙串：
 *   远程服务的刷新令牌（每次旋转写回）→ 断言与中继令牌 → 源 core 的会话（先轮换，
 *   被拒才用断言 `cloud/login` 重登）。源不在线答 `source_offline`。
 *
 * 钥匙串是刷新令牌唯一的真相：身份面（`api/identity.ts`）轮换后同样写回它，
 * 所以这里每次都读最新的，不在内存里留刷新令牌。
 */

export interface MobileCredentialDeps {
  readonly bridge: NativeBridge;
  /** 源表里的描述（直连地址、签发方）。 */
  readonly describe: (sourceId: string) => SourceDescriptor | undefined;
  readonly cloud?: CloudOptions;
  readonly now?: () => number;
}

/** 远程服务在钥匙串里的键：同一个签发方一份。 */
export function serviceIdOf(issuer: string): string {
  let host = issuer;
  try {
    host = new URL(issuer).host;
  } catch {
    /* 不是地址就原样当键。 */
  }
  return `personal:${host}`;
}

export function originOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

const wsOf = (base: string) => base.replace(/^http/, "ws");

function unauthorized(code: string = SOURCE_ERROR.unauthorized): SourceError {
  return new SourceError(code);
}

/** 手机的凭据来源，外加远程服务会话（挂上的经中继的源开 `me.stream` 用）。 */
export interface MobileCredentialProvider extends CredentialProvider {
  readonly cloudAuth: CloudAuth;
}

export function createMobileCredentialProvider(
  deps: MobileCredentialDeps,
): MobileCredentialProvider {
  const now = deps.now ?? Date.now;
  const fresh = (session: StoredSession) =>
    session.expiresAtMs === 0 ||
    session.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS;

  /* ------------------------------ 经中继（共用） ------------------------------ */

  const remoteOf = async (issuer: string) =>
    (await deps.bridge.getRemotes()).find(
      (item) => item.serviceId === serviceIdOf(issuer),
    );

  /** 钥匙串当保管处：远程服务一份（键 `serviceId`），源会话一份（键源 + `relayed`）。 */
  const vault: RelayVault = {
    cloudRefreshToken: async (issuer) =>
      (await remoteOf(issuer))?.refreshToken ?? null,
    async saveCloudRefreshToken(issuer, refreshToken) {
      const remote = await remoteOf(issuer);
      if (remote !== undefined)
        await deps.bridge.setRemote({ ...remote, refreshToken });
    },
    async session(sourceId) {
      const stored = await sessionFor(sourceId, "relayed");
      return stored === undefined
        ? undefined
        : {
            accessToken: stored.accessToken,
            refreshToken: stored.refreshToken,
            expiresAtMs: stored.expiresAtMs,
          };
    },
    // 钥匙串的会话形状（原生侧校验）没有 CSRF 密钥：Bearer 模式的轮换不要它
    // （契约 §17.4）；对端是还核它的旧版 core 时轮换被拒，
    // 随后用断言重新登录。
    saveSession: (sourceId, issuer, session) =>
      deps.bridge.setSession({
        sourceId,
        origin: originOf(issuer),
        via: "relayed",
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAtMs: session.expiresAtMs,
      }),
  };
  const relay = createRelayedAccess({
    vault,
    device: () => thisDevice(),
    ...(deps.cloud === undefined ? {} : { cloud: deps.cloud }),
    now,
  });

  /* ---------------------------------- 取访问 ---------------------------------- */

  const sessionFor = async (sourceId: string, via: Via) =>
    (await deps.bridge.getSessions()).find(
      (item) => item.sourceId === sourceId && item.via === via,
    );

  const direct = async (
    descriptor: SourceDescriptor | undefined,
    sourceId: string,
    force: boolean,
  ): Promise<SourceAccess> => {
    const stored = await sessionFor(sourceId, "direct");
    const origin = descriptor?.baseUrl || stored?.origin || "";
    if (stored === undefined || origin === "") throw unauthorized();
    let session = stored;
    if (force || !fresh(stored)) {
      try {
        const next = await coreRefresh(
          origin,
          stored.refreshToken,
          undefined,
          deps.cloud,
        );
        session = {
          ...stored,
          accessToken: next.native.accessToken,
          refreshToken: next.native.refreshToken,
          expiresAtMs: next.expiresAtUnixMs,
        };
        await deps.bridge.setSession(session);
      } catch (error) {
        if (error instanceof CloudError && error.status < 500)
          throw unauthorized();
        throw error;
      }
    }
    const base = origin.replace(/\/+$/, "");
    return {
      accessToken: session.accessToken,
      expiresAtMs: session.expiresAtMs,
      httpBase: base,
      wsBase: wsOf(base),
    };
  };

  const relayed = async (
    descriptor: SourceDescriptor | undefined,
    sourceId: string,
    force: boolean,
  ): Promise<SourceAccess> => {
    const issuer = descriptor?.cloudIssuer ?? "";
    if (issuer === "" || (await remoteOf(issuer)) === undefined)
      throw unauthorized();
    return relay.access(issuer, sourceId, force);
  };

  const forced = new Set<string>();
  const cached = createCachedCredentialProvider(async (sourceId, via) => {
    const force = forced.delete(sourceId);
    const descriptor = deps.describe(sourceId);
    if (via === "direct") return direct(descriptor, sourceId, force);
    if (via === "relayed") return relayed(descriptor, sourceId, force);
    throw unauthorized();
  }, now);

  return {
    getAccess: (sourceId, via) => cached.getAccess(sourceId, via),
    refresh(sourceId, via) {
      forced.add(sourceId);
      return cached.refresh(sourceId, via);
    },
    invalidate: (sourceId) => cached.invalidate(sourceId),
    cloudAuth: relay.cloudSessions,
  };
}

let shared: MobileCredentialProvider | null = null;

/** 页面的那一个：钥匙串经原生桥，源描述取自连接表。 */
export function mobileCredentialProvider(): MobileCredentialProvider {
  shared ??= createMobileCredentialProvider({
    bridge: nativeBridge(),
    describe: (sourceId) =>
      loadConnections().find((row) => row.sourceId === sourceId),
  });
  return shared;
}

/** 测试换掉页面那一个。 */
export function resetMobileCredentialProvider(): void {
  shared = null;
}
