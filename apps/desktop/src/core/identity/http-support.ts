import type { Contract, ProcedureInput } from "@armadra/shared";
import type { AccountsService } from "./accounts";
import type { AuthorizationSubject } from "./authorize";
import { IdentityError, IdentityRefusal } from "./errors";
import type { CoreRequest } from "../http/router";
import type { SecretBackend } from "../secrets";
import { Mfa } from "./mfa";
import { Passkeys } from "./passkey";
import { type BreachMode, checkBreach, enforcePasswordPolicy } from "./policy";
import { scope } from "./scopes";
import type {
  AccessRequest,
  IdentityService,
  LoginMethod,
  Principal,
  SessionCredentials,
} from "./service";
import type { IdentityStore } from "./store";
import { Throttle, principalKey } from "./throttle";
import { validName } from "./tokens";

/**
 * `/api/identity/` 账号与加固两面共用的那几样（契约 §10、§18、§42）：上下文的
 * 形状、认人（{@link subject}、{@link me}）、体的解析、加固审计、口令策略与
 * 泄露检查、失败计数与发会话。分发与操作在 `accounts-http.ts`（账号、凭据、
 * 邀请、组、共享、审计）与 `security-http.ts`（登录、passkey、MFA、会话、锁定、
 * 重置链接）。
 */

/** 契约里一条 procedure 的入参。 */
export type In<P> = ProcedureInput<P>;
export type AccountsContract = Contract["accounts"];
export type SecurityContract = Contract["security"];

/** 一条操作的入参：认完人才取（见文件头）。 */
export type Read<T> = () => T;

export interface Answer {
  readonly status: number;
  readonly body: unknown;
  /** 不是 JSON 的答案（审计导出的 CSV）；有它时 `body` 不用。 */
  readonly text?: {
    readonly contentType: string;
    readonly filename: string;
    readonly body: string;
  };
}

export interface AccountsHttpContext {
  readonly accounts: AccountsService;
  /**
   * 已认证的调用方；未认证时抛 `unauthenticated`。`write` 为真时在 Cookie 会话上
   * 还要核对 `X-Armadra-CSRF`（不对抛 `permission`）。
   */
  readonly authenticate: (write?: boolean) => Principal;
  /** 口令登录，落在同一张会话表上。 */
  readonly login: (input: {
    principalId: string;
    password: string;
    deviceName: string;
  }) => unknown;
  /** 加固那一半（契约 §18.1–§18.4）；没有时那几条路径 404。 */
  readonly security?: SecurityHttpContext;
}

/** `identity.*` 里加固要读的那几个设置，每次请求现读。 */
export interface SecuritySettings {
  readonly passwordMinLength: number;
  /** 空串 = 按公网来源推。 */
  readonly rpId: string;
  /** 配置的公网来源（`gateway.publicOrigin`）；空 = 用请求来源。 */
  readonly publicOrigins: readonly string[];
  readonly mfaRequireFor: "none" | "members" | "all";
  /**
   * 泄露检查落地之后的档位（`auto` 已由装配方解析）；缺省 `off`。
   */
  readonly breachCheck?: BreachMode;
  /** 范围接口的根；空 = HIBP 本身（`ARMADRA_HIBP_BASE` 给 fixture）。 */
  readonly breachBase?: string;
}

/** 加固的状态与依赖，一轮 core 一份（内存里的挑战表与 IP 桶在这里）。 */
export interface IdentitySecurity {
  readonly store: IdentityStore;
  readonly throttle: Throttle;
  readonly passkeys: Passkeys;
  readonly mfa: Mfa;
  readonly settings: () => SecuritySettings;
}

export function createIdentitySecurity(options: {
  readonly store: IdentityStore;
  readonly secrets: () => SecretBackend;
  readonly settings: () => SecuritySettings;
  readonly clock?: () => number;
}): IdentitySecurity {
  const clock = options.clock ?? (() => Date.now());
  return {
    store: options.store,
    throttle: new Throttle(options.store, clock),
    passkeys: new Passkeys(clock),
    mfa: new Mfa(options.store, options.secrets, clock),
    settings: options.settings,
  };
}

/** 一次请求里加固路由要的东西：状态、服务、调用方是谁、怎么发会话。 */
export interface SecurityHttpContext {
  readonly security: IdentitySecurity;
  readonly service: IdentityService;
  /** 这次请求的凭据（含 CSRF）；需要会话的路由拿它认证。 */
  readonly actor: AccessRequest;
  /**
   * 写操作要不要核对 CSRF：Cookie 会话要，Bearer（桌面壳原生传输、原生 App）
   * 不要（`identity/http.ts` 的 `csrfRequired`）。缺省要。
   */
  readonly csrf?: boolean;
  readonly hostId: string;
  readonly origin: string;
  readonly remoteIp: string;
  readonly userAgent: string;
  /** 把新会话写成响应体（并在浏览器会话上发 Cookie）。 */
  readonly issue: (credentials: SessionCredentials) => Record<string, unknown>;
}

/** 501 的统一形状：`{ code, message }`，和其余失败同一个信封。 */
export function notImplemented(feature: string): Answer {
  return {
    status: 501,
    body: {
      code: "NOT_IMPLEMENTED",
      message: `${feature} 尚未实现（服务器账号 R8）`,
    },
  };
}

/** 同一句 501，给操作抛出来（旧路径答出来的 JSON 与 {@link notImplemented} 一样）。 */
export function notImplementedRefusal(feature: string): IdentityRefusal {
  const { status, body } = notImplemented(feature);
  const { code, message } = body as { code: string; message: string };
  return new IdentityRefusal("invalid", status, code, message);
}

export const ok = (body: unknown): Answer => ({ status: 200, body });
export const created = (body: unknown): Answer => ({ status: 201, body });

/** 调用方是谁。认证失败在这里抛，于是每条路由都不必自己写那个 401。 */
export function subject(context: AccountsHttpContext): AuthorizationSubject {
  return subjectOf(context.authenticate());
}

export function subjectOf(principal: Principal): AuthorizationSubject {
  return {
    principalId: principal.principalId,
    kind: principal.role === "member" ? "member" : "owner",
    scopes: principal.scopes,
  };
}

export function object(request: CoreRequest): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = request.json();
  } catch {
    throw new IdentityError("invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdentityError("invalid");
  }
  return parsed as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new IdentityError("invalid");
  return value;
}

export function optional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value);
}

/* ================= 加固：口令策略、登录、passkey、MFA、会话、锁定 ================ */

/** 一条加固审计，写在自己的事务里（调用方此刻不在事务里）。 */
export function record(
  store: IdentityStore,
  entry: {
    readonly action: string;
    readonly principalId?: string;
    readonly deviceId?: string;
    readonly target?: string;
    readonly detail?: Record<string, unknown>;
  },
): void {
  try {
    store.transaction((tx) =>
      tx.accounts.appendAudit({
        atMs: Date.now(),
        principalId: entry.principalId ?? "",
        deviceId: entry.deviceId ?? "",
        action: entry.action,
        target: (entry.target ?? "").slice(0, 256),
        workspaceId: "",
        detailJson:
          entry.detail === undefined
            ? ""
            : JSON.stringify(entry.detail).slice(0, 8192),
      }),
    );
  } catch {
    // 审计不改变调用方的结果（同 `audit.ts`）。
  }
}

/** 已认证的调用方；写操作同时要 CSRF，`manage` 要 `identity:manage`。 */
export function me(
  context: SecurityHttpContext,
  write: boolean,
  manage = false,
): Principal {
  return context.service.authenticate({
    ...context.actor,
    requireCsrf: write && context.csrf !== false,
    ...(manage ? { requiredScopes: [scope("identity:manage")] } : {}),
  });
}

/** `identity.mfa.requireFor` 是否覆盖这个人。 */
export function mfaRequiredFor(
  role: string,
  requireFor: SecuritySettings["mfaRequireFor"],
): boolean {
  if (requireFor === "all") return true;
  if (requireFor === "members") return role !== "owner";
  return false;
}

/**
 * 口令策略 + 泄露检查，过了才做 `then`（契约 §18.1）。
 *
 * 泄露检查三档：`off` 不查；`warn` 命中照常设、答案多一个 `passwordBreached:
 * true` 并记审计；`block` 命中答 400 `password_breached`。查不成（离线、超时）
 * 只记一条 `identity.password.breach_check_failed`，不阻止设口令。审计里只有
 * 档位与结果，口令与哈希都不进去。
 */
export async function checkedPassword<T extends object>(
  context: SecurityHttpContext,
  password: string,
  names: readonly string[],
  then: () => T,
  target = "",
): Promise<T & { passwordBreached?: true }> {
  const settings = context.security.settings();
  enforcePasswordPolicy(password, {
    minLength: settings.passwordMinLength,
    names,
  });
  const mode = settings.breachCheck ?? "off";
  const verdict = await checkBreach(password, {
    mode,
    ...(settings.breachBase ? { base: settings.breachBase } : {}),
  });
  if (verdict === "unknown") {
    record(context.security.store, {
      action: "identity.password.breach_check_failed",
      target,
      detail: { mode, ip: context.remoteIp },
    });
  }
  if (verdict === "breached") {
    record(context.security.store, {
      action: "identity.password.breached",
      target,
      detail: { mode, ip: context.remoteIp },
    });
    if (mode === "block") {
      throw new IdentityRefusal(
        "invalid",
        400,
        "password_breached",
        "Password appears in a known breach corpus",
      );
    }
  }
  const answer = then();
  if (verdict !== "breached") return answer;
  return { ...answer, passwordBreached: true };
}

export function deviceNameOf(body: Record<string, unknown>): string {
  const name =
    body.deviceName === undefined ? "Armadra" : text(body.deviceName);
  if (!validName(name)) throw new IdentityError("invalid");
  return name;
}

/** 失败计一次；新上了锁时再记一条锁定审计。 */
export function failed(
  context: SecurityHttpContext,
  principalId: string,
  reason: string,
): void {
  const { throttle, store } = context.security;
  const outcome = throttle.failure(principalKey(principalId));
  record(store, {
    action: "identity.login.failed",
    principalId,
    detail: { reason, failures: outcome.failures, ip: context.remoteIp },
  });
  if (outcome.engaged) {
    record(store, {
      action: "identity.lockout",
      principalId,
      target: principalKey(principalId),
      detail: {
        failures: outcome.failures,
        lockedUntilMs: outcome.lockedUntilMs,
      },
    });
  }
}

export function issueSession(
  context: SecurityHttpContext,
  principalId: string,
  deviceName: string,
  method: LoginMethod,
): Record<string, unknown> {
  return context.issue(
    context.service.openSession({
      principalId,
      hostId: context.hostId,
      origin: context.origin,
      deviceName,
      method,
      remoteIp: context.remoteIp,
      userAgent: context.userAgent,
    }),
  );
}

/** 同步或异步的操作结果 → 旧路径的答案。 */
export function answer<T>(
  value: T | Promise<T>,
  status = 200,
): Answer | Promise<Answer> {
  return value instanceof Promise
    ? value.then((body) => ({ status, body }))
    : { status, body: value };
}

/** 一份纯 JSON（WebAuthn 的选项、审计的补充信息）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
