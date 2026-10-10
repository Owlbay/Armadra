import type { SystemHello } from "@armadra/shared";

/**
 * 多源连接层的类型（平台设计 §5.4、§17.6–§17.7；客户端包 §1.2）。
 *
 * 一个「源」是一台 core。本机源是页面所在的那台；别的源经直连（自托管
 * Gateway）或中继（个人中转 / SaaS）到达。形状与 core 的源表
 * （`GET /api/sources`，契约 §33）同名同义，页面只多一个运行时状态。
 */

export type SourceKind = "local" | "direct" | "relayed" | "hosted";

/** 这一次连接实际走的路。 */
export type Via = "local" | "direct" | "relayed";

/**
 * 一条到达方式（契约 §55）：直连 Gateway 或经某个中继。同一个源可以有几条；
 * `origin` 是直连的 Gateway 来源或中继来源。
 */
export interface SourceRoute {
  readonly via: "direct" | "relayed";
  readonly origin: string;
  /** relayed：经哪个远程服务；direct 是空串。 */
  readonly cloudIssuer: string;
  /** direct 的信任锚指纹；没有是空串。 */
  readonly fingerprint: string;
  readonly preferred: boolean;
  readonly lastOkAtMs: number;
}

export interface SourceDescriptor {
  /** 源的标识，等于那台 core `system.hello` 的 `sourceId`。本机是 `local`。 */
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly label: string;
  /**
   * 服务端报的名字（契约 §61）：清空改名时恢复成它。没有（旧 core、旧连接表）时
   * 不出现，界面按 `label` / 地址兜底。
   */
  readonly defaultLabel?: string;
  /** 直连地址（`https://host:port`）；没有是空串。 */
  readonly baseUrl: string;
  /** 中继来源；没有是空串。 */
  readonly relayOrigin: string;
  /** 远程服务的签发方；没有是空串。 */
  readonly cloudIssuer: string;
  /** 直连 Gateway 的信任锚指纹；没有是空串。 */
  readonly fingerprint: string;
  readonly orderIndex: number;
  /**
   * 全部的路（§55）。上面几个地址字段是首选路由的镜像；没有这一项（旧的
   * 描述）时由它们推出（`routing.ts::routesOf`）。
   */
  readonly routes?: readonly SourceRoute[];
}

export type SourceState =
  | "idle"
  | "connecting"
  | "ready"
  | "offline"
  | "unauthorized"
  | "waitingForSource";

export interface SourceFailure {
  readonly code: string;
  readonly message: string;
}

export interface SourceStatus {
  readonly state: SourceState;
  readonly via: Via | null;
  /** 进入这个状态的时刻（毫秒）。 */
  readonly since: number;
  readonly lastError: SourceFailure | null;
}

/** 连上之后 `system.hello` 的答案（契约 §34.2）。 */
export type HelloInfo = SystemHello;

/**
 * 发往一个源要用的东西：地址与凭据。来自 {@link CredentialProvider}——桌面与
 * 服务器壳的页面由本机 core 代为换票（`sources.session`，契约 §33），手机从
 * 钥匙串与远程服务取，云页面从云会话取。访问令牌只在内存里。
 */
export interface SourceAccess {
  readonly accessToken: string;
  /** 访问令牌到期的时刻（毫秒）；不知道是 0。 */
  readonly expiresAtMs: number;
  readonly httpBase: string;
  readonly wsBase: string;
  /** 经中继时的中继令牌：HTTP 头与 WS 子协议都带它。 */
  readonly relayToken?: string;
}

export interface CredentialProvider {
  /**
   * 取（或复用）这个源经这条路的访问；拿不到就抛。`origin` 指定同一类路里的
   * 哪一条（§55）；不给由凭据来源自己选。
   */
  getAccess(sourceId: string, via: Via, origin?: string): Promise<SourceAccess>;
  /** 手里那份被拒了：换一份新的（刷新令牌，必要时经远程服务重取断言）。 */
  refresh(sourceId: string, via: Via, origin?: string): Promise<SourceAccess>;
  /**
   * 不给 `origin` 时自己在几条中继里选（桌面：本机 core 并行要断言，§55）。
   * 为真时选路只问一次中继，不逐条试。
   */
  readonly selectsRelay?: boolean;
  /** 忘掉这个源在内存里的访问（断开、移除）。 */
  invalidate(sourceId: string): void;
}

/**
 * 远程服务的会话（`me.stream` 用）：按签发方取访问令牌。桌面经本机 core
 * （`sources.remoteSession`），手机与中继托管的页面在各自的保管处。
 */
export interface CloudAuth {
  access(issuer: string): Promise<string>;
  /** 手里那枚被拒了：丢掉缓存。 */
  invalidate(issuer: string): void;
}

/** 源层自己的失败码（界面按码取文案）。 */
export const SOURCE_ERROR = {
  /** 连上的不是源表里那台（`hello.sourceId` 不符）。 */
  mismatch: "source_mismatch",
  /** 直连与中继都不通。 */
  unreachable: "source_unreachable",
  /** 凭据被拒、续不上。 */
  unauthorized: "source_unauthorized",
  /** 中继答源不在线（4404 / 503 `source_offline`）。 */
  offline: "source_offline",
  /** 源被主人从远程服务撤销（`me.stream` 的 `sourceRevoked`、断言答 `source_revoked`）。 */
  revoked: "source_revoked",
  /** 这个账号对这个源的访问被收回（`accessRevoked`、断言答 `source_access_denied`）。 */
  accessRevoked: "source_access_denied",
} as const;

export class SourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceError";
    this.code = code;
  }
}

/** 任意失败 → `{ code, message }`；认不出码的落到 `fallback`。 */
export function failureOf(
  error: unknown,
  fallback: string = SOURCE_ERROR.unreachable,
): SourceFailure {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return {
      code: typeof code === "string" && code !== "" ? code : fallback,
      message: typeof message === "string" ? message : "",
    };
  }
  return { code: fallback, message: String(error ?? "") };
}
