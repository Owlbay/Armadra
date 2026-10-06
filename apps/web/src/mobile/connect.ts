import {
  IdentityRequestError,
  IdentityTransportError,
  pairIdentity,
  pairWithGateway,
  takePairingTicket,
} from "../api/identity";
import { exchangePairingCode } from "../api/gateway";
import { saveRuntimeOrigin } from "../api/runtime-url";
import { parsePairingQr } from "../host/qr";
import { LOCAL_SOURCE_ID } from "../api/source";
import { openAfterJoin } from "../sources/join-intent";
import { SourceError } from "../sources/types";
import {
  CloudError,
  CloudTransportError,
  type CloudOptions,
  type CloudSession,
  type CloudSource,
  cloudAcceptLink,
  cloudAssertion,
  cloudLogin,
  cloudSources,
  coreCloudLogin,
  thisDevice,
} from "../sources/cloud-client";
import {
  loadConnections,
  removeConnection,
  setActiveConnection,
  upsertConnection,
} from "./connections";
import { serviceIdOf } from "./credentials";
import type { ConnectFailure } from "./ConnectScreen";
import { issuerOrigin, parseJoinLink } from "./join-link";
import { nativeBridge, type NativeBridge } from "./native-bridge";

/** 配对失败 → 连接页的原因。认不出的一律 `failed`。 */
export function failureOf(error: unknown): ConnectFailure {
  if (error instanceof IdentityTransportError) return "unreachable";
  if (error instanceof IdentityRequestError) {
    // 配对码换票的几种拒绝（契约 §24）。
    if (error.code === "pairing_code_invalid") return "codeInvalid";
    if (error.code === "pairing_code_disabled") return "codeDisabled";
    if (error.code === "origin_mismatch") return "codeOrigin";
    if (error.status === 429) return "rateLimited";
  }
  if (
    error instanceof IdentityRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 410)
  )
    return "expired";
  return "failed";
}

export interface NativeConnectDeps {
  readonly bridge: NativeBridge;
  readonly pair: typeof pairWithGateway;
  readonly save: (origin: string) => void;
  /**
   * 记进连接表并设为当前（局域网配对也是一个连接，键是 core 的 `hostId`；
   * 同一个源之后经个人中转挂上来会合并成一行）。
   */
  readonly record?: (connection: {
    readonly sourceId: string;
    readonly origin: string;
    readonly fingerprint: string;
  }) => void;
  /** 记下来源后重新加载：本机源的地址在一次加载里只算一次。 */
  readonly reload: () => void;
}

const nativeDeps = (): NativeConnectDeps => ({
  bridge: nativeBridge(),
  pair: pairWithGateway,
  save: saveRuntimeOrigin,
  record: recordDirectConnection,
  reload: () => globalThis.location.reload(),
});

export function recordDirectConnection(connection: {
  readonly sourceId: string;
  readonly origin: string;
  readonly fingerprint: string;
}): void {
  upsertConnection({
    sourceId: connection.sourceId,
    label: "",
    baseUrl: connection.origin,
    relayOrigin: "",
    cloudIssuer: "",
    fingerprint: connection.fingerprint,
  });
  setActiveConnection(connection.sourceId);
}

/** 配对答案里的源标识（core 的 `hostId`）；没有就不记连接表。 */
function hostIdOf(session: unknown): string {
  const hostId = (session as { hostId?: unknown } | null)?.hostId;
  return typeof hostId === "string" ? hostId : "";
}

/**
 * 原生 App：配对链接（网页链接或 `armadra://pair` 深链，契约 §17.3）→ 先把
 * 信任锚指纹交给原生钉扎 → 用票配对（凭据进钥匙串）→ 记下来源 → 重载。
 *
 * 指纹必须有：App 不装 CA，没有指纹就没有东西可钉，宁可不连。
 */
export async function connectNative(
  link: string,
  deps: NativeConnectDeps = nativeDeps(),
): Promise<ConnectFailure | null> {
  const scanned = parsePairingQr(link);
  if (scanned === null) return "invalid";
  if (scanned.fingerprint === "") return "noFingerprint";
  try {
    await deps.bridge.pin(scanned.origin, scanned.fingerprint);
  } catch {
    return "pin";
  }
  let session: unknown;
  try {
    session = await deps.pair(scanned.origin, scanned.ticket);
  } catch (error) {
    return failureOf(error);
  }
  const sourceId = hostIdOf(session);
  if (deps.record !== undefined && sourceId !== "")
    deps.record({
      sourceId,
      origin: scanned.origin,
      fingerprint: scanned.fingerprint,
    });
  deps.save(scanned.origin);
  deps.reload();
  return null;
}

/**
 * 手机浏览器：页面就是经这个 Gateway 打开的，票从 `#pair=` 来，这时才取走并
 * 从地址栏抹掉。会话是 Cookie，配对成功就能进画布。
 */
export async function connectWeb(
  ticket: string = takePairingTicket(),
  pair: typeof pairIdentity = pairIdentity,
): Promise<ConnectFailure | null> {
  if (ticket === "") return "expired";
  try {
    await pair(ticket);
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * 配对码（契约 §24）：8 位换出一张与 `#pair=` 相同的票，再照常配对。
 *
 *  - 手机浏览器：页面就是经这个 Gateway 打开的，会话是 Cookie。
 *  - 原生 App：只在已经记下（并钉过）一个 Gateway 来源时可用——App 不装 CA，
 *    没钉过信任锚就连不上，拿不到码换出来的指纹。换出的指纹照样再钉一次，
 *    锚变了（重置 CA）这一步就失败，不自动信任新证书。
 */
export async function connectWithCode(
  code: string,
  target:
    | { readonly mode: "web" }
    | { readonly mode: "native"; readonly origin: string },
  deps: {
    readonly exchange?: typeof exchangePairingCode;
    readonly pairWeb?: typeof pairIdentity;
    readonly native?: NativeConnectDeps;
  } = {},
): Promise<ConnectFailure | null> {
  const exchange = deps.exchange ?? exchangePairingCode;
  let payload: Awaited<ReturnType<typeof exchangePairingCode>>;
  try {
    payload =
      target.mode === "web"
        ? await exchange(code)
        : await exchange(code, target.origin);
  } catch (error) {
    return failureOf(error);
  }
  if (target.mode === "web") {
    try {
      await (deps.pairWeb ?? pairIdentity)(payload.ticket);
      return null;
    } catch (error) {
      return failureOf(error);
    }
  }
  const native = deps.native ?? nativeDeps();
  if (payload.origin !== target.origin) return "failed";
  try {
    await native.bridge.pin(payload.origin, payload.fingerprint);
  } catch {
    return "pin";
  }
  let session: unknown;
  try {
    session = await native.pair(payload.origin, payload.ticket);
  } catch (error) {
    return failureOf(error);
  }
  const sourceId = hostIdOf(session);
  if (native.record !== undefined && sourceId !== "")
    native.record({
      sourceId,
      origin: payload.origin,
      fingerprint: payload.fingerprint,
    });
  native.save(payload.origin);
  native.reload();
  return null;
}

/* ------------------------------- 个人中转 ------------------------------- */

/** 远程服务那几步的失败 → 连接页的原因。 */
export function cloudFailureOf(error: unknown): ConnectFailure {
  if (error instanceof CloudTransportError) return "unreachable";
  if (error instanceof CloudError) {
    switch (error.code) {
      case "credentials_invalid":
        return "credentials";
      case "account_locked":
        return "locked";
      case "rate_limited":
        return "rateLimited";
      case "link_invalid":
        return "linkInvalid";
      case "link_expired":
        return "linkExpired";
      case "link_exhausted":
        return "linkExhausted";
      case "link_secret_invalid":
        return "linkSecret";
      case "invitation_invalid":
        return "invitation";
      case "source_offline":
        return "offline";
      default:
        return "failed";
    }
  }
  if (error instanceof SourceError && error.code === "source_offline")
    return "offline";
  return failureOf(error);
}

/** 能挂的源：连接页列成勾选项。 */
export interface RelaySourceChoice {
  readonly sourceId: string;
  readonly name: string;
  readonly online: boolean;
}

/** 个人中转那几步的结果；界面按 `kind` 切到下一步。 */
export type RelayOutcome =
  | { readonly kind: "fingerprint"; readonly fingerprint: string }
  | { readonly kind: "sources"; readonly sources: readonly RelaySourceChoice[] }
  | { readonly kind: "done" }
  | { readonly kind: "failure"; readonly failure: ConnectFailure };

const failed = (failure: ConnectFailure): RelayOutcome => ({
  kind: "failure",
  failure,
});

export interface RelayDeps {
  readonly bridge: NativeBridge;
  readonly cloud?: CloudOptions;
  /** 挂好之后重新加载：本机源的地址在一次加载里只算一次。 */
  readonly reload: () => void;
}

/** 个人中转的添加：地址 + 账号 + 口令，或一枚分享链接。 */
export interface RelayEnrollment {
  /** 账号登录：先核对信任锚指纹（需要时），再登录、列出能挂的源。 */
  begin(input: {
    readonly issuer: string;
    readonly account: string;
    readonly password: string;
  }): Promise<RelayOutcome>;
  /** 分享链接 / 二维码：直接挂载（指纹见过的不再问）。 */
  join(link: string): Promise<RelayOutcome>;
  /** 人确认了指纹：钉住，接着刚才的步骤。 */
  trust(): Promise<RelayOutcome>;
  /** 勾选的源逐个挂载。 */
  mount(sourceIds: readonly string[]): Promise<RelayOutcome>;
  /** 放弃：口令与会话不再留在内存里。 */
  reset(): void;
}

/**
 * 一次添加的状态机。口令只在 `begin` 到登录完成之间留在内存里，云会话（访问令牌
 * 与刷新令牌）只到 `mount` 为止；之后凭据只在钥匙串里。
 */
export function createRelayEnrollment(
  deps: RelayDeps = {
    bridge: nativeBridge(),
    reload: () => globalThis.location.reload(),
  },
): RelayEnrollment {
  let issuer = "";
  let fingerprint = "";
  let resume: (() => Promise<RelayOutcome>) | null = null;
  let session: CloudSession | null = null;
  let choices: readonly CloudSource[] = [];

  const reset = () => {
    issuer = "";
    fingerprint = "";
    resume = null;
    session = null;
    choices = [];
  };

  /**
   * 钉扎在登录之前：自签的中继在钉住之前连 TLS 都过不了。系统本来就信的（ACME）
   * 与已经钉过同一枚的直接过；其余要人核对指纹。网页里没有原生的 TLS 钉扎，
   * 交给浏览器。
   */
  const gate = async (
    origin: string,
    next: () => Promise<RelayOutcome>,
  ): Promise<RelayOutcome> => {
    issuer = origin;
    if (!deps.bridge.available || !origin.startsWith("https:")) return next();
    const peeked = await deps.bridge.peek(origin);
    if (peeked === null) return failed("unreachable");
    if (peeked.trusted || peeked.pinned) {
      fingerprint = peeked.pinned ? peeked.fingerprint : "";
      return next();
    }
    fingerprint = peeked.fingerprint;
    resume = next;
    return { kind: "fingerprint", fingerprint: peeked.fingerprint };
  };

  const signIn = async (
    account: string,
    password: string,
  ): Promise<RelayOutcome> => {
    try {
      session = await cloudLogin(
        issuer,
        account,
        password,
        thisDevice(),
        deps.cloud,
      );
      choices = await cloudSources(issuer, session.accessToken, deps.cloud);
    } catch (error) {
      session = null;
      return failed(cloudFailureOf(error));
    }
    if (choices.length === 0) return failed("noSources");
    return {
      kind: "sources",
      sources: choices.map(({ sourceId, name, online }) => ({
        sourceId,
        name,
        online,
      })),
    };
  };

  const remember = async (refreshToken: string | undefined) => {
    if (refreshToken === undefined) throw new CloudError(502, "bad_response");
    await deps.bridge.setRemote({
      serviceId: serviceIdOf(issuer),
      issuer,
      kind: "personal",
      refreshToken,
      fingerprint,
    });
  };

  const connectionOf = (sourceId: string, label: string) => {
    upsertConnection({
      sourceId,
      label,
      baseUrl: "",
      relayOrigin: issuer,
      cloudIssuer: issuer,
      fingerprint: "",
    });
  };

  return {
    reset,
    async begin(input) {
      const origin = issuerOrigin(input.issuer);
      if (origin === null) return failed("address");
      const { account, password } = input;
      return gate(origin, () => signIn(account, password));
    },
    async join(link) {
      const parsed = parseJoinLink(link);
      if (parsed === null) return failed("invalid");
      return gate(parsed.issuer, async () => {
        try {
          const device = thisDevice();
          const accepted = await cloudAcceptLink(
            issuer,
            parsed.linkId,
            parsed.secret,
            device,
            deps.cloud,
          );
          const login = await coreCloudLogin(
            accepted.relayBaseUrl,
            accepted.relayToken,
            accepted.assertion,
            parsed.invitationToken,
            deps.cloud,
          );
          await remember(accepted.guestSession.refreshToken);
          await deps.bridge.setSession({
            sourceId: accepted.sourceId,
            origin: issuer,
            via: "relayed",
            accessToken: login.native.accessToken,
            refreshToken: login.native.refreshToken,
            expiresAtMs: login.expiresAtUnixMs,
          });
          // 名字是锦上添花：目录取不到就用空标签，界面按地址兜底。
          const name = await cloudSources(
            issuer,
            accepted.guestSession.accessToken,
            deps.cloud,
          )
            .then(
              (list) =>
                list.find((item) => item.sourceId === accepted.sourceId)
                  ?.name ?? "",
            )
            .catch(() => "");
          connectionOf(accepted.sourceId, name);
          setActiveConnection(accepted.sourceId);
          // 重载进画布后打开链接指向的工作空间（本机源此时就是这条连接）。
          openAfterJoin(LOCAL_SOURCE_ID);
        } catch (error) {
          return failed(cloudFailureOf(error));
        }
        reset();
        deps.reload();
        return { kind: "done" };
      });
    },
    async trust() {
      const next = resume;
      if (next === null || !/^[0-9a-f]{64}$/.test(fingerprint))
        return failed("failed");
      try {
        await deps.bridge.pin(issuer, fingerprint);
      } catch {
        // 钉的时候对端出示的不是人刚核对过的那一张。
        return failed("fingerprint");
      }
      resume = null;
      return next();
    },
    async mount(sourceIds) {
      const current = session;
      if (current === null) return failed("failed");
      const device = thisDevice();
      let mounted: string | null = null;
      let failure: ConnectFailure = "offline";
      for (const sourceId of sourceIds) {
        const choice = choices.find((item) => item.sourceId === sourceId);
        if (choice === undefined) continue;
        try {
          const assertion = await cloudAssertion(
            issuer,
            current.accessToken,
            sourceId,
            device,
            deps.cloud,
          );
          if (!assertion.online) continue;
          const login = await coreCloudLogin(
            assertion.relayBaseUrl,
            assertion.relayToken,
            assertion.assertion,
            undefined,
            deps.cloud,
          );
          await deps.bridge.setSession({
            sourceId,
            origin: issuer,
            via: "relayed",
            accessToken: login.native.accessToken,
            refreshToken: login.native.refreshToken,
            expiresAtMs: login.expiresAtUnixMs,
          });
          connectionOf(sourceId, choice.name);
          mounted ??= sourceId;
        } catch (error) {
          failure = cloudFailureOf(error);
        }
      }
      if (mounted === null) return failed(failure);
      try {
        await remember(current.refreshToken);
      } catch (error) {
        return failed(cloudFailureOf(error));
      }
      setActiveConnection(mounted);
      reset();
      deps.reload();
      return { kind: "done" };
    },
  };
}

/** 点一个连接：记为当前并重新加载（本机源的地址在一次加载里只算一次）。 */
export function openConnection(
  sourceId: string,
  reload: () => void = () => globalThis.location.reload(),
): void {
  setActiveConnection(sourceId);
  reload();
}

/**
 * 移除一个连接：它的会话从钥匙串删掉；远程服务的登录没有别的连接在用了才一并
 * 删。其余连接与它们的凭据不动。
 */
export async function forgetConnection(
  sourceId: string,
  bridge: NativeBridge = nativeBridge(),
): Promise<void> {
  const row = loadConnections().find((item) => item.sourceId === sourceId);
  await bridge.removeSession(sourceId);
  removeConnection(sourceId);
  if (row === undefined || row.cloudIssuer === "") return;
  const stillUsed = loadConnections().some(
    (item) => item.cloudIssuer === row.cloudIssuer,
  );
  if (!stillUsed) await bridge.removeRemote(serviceIdOf(row.cloudIssuer));
}
