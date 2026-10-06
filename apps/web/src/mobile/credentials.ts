import {
  ACCESS_RENEW_LEAD_MS,
  createCachedCredentialProvider,
} from "../sources/credentials";
import {
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
  cloudAssertion,
  cloudRefresh,
  coreCloudLogin,
  coreRefresh,
  thisDevice,
} from "./cloud-client";
import { loadConnections } from "./connections";
import {
  type NativeBridge,
  type StoredRemote,
  type StoredSession,
  nativeBridge,
} from "./native-bridge";

/**
 * 手机的 {@link CredentialProvider}（客户端包 §4）：凭据从原生钥匙串读，一个源
 * 一份，写回的也是钥匙串，不进任何用户配置。
 *
 * - `direct`：钥匙串里这个源的会话；访问令牌快到期（或被拒）就用刷新令牌向
 *   Gateway 轮换，写回钥匙串。
 * - `relayed`：先用远程服务的刷新令牌取云会话（刷新令牌每次旋转，写回钥匙串），
 *   再要这个源的断言与中继令牌；源 core 的会话先用存着的刷新令牌经中继轮换，
 *   对端拒了才用断言 `cloud/login` 重新登录。源不在线答 `source_offline`。
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

export function createMobileCredentialProvider(
  deps: MobileCredentialDeps,
): CredentialProvider {
  const now = deps.now ?? Date.now;
  const fresh = (session: StoredSession) =>
    session.expiresAtMs === 0 ||
    session.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS;

  /* ------------------------------ 远程服务会话 ------------------------------ */

  const cloudSessions = new Map<
    string,
    { accessToken: string; expiresAtMs: number }
  >();
  const cloudPending = new Map<string, Promise<string>>();

  const cloudAccess = (remote: StoredRemote): Promise<string> => {
    const cached = cloudSessions.get(remote.serviceId);
    if (
      cached !== undefined &&
      cached.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS
    )
      return Promise.resolve(cached.accessToken);
    let inflight = cloudPending.get(remote.serviceId);
    if (inflight === undefined) {
      inflight = (async () => {
        // 别处（登录、上一次轮换）可能刚换过：读钥匙串里最新的。
        const latest =
          (await deps.bridge.getRemotes()).find(
            (item) => item.serviceId === remote.serviceId,
          ) ?? remote;
        try {
          const session = await cloudRefresh(
            latest.issuer,
            latest.refreshToken,
            deps.cloud,
          );
          if (session.refreshToken !== undefined)
            await deps.bridge.setRemote({
              ...latest,
              refreshToken: session.refreshToken,
            });
          cloudSessions.set(remote.serviceId, {
            accessToken: session.accessToken,
            expiresAtMs: session.accessExpiresAtMs,
          });
          return session.accessToken;
        } catch (error) {
          if (
            error instanceof CloudError &&
            (error.code === "session_expired" ||
              error.code === "session_revoked" ||
              error.status === 401)
          )
            throw unauthorized();
          throw error;
        }
      })().finally(() => {
        cloudPending.delete(remote.serviceId);
      });
      cloudPending.set(remote.serviceId, inflight);
    }
    return inflight;
  };

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
    if (issuer === "") throw unauthorized();
    const serviceId = serviceIdOf(issuer);
    const remote = (await deps.bridge.getRemotes()).find(
      (item) => item.serviceId === serviceId,
    );
    if (remote === undefined) throw unauthorized();
    const device = thisDevice();
    const cloudToken = await cloudAccess(remote);
    const assertion = await cloudAssertion(
      issuer,
      cloudToken,
      sourceId,
      device,
      deps.cloud,
    ).catch((error: unknown) => {
      if (error instanceof CloudError) {
        if (error.code === "source_offline")
          throw unauthorized(SOURCE_ERROR.offline);
        if (error.status === 401 || error.status === 403) throw unauthorized();
      }
      throw error;
    });
    if (!assertion.online) throw unauthorized(SOURCE_ERROR.offline);
    const base = assertion.relayBaseUrl.replace(/\/+$/, "");

    let session = await sessionFor(sourceId, "relayed");
    if (session === undefined || force || !fresh(session)) {
      let next: Pick<
        StoredSession,
        "accessToken" | "refreshToken" | "expiresAtMs"
      > | null = null;
      if (session !== undefined) {
        try {
          const rotated = await coreRefresh(
            base,
            session.refreshToken,
            assertion.relayToken,
            deps.cloud,
          );
          next = {
            accessToken: rotated.native.accessToken,
            refreshToken: rotated.native.refreshToken,
            expiresAtMs: rotated.expiresAtUnixMs,
          };
        } catch (error) {
          // 连不上不是「会话被拒」：往上抛，别白白换一次登录。
          if (!(error instanceof CloudError)) throw error;
        }
      }
      if (next === null) {
        try {
          const login = await coreCloudLogin(
            base,
            assertion.relayToken,
            assertion.assertion,
            undefined,
            deps.cloud,
          );
          next = {
            accessToken: login.native.accessToken,
            refreshToken: login.native.refreshToken,
            expiresAtMs: login.expiresAtUnixMs,
          };
        } catch (error) {
          if (error instanceof CloudError) {
            if (error.code === "source_offline")
              throw unauthorized(SOURCE_ERROR.offline);
            throw unauthorized();
          }
          throw error;
        }
      }
      session = {
        sourceId,
        origin: originOf(issuer),
        via: "relayed",
        ...next,
      };
      await deps.bridge.setSession(session);
    }
    const lifetimes = [
      session.expiresAtMs,
      assertion.relayTokenExpiresAtMs,
    ].filter((value) => value > 0);
    return {
      accessToken: session.accessToken,
      expiresAtMs: lifetimes.length === 0 ? 0 : Math.min(...lifetimes),
      httpBase: base,
      wsBase: wsOf(base),
      relayToken: assertion.relayToken,
    };
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
  };
}

let shared: CredentialProvider | null = null;

/** 页面的那一个：钥匙串经原生桥，源描述取自连接表。 */
export function mobileCredentialProvider(): CredentialProvider {
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
