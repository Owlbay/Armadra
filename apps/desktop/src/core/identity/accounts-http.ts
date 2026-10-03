import type { GrantSubjectKind, GroupRole } from "./accounts-store";
import type { AccountsService } from "./accounts";
import type { AuthorizationSubject } from "./authorize";
import { IdentityError, IdentityRefusal } from "./errors";
import type { CoreRequest } from "../http/router";
import type { SecretBackend } from "../secrets";
import { Mfa } from "./mfa";
import { type RelyingParty, Passkeys, resolveRelyingParty } from "./passkey";
import { checkBreach, enforcePasswordPolicy } from "./policy";
import { SHARE_ROLES } from "./roles";
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
import { ID_PATTERN, newId, validName } from "./tokens";

/**
 * 账号 / 组 / 共享的 JSON 面，挂在身份域已有的 `/api/identity/` 前缀下。
 *
 * 形状照 `docs/design/server-accounts-and-sharing.md` §3，**路径有一处偏差**：
 * 设计把组写作 `/api/groups`、共享写作 `/api/workspaces/{id}/grants`、审计写作
 * `/api/audit`；这里全部落在 `/api/identity/` 下（`identity/groups`、
 * `identity/grants?workspaceId=`、`identity/audit`）。理由是 `/api/workspaces/*`
 * 属于那张与 Rust Runtime 逐条对账的路由表（`core/http/routes.ts`，契约到
 * R7），往里加一条 Rust 没有的路由就是让两边对不上；而身份域这个前缀本来就是
 * core 自己的面，加路径不影响任何对账。R6 的服务器壳要改成设计里的写法时，改
 * 的是这一个文件的分发表。
 *
 * 做不到的按设计要求**返回 501 且形状一致**：OAuth 绑定的 start / callback、开放
 * 注册。passkey、MFA、会话列表、锁定（契约 §18.1–§18.4）在本文件下半部分，
 * 由 {@link IdentitySecurity} 驱动；没有它时那几条路径按 404 回答。
 */

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export interface AccountsHttpContext {
  readonly accounts: AccountsService;
  /** 已认证的调用方；未认证时抛 `unauthenticated`。 */
  readonly authenticate: () => Principal;
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

/**
 * 分发一条 `/api/identity/…` 请求；不是这个面的路径返回 `undefined`，由调用方
 * 继续它自己的 404。
 */
export function handleAccounts(
  action: string,
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | Promise<Answer> | undefined {
  const method = request.method.toUpperCase();
  const segments = action.split("/").filter((part) => part !== "");
  const head = segments[0] ?? "";
  const security = context.security;
  switch (head) {
    case "principals":
      return principals(method, segments, request, context);
    case "credentials":
      return credentials(method, segments, request, context);
    case "login":
      if (method !== "POST") return undefined;
      return security === undefined
        ? login(method, request, context)
        : hardenedLogin(request, security);
    case "register":
      return method === "POST" ? register(request, context) : undefined;
    case "passkey":
      return security === undefined
        ? undefined
        : passkey(method, segments, request, security);
    case "mfa":
      return security === undefined
        ? undefined
        : mfa(method, segments, request, security);
    case "sessions":
      return security === undefined
        ? undefined
        : sessions(method, segments, request, security);
    case "lockouts":
      return security === undefined
        ? undefined
        : lockouts(method, segments, security);
    case "invitations":
      return invitations(method, segments, request, context);
    case "groups":
      return groups(method, segments, request, context);
    case "grants":
      return grants(method, segments, request, context);
    case "audit":
      return audit(method, request, context);
    default:
      return undefined;
  }
}

function principals(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  if (segments.length === 1 && method === "GET") {
    return {
      status: 200,
      body: { principals: accounts.listPrincipals(subject(context)) },
    };
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    return {
      status: 201,
      body: accounts.createPrincipal(subject(context), {
        displayName: text(body.displayName),
        ...(body.kind === "service" ? { kind: "service" as const } : {}),
      }),
    };
  }
  if (segments.length === 3 && segments[2] === "disable" && method === "POST") {
    accounts.disablePrincipal(subject(context), segments[1] as string);
    return { status: 200, body: { disabled: true } };
  }
  return undefined;
}

function credentials(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | Promise<Answer> | undefined {
  const accounts = context.accounts;
  // OAuth 的形状现在就在表里，答案是 501（G1-12 做实）。passkey 有自己的
  // `passkey/*` 路由（契约 §18.2），这里的旧占位路径不再存在。
  if (segments[1] === "oauth" && method === "POST") {
    return notImplemented(`OAuth 绑定 ${segments[2] ?? ""}`.trim());
  }
  if (segments.length === 1 && method === "GET") {
    const principalId = request.query.get("principalId") ?? "";
    return {
      status: 200,
      body: {
        credentials: accounts.listCredentials(subject(context), principalId),
      },
    };
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    const kind = text(body.kind === undefined ? "password" : body.kind);
    if (kind !== "password") return notImplemented(`${kind} 凭据`);
    const principalId = text(body.principalId);
    const password = text(body.password);
    const set = () => ({
      status: 201,
      body: accounts.setPassword(subject(context), principalId, password),
    });
    const security = context.security;
    if (security === undefined) return set();
    // 先认调用方再判口令：一个没登录的人不该靠策略错误码探出账号名。
    subject(context);
    const displayName = security.security.store.transaction(
      (tx) => tx.accounts.principal(principalId)?.displayName ?? "",
    );
    return checkedPassword(security, password, [displayName, principalId], set);
  }
  if (segments.length === 2 && method === "DELETE") {
    accounts.revokeCredential(subject(context), segments[1] as string);
    return { status: 200, body: { revoked: true } };
  }
  return undefined;
}

function login(
  method: string,
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  if (method !== "POST") return undefined;
  const body = object(request);
  return {
    status: 200,
    body: context.login({
      principalId: text(body.principalId),
      password: text(body.password),
      deviceName:
        body.deviceName === undefined ? "Armadra" : text(body.deviceName),
    }),
  };
}

/**
 * 注册。持邀请的那一半做实了：新来的人手里只有邀请链接，这一步替他建账号、
 * 兑换邀请、再照口令登录发会话。不带邀请的开放注册仍是 501——它要一个
 * `allowRegistration` 设置，而那是一个「谁都能进这台服务器」的决定，不该默认。
 */
function register(
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | Promise<Answer> {
  const body = object(request);
  if (body.token === undefined) {
    return notImplemented("开放注册（需要 allowRegistration 设置）");
  }
  const token = text(body.token);
  const password = text(body.password);
  const displayName = text(body.displayName);
  const security = context.security;
  if (security === undefined) {
    return registerChecked(body, token, password, context);
  }
  security.security.throttle.admitIp(security.remoteIp);
  return checkedPassword(security, password, [displayName], () =>
    registerChecked(body, token, password, context),
  );
}

function registerChecked(
  body: Record<string, unknown>,
  token: string,
  password: string,
  context: AccountsHttpContext,
): Answer {
  const registered = context.accounts.registerWithInvitation({
    invitationId: token.split(".")[0] ?? "",
    token,
    displayName: text(body.displayName),
    password,
  });
  const session = context.login({
    principalId: registered.principalId,
    password,
    deviceName:
      body.deviceName === undefined ? "Armadra" : text(body.deviceName),
  }) as Record<string, unknown>;
  return {
    status: 201,
    body: {
      ...session,
      invitation: {
        role: registered.role,
        groupId: registered.groupId,
        workspaceId: registered.workspaceId,
      },
    },
  };
}

function invitations(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  if (segments.length === 1 && method === "GET") {
    return {
      status: 200,
      body: { invitations: accounts.listInvitations(subject(context)) },
    };
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    return {
      status: 201,
      body: accounts.issueInvitation(subject(context), {
        role: body.role,
        targetGroupId: optional(body.targetGroupId),
        targetWorkspaceId: optional(body.targetWorkspaceId),
        ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
      }),
    };
  }
  if (segments.length === 2 && method === "DELETE") {
    accounts.revokeInvitation(subject(context), segments[1] as string);
    return { status: 200, body: { revoked: true } };
  }
  if (segments.length === 3 && segments[2] === "accept" && method === "POST") {
    const body = object(request);
    return {
      status: 200,
      body: accounts.acceptInvitation(subject(context), {
        invitationId: segments[1] as string,
        token: text(body.token),
      }),
    };
  }
  return undefined;
}

function groups(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  const accounts = context.accounts;
  if (segments.length === 1 && method === "GET") {
    return {
      status: 200,
      body: { groups: accounts.listGroups(subject(context)) },
    };
  }
  if (segments.length === 1 && method === "POST") {
    return {
      status: 201,
      body: accounts.createGroup(subject(context), text(object(request).name)),
    };
  }
  const groupId = segments[1] ?? "";
  if (segments.length === 2 && method === "PATCH") {
    accounts.renameGroup(subject(context), groupId, text(object(request).name));
    return { status: 200, body: { groupId, renamed: true } };
  }
  if (segments.length === 2 && method === "DELETE") {
    accounts.deleteGroup(subject(context), groupId);
    return { status: 200, body: { groupId, deleted: true } };
  }
  if (segments.length === 4 && segments[2] === "members") {
    const principalId = segments[3] as string;
    if (method === "PUT") {
      const role = object(request).role;
      accounts.putGroupMember(
        subject(context),
        groupId,
        principalId,
        (role === undefined ? "member" : text(role)) as GroupRole,
      );
      return { status: 200, body: { groupId, principalId } };
    }
    if (method === "DELETE") {
      accounts.removeGroupMember(subject(context), groupId, principalId);
      return { status: 200, body: { groupId, principalId, removed: true } };
    }
  }
  return undefined;
}

function grants(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  if (segments.length !== 1) return undefined;
  const accounts = context.accounts;
  if (method === "GET") {
    const workspaceId = request.query.get("workspaceId") ?? "";
    return {
      status: 200,
      body: {
        workspaceId,
        grants: accounts.listGrants(subject(context), workspaceId),
        // 角色 → 权限的编译表，界面拿它画共享对话框里的那四个单选项。
        roles: SHARE_ROLES,
      },
    };
  }
  if (method === "PUT") {
    const body = object(request);
    return {
      status: 200,
      body: accounts.putGrant(subject(context), {
        workspaceId: text(body.workspaceId),
        subjectKind: text(body.subjectKind) as GrantSubjectKind,
        subjectId: text(body.subjectId),
        role: body.role,
      }),
    };
  }
  if (method === "DELETE") {
    const body = object(request);
    accounts.revokeGrant(subject(context), {
      workspaceId: text(body.workspaceId),
      subjectKind: text(body.subjectKind) as GrantSubjectKind,
      subjectId: text(body.subjectId),
    });
    return { status: 200, body: { revoked: true } };
  }
  return undefined;
}

function audit(
  method: string,
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer | undefined {
  if (method !== "GET") return undefined;
  const limit = Number(request.query.get("limit") ?? 100);
  return {
    status: 200,
    body: {
      entries: context.accounts.readAudit(subject(context), {
        ...(request.query.get("principalId")
          ? { principalId: request.query.get("principalId") as string }
          : {}),
        ...(request.query.get("workspaceId")
          ? { workspaceId: request.query.get("workspaceId") as string }
          : {}),
        limit:
          Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100,
      }),
    },
  };
}

/** 调用方是谁。认证失败在这里抛，于是每条路由都不必自己写那个 401。 */
function subject(context: AccountsHttpContext): AuthorizationSubject {
  const principal = context.authenticate();
  return {
    principalId: principal.principalId,
    kind: principal.role === "member" ? "member" : "owner",
    scopes: principal.scopes,
  };
}

function object(request: CoreRequest): Record<string, unknown> {
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

function text(value: unknown): string {
  if (typeof value !== "string") throw new IdentityError("invalid");
  return value;
}

function optional(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value);
}

/* ================= 加固：口令策略、登录、passkey、MFA、会话、锁定 ================ */

/** 一条加固审计，写在自己的事务里（调用方此刻不在事务里）。 */
function record(
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
function me(
  context: SecurityHttpContext,
  write: boolean,
  manage = false,
): Principal {
  return context.service.authenticate({
    ...context.actor,
    requireCsrf: write,
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

/** 口令策略 + 泄露检查（调用点；G3-8 填实现），过了才做 `then`。 */
async function checkedPassword(
  context: SecurityHttpContext,
  password: string,
  names: readonly string[],
  then: () => Answer,
): Promise<Answer> {
  enforcePasswordPolicy(password, {
    minLength: context.security.settings().passwordMinLength,
    names,
  });
  const verdict = await checkBreach(password);
  if (verdict === "breached") {
    throw new IdentityRefusal(
      "invalid",
      400,
      "password_breached",
      "Password appears in a known breach corpus",
    );
  }
  return then();
}

function deviceNameOf(body: Record<string, unknown>): string {
  const name =
    body.deviceName === undefined ? "Armadra" : text(body.deviceName);
  if (!validName(name)) throw new IdentityError("invalid");
  return name;
}

/** 失败计一次；新上了锁时再记一条锁定审计。 */
function failed(
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

/**
 * 口令登录（契约 §18.1、§18.3）。顺序：来源 IP 的桶 → 这个账号锁着吗 → 核对
 * 口令（失败计数）→ 有已确认的 TOTP 就发一张中间票、不建会话 → 否则建会话。
 */
function hardenedLogin(
  request: CoreRequest,
  context: SecurityHttpContext,
): Answer {
  const body = object(request);
  const principalId = text(body.principalId);
  const password = text(body.password);
  const { throttle, mfa } = context.security;
  throttle.admitIp(context.remoteIp);
  const known = ID_PATTERN.test(principalId);
  if (known) {
    try {
      throttle.admitKey(principalKey(principalId));
    } catch (error) {
      record(context.security.store, {
        action: "identity.login.failed",
        principalId,
        detail: { reason: "locked", ip: context.remoteIp },
      });
      throw error;
    }
  }
  let verified: { principalId: string; kind: string };
  try {
    verified = context.service.verifyPassword({
      principalId,
      password,
      hostId: context.hostId,
      origin: context.origin,
    });
  } catch (error) {
    if (known && error instanceof IdentityError) {
      failed(context, principalId, "password");
    }
    throw error;
  }
  const deviceName = deviceNameOf(body);
  if (mfa.status(principalId).enrolled) {
    const ticket = mfa.beginLogin({
      principalId,
      origin: context.origin,
      deviceName,
      remoteIp: context.remoteIp,
      userAgent: context.userAgent,
    });
    return {
      status: 200,
      body: {
        mfaRequired: true,
        challengeId: ticket.challengeId,
        expiresAtMs: ticket.expiresAtMs,
        methods: ["totp", "recovery"],
      },
    };
  }
  throttle.success(principalKey(principalId));
  const issued = issueSession(context, principalId, deviceName, "password");
  const role = verified.kind === "owner" ? "owner" : "member";
  if (mfaRequiredFor(role, context.security.settings().mfaRequireFor)) {
    // 策略要求第二因素但还没登记：放进来，让页面先把人带去登记（G2-8）。
    issued.mfaEnrollmentRequired = true;
  }
  return { status: 200, body: issued };
}

function issueSession(
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

/* --------------------------------- passkey -------------------------------- */

function relyingParty(context: SecurityHttpContext): RelyingParty {
  const settings = context.security.settings();
  return resolveRelyingParty({
    requestOrigin: context.origin,
    override: settings.rpId,
    publicOrigins: settings.publicOrigins,
  });
}

function passkey(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: SecurityHttpContext,
): Answer | Promise<Answer> | undefined {
  const step = segments.slice(1).join("/");
  if (segments.length === 1 && method === "GET") return listPasskeys(context);
  if (method === "POST" && step === "register/options") {
    return registerOptions(request, context);
  }
  if (method === "POST" && step === "register/verify") {
    return registerVerify(request, context);
  }
  if (method === "POST" && step === "login/options") {
    context.security.throttle.admitIp(context.remoteIp);
    return context.security.passkeys
      .authenticationOptions(relyingParty(context))
      .then((value) => ({ status: 200, body: value }));
  }
  if (method === "POST" && step === "login/verify") {
    return passkeyLogin(request, context);
  }
  if (segments.length === 2 && method === "DELETE") {
    return removePasskey(segments[1] as string, context);
  }
  return undefined;
}

function listPasskeys(context: SecurityHttpContext): Answer {
  const principal = me(context, false);
  let availability: { available: boolean; rpId: string; reason: string };
  try {
    const rp = relyingParty(context);
    availability = { available: true, rpId: rp.rpId, reason: "" };
  } catch (error) {
    if (!(error instanceof IdentityRefusal)) throw error;
    availability = { available: false, rpId: "", reason: error.code };
  }
  const passkeys = context.security.store
    .transaction((tx) => tx.passkeysOf(principal.principalId))
    .map((row) => ({
      credentialId: row.credentialId,
      label: row.label,
      aaguid: row.aaguid,
      transports: row.transports,
      createdAtMs: row.createdAtMs,
    }));
  return { status: 200, body: { ...availability, passkeys } };
}

async function registerOptions(
  request: CoreRequest,
  context: SecurityHttpContext,
): Promise<Answer> {
  const principal = me(context, true);
  const body = object(request);
  const label = body.label === undefined ? "" : text(body.label);
  if (label.length > 128) throw new IdentityError("invalid");
  const rp = relyingParty(context);
  const { existing, userName } = context.security.store.transaction((tx) => ({
    existing: tx.passkeysOf(principal.principalId),
    userName:
      tx.accounts.principal(principal.principalId)?.displayName ||
      principal.principalId,
  }));
  const value = await context.security.passkeys.registrationOptions({
    rp,
    principalId: principal.principalId,
    userName,
    existing,
    label,
  });
  return { status: 200, body: value };
}

async function registerVerify(
  request: CoreRequest,
  context: SecurityHttpContext,
): Promise<Answer> {
  const principal = me(context, true);
  const body = object(request);
  const challengeId = text(body.challengeId);
  const label = body.label === undefined ? undefined : text(body.label);
  if (label !== undefined && label.length > 128) {
    throw new IdentityError("invalid");
  }
  const created = await context.security.passkeys.verifyRegistration({
    challengeId,
    principalId: principal.principalId,
    origin: context.origin,
    response: body.response,
    ...(label === undefined ? {} : { label }),
  });
  const credentialId = newId();
  const createdAtMs = Date.now();
  try {
    context.security.store.transaction((tx) =>
      tx.createPasskey({
        credentialId,
        principalId: principal.principalId,
        webauthnId: created.webauthnId,
        publicKey: created.publicKey,
        signCount: created.signCount,
        aaguid: created.aaguid,
        transports: created.transports,
        label: created.label,
        createdAtMs,
        revokedAtMs: 0,
      }),
    );
  } catch {
    // 唯一索引：这把钥匙已经登记过（`excludeCredentials` 本该挡住）。
    throw new IdentityError("conflict");
  }
  record(context.security.store, {
    action: "identity.passkey.add",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
    target: credentialId,
    detail: { aaguid: created.aaguid },
  });
  return {
    status: 201,
    body: {
      credentialId,
      label: created.label,
      aaguid: created.aaguid,
      transports: created.transports,
      createdAtMs,
    },
  };
}

async function passkeyLogin(
  request: CoreRequest,
  context: SecurityHttpContext,
): Promise<Answer> {
  context.security.throttle.admitIp(context.remoteIp);
  const body = object(request);
  const challengeId = text(body.challengeId);
  const deviceName = deviceNameOf(body);
  const { store, passkeys } = context.security;
  let outcome: Awaited<ReturnType<Passkeys["verifyAuthentication"]>>;
  try {
    outcome = await passkeys.verifyAuthentication({
      challengeId,
      origin: context.origin,
      response: body.response,
      lookup: (id) => store.transaction((tx) => tx.passkeyByWebauthnId(id)),
    });
  } catch (error) {
    record(store, {
      action: "identity.login.failed",
      detail: { reason: "passkey", ip: context.remoteIp },
    });
    throw error;
  }
  store.transaction((tx) =>
    tx.updatePasskeyCounter(outcome.row.credentialId, outcome.newCounter),
  );
  // passkey 视为已满足第二因素（架构 §8.3）。
  const issued = issueSession(
    context,
    outcome.row.principalId,
    deviceName,
    "passkey",
  );
  return { status: 200, body: issued };
}

function removePasskey(
  credentialId: string,
  context: SecurityHttpContext,
): Answer {
  if (!ID_PATTERN.test(credentialId)) throw new IdentityError("invalid");
  const principal = me(context, true);
  const manage = principal.scopes.some(
    (value) => value.Permission === "identity:manage",
  );
  const now = Date.now();
  const owner = context.security.store.transaction((tx) => {
    const row = tx.passkey(credentialId);
    if (
      row === undefined ||
      row.revokedAtMs !== 0 ||
      (row.principalId !== principal.principalId && !manage)
    ) {
      throw new IdentityError("notFound");
    }
    tx.accounts.revokeCredential(credentialId, now);
    return row.principalId;
  });
  record(context.security.store, {
    action: "identity.passkey.remove",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
    target: credentialId,
    detail: { owner },
  });
  return { status: 200, body: { credentialId, removed: true } };
}

/* ----------------------------------- MFA ---------------------------------- */

function mfa(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: SecurityHttpContext,
): Answer | Promise<Answer> | undefined {
  const step = segments.slice(1).join("/");
  if (segments.length === 1 && method === "GET") {
    const principal = me(context, false);
    const requireFor = context.security.settings().mfaRequireFor;
    return {
      status: 200,
      body: {
        ...context.security.mfa.status(principal.principalId),
        requireFor,
        required: mfaRequiredFor(principal.role, requireFor),
      },
    };
  }
  if (method !== "POST") return undefined;
  switch (step) {
    case "verify":
      return mfaVerify(request, context);
    case "totp/enroll":
      return mfaEnroll(context);
    case "totp/confirm":
      return mfaConfirm(request, context);
    case "disable":
      return mfaWithCode(request, context, "disable");
    case "recovery-codes":
      return mfaWithCode(request, context, "regenerate");
    case "reset":
      return mfaReset(request, context);
    default:
      return undefined;
  }
}

/** 两步登录的第二步：中间票 + 第二因素换会话。 */
async function mfaVerify(
  request: CoreRequest,
  context: SecurityHttpContext,
): Promise<Answer> {
  const { throttle, mfa: factors, store } = context.security;
  throttle.admitIp(context.remoteIp);
  const body = object(request);
  const challengeId = text(body.challengeId);
  const code = text(body.code);
  const ticket = factors.loginTicket(challengeId, context.origin);
  throttle.admitKey(principalKey(ticket.principalId));
  let factor: Awaited<ReturnType<Mfa["verify"]>>;
  try {
    factor = await factors.verify(ticket.principalId, code);
  } catch (error) {
    if (error instanceof IdentityRefusal && error.code === "mfa_invalid_code") {
      factors.failLogin(challengeId);
      failed(context, ticket.principalId, "mfa");
    }
    throw error;
  }
  factors.finishLogin(challengeId);
  throttle.success(principalKey(ticket.principalId));
  if (factor === "recovery") {
    record(store, {
      action: "identity.mfa.recovery.used",
      principalId: ticket.principalId,
    });
  }
  return {
    status: 200,
    body: issueSession(context, ticket.principalId, ticket.deviceName, factor),
  };
}

async function mfaEnroll(context: SecurityHttpContext): Promise<Answer> {
  const principal = me(context, true);
  const label = context.security.store.transaction(
    (tx) =>
      tx.accounts.principal(principal.principalId)?.displayName ||
      principal.principalId,
  );
  const value = await context.security.mfa.begin(principal.principalId, label);
  return { status: 200, body: value };
}

async function mfaConfirm(
  request: CoreRequest,
  context: SecurityHttpContext,
): Promise<Answer> {
  const principal = me(context, true);
  const code = text(object(request).code);
  const recoveryCodes = await context.security.mfa.confirm(
    principal.principalId,
    code,
  );
  record(context.security.store, {
    action: "identity.mfa.enroll",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
    detail: { method: "totp" },
  });
  return { status: 200, body: { recoveryCodes } };
}

/**
 * 本人停用 MFA 或换一批恢复码：都要一个当前有效的码（TOTP 或恢复码）——偷到
 * 一个会话不等于能拆掉第二因素。码不对计入锁定。
 */
async function mfaWithCode(
  request: CoreRequest,
  context: SecurityHttpContext,
  action: "disable" | "regenerate",
): Promise<Answer> {
  const principal = me(context, true);
  const code = text(object(request).code);
  const { throttle, mfa: factors, store } = context.security;
  const key = principalKey(principal.principalId);
  throttle.admitKey(key);
  try {
    await factors.verify(principal.principalId, code);
  } catch (error) {
    if (error instanceof IdentityRefusal && error.code === "mfa_invalid_code") {
      failed(context, principal.principalId, "mfa");
    }
    throw error;
  }
  throttle.success(key);
  if (action === "disable") {
    await factors.disable(principal.principalId);
    record(store, {
      action: "identity.mfa.disable",
      principalId: principal.principalId,
      deviceId: principal.deviceId,
    });
    return { status: 200, body: { disabled: true } };
  }
  const recoveryCodes = factors.regenerateRecoveryCodes(principal.principalId);
  record(store, {
    action: "identity.mfa.recovery.regenerate",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
  });
  return { status: 200, body: { recoveryCodes } };
}

/** owner 替丢了手机的人重置 MFA（`identity:manage`）。 */
async function mfaReset(
  request: CoreRequest,
  context: SecurityHttpContext,
): Promise<Answer> {
  const principal = me(context, true, true);
  const target = text(object(request).principalId);
  if (!ID_PATTERN.test(target)) throw new IdentityError("invalid");
  const existed = await context.security.mfa.disable(target);
  record(context.security.store, {
    action: "identity.mfa.reset",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
    target,
  });
  return { status: 200, body: { principalId: target, reset: existed } };
}

/* ---------------------------------- 会话 ---------------------------------- */

function sessions(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: SecurityHttpContext,
): Answer | undefined {
  if (segments.length === 1 && method === "GET") {
    const all = request.query.get("all") === "1";
    return {
      status: 200,
      body: { sessions: context.service.listSessions(context.actor, all) },
    };
  }
  if (segments.length === 2 && segments[1] === "revoke-others") {
    if (method !== "POST") return undefined;
    const revoked = context.service.revokeOtherSessions({
      ...context.actor,
      requireCsrf: true,
    });
    return { status: 200, body: { revoked } };
  }
  if (segments.length === 2 && method === "DELETE") {
    const sessionId = segments[1] as string;
    context.service.revokeSessionById(
      { ...context.actor, requireCsrf: true },
      sessionId,
    );
    return { status: 200, body: { sessionId, revoked: true } };
  }
  return undefined;
}

/* ---------------------------------- 锁定 ---------------------------------- */

function lockouts(
  method: string,
  segments: readonly string[],
  context: SecurityHttpContext,
): Answer | undefined {
  if (segments.length === 1 && method === "GET") {
    me(context, false, true);
    return {
      status: 200,
      body: { lockouts: context.security.throttle.active() },
    };
  }
  if (segments.length === 2 && method === "DELETE") {
    const principal = me(context, true, true);
    const target = segments[1] as string;
    if (!ID_PATTERN.test(target)) throw new IdentityError("invalid");
    const unlocked = context.security.throttle.unlock(principalKey(target));
    record(context.security.store, {
      action: "identity.lockout.clear",
      principalId: principal.principalId,
      deviceId: principal.deviceId,
      target,
    });
    return { status: 200, body: { principalId: target, unlocked } };
  }
  return undefined;
}
