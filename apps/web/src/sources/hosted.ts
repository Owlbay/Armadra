import {
  type HostedSessionStore,
  restoreHostedCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import {
  type CloudOptions,
  type CloudSource,
  CloudError,
  browserDevice,
  cloudLogin,
  cloudAcceptLink,
  cloudLogout,
  cloudPlatformInfo,
  coreCloudLogin,
  cloudSources,
} from "./cloud-client";
import { createCachedCredentialProvider } from "./credentials";
import { type SiblingMount, mountSiblingSources } from "./mounts";
import { sourceRegistry } from "./registry";
import {
  type RelaySession,
  type RelayVault,
  createCloudSessions,
  createRelayedAccess,
} from "./relay-access";
import {
  type RemoteStream,
  type StreamTarget,
  applyMeStreamEvent,
  createRemoteStream,
  resyncTargets,
} from "./remote-stream";
import { type EnteredRoute, enterRoute } from "./route-entry";
import {
  type CredentialProvider,
  SOURCE_ERROR,
  type SourceDescriptor,
  SourceError,
  type SourceFailure,
  type SourceState,
} from "./types";

/**
 * 中继托管的页面（客户端包 §5，平台设计 §17.3）：个人中转在 `/app/` 托管的就是
 * 这份 `apps/web`。页面背后没有本机 core：用中继账号口令登录远程服务，挑一台
 * 主机，把它经中继装成页面的本机源（`route-entry.ts`，与手机同一份）。
 *
 * - 凭据只在内存（{@link createMemoryRelayVault}）：远程服务的刷新令牌、源 core
 *   的会话都在这一个标签页里，关标签即丢，重开再登录。不写任何存储。
 * - 所有请求同源（中继的 `/v1/*`、`/s/<源>/…`）：中继给页面的 CSP 是
 *   `connect-src 'self'`，core 认中继来源为可信来源（契约 §32）。
 * - `me.stream`：主机下线 → 等它上线（`waitingForSource`），上线 → 叫醒事件流；
 *   主机被撤销、访问被收回 → `unauthorized`，界面提示重新登录。
 */

/** 页面路径在中继托管的那一段下（`/app/…`）。只有这时才去问平台信息。 */
export function underRelayAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

export interface RelayHost {
  /** 远程服务的签发方，也就是页面自己的来源。 */
  readonly issuer: string;
}

/**
 * 这张页面是不是个人中转托管的：路径在 `/app/` 下，同源的
 * `/.well-known/armadra-platform` 答 `personal`，签发方就是页面来源。不是就
 * `null`（桌面窗口、服务器壳、开发服务器都不在 `/app/` 下，一个请求也不发）。
 */
export async function detectRelayHost(
  location:
    | Pick<Location, "origin" | "pathname">
    | undefined = globalThis.location,
  options: CloudOptions = {},
): Promise<RelayHost | null> {
  if (location === undefined || !underRelayAppPath(location.pathname))
    return null;
  const info = await cloudPlatformInfo(location.origin, {
    timeoutMs: 5_000,
    ...options,
  }).catch(() => null);
  if (info === null || info.mode !== "personal") return null;
  let issuer: string;
  try {
    issuer = new URL(info.issuer).origin;
  } catch {
    return null;
  }
  return issuer === location.origin ? { issuer } : null;
}

/* --------------------------------- 保管处 --------------------------------- */

export interface MemoryRelayVault extends RelayVault {
  clear(): void;
}

/** 只在内存里的保管处：一个签发方一把刷新令牌，一个源一份会话。 */
export function createMemoryRelayVault(): MemoryRelayVault {
  const remotes = new Map<string, string>();
  const sessions = new Map<string, RelaySession>();
  return {
    cloudRefreshToken: async (issuer) => remotes.get(issuer) ?? null,
    async saveCloudRefreshToken(issuer, refreshToken) {
      remotes.set(issuer, refreshToken);
    },
    async forgetCloud(issuer) {
      remotes.delete(issuer);
    },
    session: async (sourceId) => sessions.get(sourceId),
    async saveSession(sourceId, _issuer, session) {
      sessions.set(sourceId, session);
    },
    clear() {
      remotes.clear();
      sessions.clear();
    },
  };
}

/* --------------------------------- 状态 ---------------------------------- */

export interface HostedStatus {
  readonly state: SourceState;
  readonly lastError: SourceFailure | null;
}

/** 登录、挑主机的失败原因；文案键 `remote.error.<原因>`。 */
export type HostedFailure =
  | "credentials"
  | "locked"
  | "rateLimited"
  | "unreachable"
  | "offline"
  | "unlinked"
  | "revoked"
  | "noSources"
  | "failed";

/** 远程服务与源的拒绝 → 原因。 */
export function hostedFailureOf(error: unknown): HostedFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof CloudError) {
    if (code === "credentials_invalid") return "credentials";
    if (code === "account_locked") return "locked";
    if (code === "rate_limited") return "rateLimited";
  }
  if (code === SOURCE_ERROR.offline) return "offline";
  if (code === "cloud_account_unlinked" || code === "cloud_not_registered")
    return "unlinked";
  if (code === SOURCE_ERROR.revoked || code === SOURCE_ERROR.accessRevoked)
    return "revoked";
  if (code === SOURCE_ERROR.unreachable) return "unreachable";
  if (
    error instanceof TypeError ||
    (error as Error)?.name === "CloudTransportError"
  )
    return "unreachable";
  return "failed";
}

export interface HostedRelayOptions {
  readonly issuer: string;
  readonly cloud?: CloudOptions;
  /** 测试注入：造 `me.stream`。 */
  readonly createStream?: typeof createRemoteStream;
  /** 测试注入：装成本机源（缺省 `route-entry.ts`）。 */
  readonly enter?: typeof enterRoute;
  /** 测试注入：叫醒页面的流（缺省本机源上托管的流，即控制面）。 */
  readonly wake?: () => void;
  /** 测试注入：把目录里其余的主机挂进页面源表（缺省 `mounts.ts`）。 */
  readonly mount?: typeof mountSiblingSources;
}

/** 目录里的一台主机 → 经这个中继到达的源描述。 */
function relayedDescriptor(
  issuer: string,
  source: Pick<CloudSource, "sourceId" | "name">,
): SourceDescriptor {
  return {
    sourceId: source.sourceId,
    kind: "relayed",
    label: source.name,
    baseUrl: "",
    relayOrigin: issuer,
    cloudIssuer: issuer,
    fingerprint: "",
    orderIndex: 0,
  };
}

export interface HostedRelay {
  readonly issuer: string;
  readonly provider: CredentialProvider;
  /** 口令登录远程服务，答它目录里的主机。 */
  signIn(account: string, password: string): Promise<CloudSource[]>;
  /**
   * 把这台主机装成页面的本机源；失败抛（按 {@link hostedFailureOf} 显示）。
   * 登录时目录里的其余主机随后作为远程源挂进页面源表（同一个标签页同时挂多台）。
   */
  enter(source: Pick<CloudSource, "sourceId" | "name">): Promise<void>;
  /**
   * 按分享链接以访客加入（客户端包 §6.1，A4-3p）：匿名 `links.accept` → 访客的
   * 远程服务会话进保管处 → 经中继 `cloud/login` 带邀请令牌换源会话 → 同
   * {@link enter} 装成本机源。答加入的源。失败抛（远程服务的拒绝是 `CloudError`）。
   */
  join(link: {
    readonly linkId: string;
    readonly secret: string;
    readonly invitationToken: string;
  }): Promise<string>;
  readonly status: HostedStatus;
  subscribe(listener: () => void): () => void;
  /** 登出远程服务并丢掉内存里的全部凭据。 */
  signOut(): Promise<void>;
  dispose(): void;
}

export function createHostedRelay(options: HostedRelayOptions): HostedRelay {
  const { issuer } = options;
  const vault = createMemoryRelayVault();
  const cloudSessions = createCloudSessions({
    vault,
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
  });
  const relay = createRelayedAccess({
    vault,
    cloudSessions,
    device: () => browserDevice(),
    ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
  });
  const forced = new Set<string>();
  const cached = createCachedCredentialProvider(async (sourceId, via) => {
    if (via !== "relayed") throw new SourceError(SOURCE_ERROR.unreachable);
    return relay.access(issuer, sourceId, forced.delete(sourceId));
  });
  const provider: CredentialProvider = {
    getAccess: (sourceId, via) => cached.getAccess(sourceId, via),
    refresh(sourceId, via) {
      forced.add(sourceId);
      return cached.refresh(sourceId, via);
    },
    invalidate: (sourceId) => cached.invalidate(sourceId),
  };

  let status: HostedStatus = { state: "idle", lastError: null };
  const listeners = new Set<() => void>();
  const setStatus = (state: SourceState, lastError: SourceFailure | null) => {
    if (status.state === state && status.lastError?.code === lastError?.code)
      return;
    status = { state, lastError };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* 一个订阅者出错不拖垮别的。 */
      }
    }
  };

  let entered: EnteredRoute | null = null;
  let stream: RemoteStream | null = null;
  let current: string | null = null;
  /** 登录时远程服务答的目录（访客加入时只有那一台）。 */
  let directory: readonly CloudSource[] = [];
  let siblings: SiblingMount | null = null;
  /** 一起挂上的其余主机（源表里的远程源）。 */
  const siblingTargets = () =>
    siblings === null
      ? []
      : siblings.registry
          .list()
          .filter((connection) => connection.descriptor.kind !== "local");
  // 本机源（就是这台主机）上托管的流——控制面——在 4404 之后等着：叫醒它。
  const wake = options.wake ?? (() => void sourceRegistry().local().connect());

  /** `me.stream` 的事件落到当前这台主机上。 */
  const target: StreamTarget = {
    get status() {
      return status;
    },
    async connect() {
      // 主机回来了：隧道是新的，会话在 core 的库里还在；叫醒在退避里的流。
      setStatus("ready", null);
      wake();
    },
    revoke(failure) {
      provider.invalidate(current ?? "");
      setStatus("unauthorized", failure);
    },
  };

  /** 流（重）新打开：对一次目录，补上断开期间错过的上下线。 */
  const resync = async () => {
    if (current === null) return;
    try {
      const listed = await cloudSources(
        issuer,
        await cloudSessions.access(issuer),
        options.cloud,
      );
      const row = listed.find((item) => item.sourceId === current);
      if (row === undefined) {
        target.revoke({ code: SOURCE_ERROR.accessRevoked, message: "" });
        return;
      }
      // 在线：不论之前看到的是什么都叫醒一次——中继重启时它把经它的流以 4404
      // 收尾，而这条事件流断着，没收到过下线也就收不到上线。
      if (row.online && status.state !== "unauthorized") await target.connect();
      else if (!row.online && status.state === "ready")
        setStatus("waitingForSource", {
          code: SOURCE_ERROR.offline,
          message: "",
        });
    } catch {
      /* 目录取不到：等下一次事件。 */
    }
  };

  const startStream = () => {
    stream?.close();
    stream = (options.createStream ?? createRemoteStream)({
      issuer,
      auth: cloudSessions,
      ...(options.cloud === undefined ? {} : { cloud: options.cloud }),
      onEvent(event) {
        if (!("sourceId" in event)) return;
        if (event.sourceId !== current) {
          applyMeStreamEvent(event, siblings?.registry.get(event.sourceId));
          return;
        }
        if (event.type === "sourceOffline") {
          setStatus("waitingForSource", {
            code: SOURCE_ERROR.offline,
            message: "",
          });
          return;
        }
        applyMeStreamEvent(event, target);
      },
      onOpen: () => {
        void resync();
        resyncTargets(siblingTargets());
      },
    });
  };

  const hosted: HostedRelay = {
    issuer,
    provider,
    async join(link) {
      const accepted = await cloudAcceptLink(
        issuer,
        link.linkId,
        link.secret,
        browserDevice(),
        options.cloud,
      );
      const guest = accepted.guestSession;
      if (guest.refreshToken === undefined)
        throw new CloudError(502, "bad_response");
      await vault.saveCloudRefreshToken(issuer, guest.refreshToken);
      cloudSessions.adopt(issuer, guest.accessToken, guest.accessExpiresAtMs);
      const login = await coreCloudLogin(
        accepted.relayBaseUrl,
        accepted.relayToken,
        accepted.assertion,
        link.invitationToken,
        options.cloud,
      );
      await vault.saveSession(accepted.sourceId, issuer, {
        accessToken: login.native.accessToken,
        refreshToken: login.native.refreshToken,
        expiresAtMs: login.expiresAtUnixMs,
        ...(login.csrfToken === undefined
          ? {}
          : { csrfToken: login.csrfToken }),
      });
      // 名字是锦上添花：访客的目录里只有这一台，取不到就空着。
      const rows = await cloudSources(
        issuer,
        guest.accessToken,
        options.cloud,
      ).catch(() => [] as CloudSource[]);
      const name =
        rows.find((row) => row.sourceId === accepted.sourceId)?.name ?? "";
      // 访客只挂链接指向的这一台。
      directory = [];
      await hosted.enter({ sourceId: accepted.sourceId, name });
      return accepted.sourceId;
    },
    async signIn(account, password) {
      const session = await cloudLogin(
        issuer,
        account,
        password,
        browserDevice(),
        options.cloud,
      );
      if (session.refreshToken === undefined)
        throw new CloudError(502, "bad_response");
      await vault.saveCloudRefreshToken(issuer, session.refreshToken);
      cloudSessions.adopt(
        issuer,
        session.accessToken,
        session.accessExpiresAtMs,
      );
      directory = await cloudSources(
        issuer,
        session.accessToken,
        options.cloud,
      );
      return [...directory];
    },
    async enter(source) {
      const descriptor = relayedDescriptor(issuer, source);
      setStatus("connecting", null);
      const store: HostedSessionStore = {
        load: () => vault.session(source.sourceId),
        save: (session) =>
          void vault.saveSession(source.sourceId, issuer, session),
        clear: () => provider.invalidate(source.sourceId),
        recover: async () => {
          try {
            await provider.refresh(source.sourceId, "relayed");
            return true;
          } catch {
            return false;
          }
        },
      };
      try {
        entered = await (options.enter ?? enterRoute)({
          descriptor,
          provider,
          useRoute(route) {
            setHostedSession(store);
            setHostedRuntimeBase(route.access.httpBase);
          },
          restore: restoreHostedCredentials,
          onRenewed(access) {
            if (access !== null && status.state !== "ready")
              setStatus("ready", null);
          },
        });
      } catch (error) {
        const failure = {
          code:
            (error as { code?: unknown })?.code &&
            typeof (error as { code: unknown }).code === "string"
              ? (error as { code: string }).code
              : SOURCE_ERROR.unreachable,
          message: "",
        };
        setStatus(
          failure.code === SOURCE_ERROR.offline
            ? "waitingForSource"
            : "offline",
          failure,
        );
        throw error;
      }
      if (!(await restoreHostedCredentials())) {
        setStatus("unauthorized", {
          code: SOURCE_ERROR.unauthorized,
          message: "",
        });
        throw new SourceError(SOURCE_ERROR.unauthorized);
      }
      current = source.sourceId;
      setStatus("ready", null);
      siblings?.dispose();
      siblings = (options.mount ?? mountSiblingSources)({
        primary: descriptor,
        siblings: directory.map((row) => relayedDescriptor(issuer, row)),
        provider,
      });
      startStream();
    },
    get status() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async signOut() {
      const token = await cloudSessions.access(issuer).catch(() => null);
      if (token !== null) await cloudLogout(issuer, token, options.cloud);
      this.dispose();
    },
    dispose() {
      stream?.close();
      stream = null;
      siblings?.dispose();
      siblings = null;
      directory = [];
      entered?.dispose();
      entered = null;
      vault.clear();
      if (current !== null) provider.invalidate(current);
      current = null;
      setStatus("idle", null);
    },
  };
  return hosted;
}

/* ------------------------------- 页面那一个 ------------------------------- */

let active: HostedRelay | null = null;

/** 中继托管页面上的那一个（入口建，界面读状态）；别的页面是 `null`。 */
export function hostedRelay(): HostedRelay | null {
  return active;
}

export function startHostedRelay(host: RelayHost): HostedRelay {
  active?.dispose();
  active = createHostedRelay({ issuer: host.issuer });
  return active;
}

/** 测试换掉页面那一个。 */
export function resetHostedRelay(next: HostedRelay | null = null): void {
  active = next;
}
