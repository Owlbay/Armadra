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
import { routesOf } from "../sources/routing";
import { loadConnections, remoteSlotOf, touchRoute } from "./connections";
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
  /**
   * 这个源的这条中继用钥匙串里哪一份远程服务登录（{@link serviceIdOf}）；`null`
   * = 早先没记过，落回签发方的单槽。缺省读连接表旁的记录（`connections.ts`）。
   */
  readonly slotOf?: (sourceId: string, origin?: string) => string | null;
  /** 一条路连通了（选路按最近成功排）。缺省记进连接表。 */
  readonly touched?: (sourceId: string, via: Via, origin: string) => void;
  /** 连接表（给 `me.stream` 选用哪一份登录）。缺省读本地存储。 */
  readonly connections?: () => readonly SourceDescriptor[];
  readonly cloud?: CloudOptions;
  readonly now?: () => number;
}

/** 访客主体：按它经分享链接加入的那台源区分（一条链接一个访客会话）。 */
export function guestPrincipal(sourceId: string): string {
  return `guest.${sourceId}`;
}

/**
 * 远程服务在钥匙串里的键。同一个签发方下按主体分槽：主人按账号
 * （`personal:<host>:<账号>`），访客按 {@link guestPrincipal}——访客链接加入时
 * 不再覆盖主人的登录（A1-5 留下的问题）。不给主体是早先的单槽
 * `personal:<host>`：旧连接没有槽的记录，照旧读它，数据不搬不丢。
 *
 * 键只用钥匙串认的字符（`[A-Za-z0-9._:-]`，≤ 128），主体里别的字符换成 `_`。
 */
export function serviceIdOf(issuer: string, principal?: string): string {
  let host = issuer;
  try {
    host = new URL(issuer).host;
  } catch {
    /* 不是地址就原样当键。 */
  }
  const base = `personal:${host}`;
  if (principal === undefined || principal === "") return base;
  return `${base}:${principal.replace(/[^A-Za-z0-9._-]/g, "_")}`.slice(0, 128);
}

/** 这一槽是不是访客的。 */
export function isGuestSlot(serviceId: string): boolean {
  return /:guest\.[^:]*$/.test(serviceId);
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
  const slotOf = deps.slotOf ?? remoteSlotOf;
  const connections = deps.connections ?? loadConnections;
  const touched =
    deps.touched ??
    ((sourceId: string, via: Via, origin: string) => {
      if (via !== "local") touchRoute(sourceId, via, origin, now());
    });

  /* ------------------------------ 经中继（共用） ------------------------------ */

  /** 这个源这条中继用的那一槽：记过的，或签发方早先的单槽。 */
  const slotFor = (sourceId: string, origin: string, issuer: string) =>
    slotOf(sourceId, origin) ?? serviceIdOf(issuer);

  const remoteIn = async (slot: string) =>
    (await deps.bridge.getRemotes()).find((item) => item.serviceId === slot);

  /**
   * 钥匙串当保管处，一槽一个：远程服务的刷新令牌在这一槽（键 `serviceId`），
   * 源会话一份（键源 + `relayed`）。一槽各有自己的云会话缓存，主人与访客在
   * 同一个签发方下互不顶替。
   */
  const vaultFor = (slot: string, issuer: string): RelayVault => ({
    cloudRefreshToken: async () => (await remoteIn(slot))?.refreshToken ?? null,
    async saveCloudRefreshToken(_issuer, refreshToken) {
      const remote = await remoteIn(slot);
      if (remote !== undefined)
        await deps.bridge.setRemote({ ...remote, refreshToken });
    },
    async session(sourceId) {
      // 钥匙串一个源只存一份经中继的会话（键 `sourceId` + `via`）：存着的是别的
      // 中继的，就当没有——core 的会话绑在登录它的中继上，拿去这条换票必然被拒。
      const stored = await sessionFor(sourceId, "relayed");
      return stored === undefined || stored.origin !== originOf(issuer)
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
  });
  const relays = new Map<string, ReturnType<typeof createRelayedAccess>>();
  const relayFor = (slot: string, issuer: string) => {
    const key = `${slot}\u0000${issuer}`;
    let relay = relays.get(key);
    if (relay === undefined) {
      relay = createRelayedAccess({
        vault: vaultFor(slot, issuer),
        device: () => thisDevice(),
        ...(deps.cloud === undefined ? {} : { cloud: deps.cloud }),
        now,
      });
      relays.set(key, relay);
    }
    return relay;
  };

  /**
   * `me.stream` 一个签发方一条：用主人的那一槽（访客的会话只看得到它加入的那
   * 一台），没有主人才用访客的。
   */
  const streamSlot = (issuer: string) => {
    const slots = connections().flatMap((row) =>
      routesOf(row)
        .filter(
          (route) => route.via === "relayed" && route.cloudIssuer === issuer,
        )
        .map((route) => slotFor(row.sourceId, route.origin, issuer)),
    );
    return (
      slots.find((slot) => !isGuestSlot(slot)) ??
      slots[0] ??
      serviceIdOf(issuer)
    );
  };
  const cloudAuth: CloudAuth = {
    access: (issuer) =>
      relayFor(streamSlot(issuer), issuer).cloudSessions.access(issuer),
    invalidate(issuer) {
      for (const relay of relays.values())
        relay.cloudSessions.invalidate(issuer);
    },
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
    wanted: string | undefined,
  ): Promise<SourceAccess> => {
    const stored = await sessionFor(sourceId, "direct");
    const origin = wanted || descriptor?.baseUrl || stored?.origin || "";
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
    touched(sourceId, "direct", origin);
    return {
      accessToken: session.accessToken,
      expiresAtMs: session.expiresAtMs,
      httpBase: base,
      wsBase: wsOf(base),
    };
  };

  /**
   * 经中继：给了 `wanted` 走那一条，否则走首选的那条（§55）。槽按 `(源, 来源)`，
   * 同一台主机经两个中继各用自己那个服务的登录。
   */
  const relayed = async (
    descriptor: SourceDescriptor | undefined,
    sourceId: string,
    force: boolean,
    wanted: string | undefined,
  ): Promise<SourceAccess> => {
    const routes =
      descriptor === undefined
        ? []
        : routesOf(descriptor).filter((route) => route.via === "relayed");
    const route =
      wanted === undefined
        ? routes[0]
        : routes.find((one) => one.origin === wanted);
    const issuer = route?.cloudIssuer || descriptor?.cloudIssuer || "";
    if (issuer === "") throw unauthorized();
    const origin = route?.origin ?? descriptor?.relayOrigin ?? issuer;
    const slot = slotFor(sourceId, origin, issuer);
    if ((await remoteIn(slot)) === undefined) throw unauthorized();
    const access = await relayFor(slot, issuer).access(issuer, sourceId, force);
    touched(sourceId, "relayed", origin);
    return access;
  };

  const forced = new Set<string>();
  const cached = createCachedCredentialProvider(
    async (sourceId, via, origin) => {
      const force = forced.delete(sourceId);
      const descriptor = deps.describe(sourceId);
      if (via === "direct") return direct(descriptor, sourceId, force, origin);
      if (via === "relayed")
        return relayed(descriptor, sourceId, force, origin);
      throw unauthorized();
    },
    now,
  );

  return {
    getAccess: (sourceId, via, origin) =>
      cached.getAccess(sourceId, via, origin),
    refresh(sourceId, via, origin) {
      forced.add(sourceId);
      return cached.refresh(sourceId, via, origin);
    },
    invalidate: (sourceId) => cached.invalidate(sourceId),
    cloudAuth,
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
