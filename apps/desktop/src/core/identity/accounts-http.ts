import type { ProcedureInput, Contract } from "@armadra/shared";
import type {
  AuditFilter,
  GrantSubjectKind,
  GroupRole,
} from "./accounts-store";
import type { AccountsService } from "./accounts";
import type { AuthorizationSubject } from "./authorize";
import { IdentityError, IdentityRefusal } from "./errors";
import type { CoreRequest } from "../http/router";
import type { SecretBackend } from "../secrets";
import { Mfa } from "./mfa";
import { type RelyingParty, Passkeys, resolveRelyingParty } from "./passkey";
import { type BreachMode, checkBreach, enforcePasswordPolicy } from "./policy";
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
 * 做不到的按设计要求**返回 501 且形状一致**：开放注册。OAuth / OIDC 在
 * `oauth/`（契约 §18.5），自己挂更长的原样前缀。passkey、MFA、会话列表、锁定（契约 §18.1–§18.4）在本文件下半部分，
 * 由 {@link IdentitySecurity} 驱动；没有它时那几条路径按 404 回答。
 *
 * **一份实现，两条路**（契约 §42）：每条会话内的动作是一个操作
 * （{@link accountOperations}、{@link securityOperations}），旧路径的分发与
 * `accounts.*` / `security.*` procedure（`procedures.ts`）都调它。操作的入参是
 * 取值函数：旧路径在认人之后才解析体（迁移前的顺序，没登录的人拿不到字段级的
 * 400），procedure 交的是契约已经解析好的值。凭据换会话的那几条（登录、持邀请
 * 注册、重置链接）只在旧路径上。
 */

/** 契约里一条 procedure 的入参。 */
type In<P> = ProcedureInput<P>;
type AccountsContract = Contract["accounts"];
type SecurityContract = Contract["security"];

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
function notImplementedRefusal(feature: string): IdentityRefusal {
  const { status, body } = notImplemented(feature);
  const { code, message } = body as { code: string; message: string };
  return new IdentityRefusal("invalid", status, code, message);
}

const ok = (body: unknown): Answer => ({ status: 200, body });
const created = (body: unknown): Answer => ({ status: 201, body });

/**
 * 分发一条 `/api/identity/…` 请求；不是这个面的路径返回 `undefined`，由调用方
 * 继续它自己的 404。
 */
export function handleAccounts(
  action: string,
  request: CoreRequest,
  given: AccountsHttpContext,
): Answer | Promise<Answer> | undefined {
  const method = request.method.toUpperCase();
  const segments = action.split("/").filter((part) => part !== "");
  const head = segments[0] ?? "";
  const security = given.security;
  // 这一面每条要会话的写路由都经 `subject()` 认人：写方法在那里一并核对 CSRF，
  // 不再由各条路由自己记得。
  const write = method !== "GET" && method !== "HEAD";
  const context: AccountsHttpContext = {
    ...given,
    authenticate: (force) => given.authenticate(force ?? write),
  };
  const ops = accountOperations(context);
  switch (head) {
    case "principals":
      return principals(method, segments, request, ops);
    case "credentials":
      return credentials(method, segments, request, ops);
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
    case "password-reset":
      return security === undefined
        ? undefined
        : passwordReset(method, segments, request, context, security);
    case "invitations":
      return invitations(method, segments, request, ops);
    case "groups":
      return groups(method, segments, request, ops);
    case "grants":
      return grants(method, segments, request, ops);
    case "audit":
      return audit(method, segments, request, ops, context);
    default:
      return undefined;
  }
}

/* ======================= 账号、凭据、邀请、组、共享 ======================= */

/**
 * `accounts.*` 与 `security.audit.list` 的操作（契约 §42.3、§42.2）。每条第一件
 * 事是认人（{@link subject}），再取入参、交给 {@link AccountsService} 判定。
 */
export function accountOperations(context: AccountsHttpContext) {
  const accounts = context.accounts;
  return {
    principals: {
      list() {
        return { principals: accounts.listPrincipals(subject(context)) };
      },
      create(read: Read<In<AccountsContract["principals"]["create"]>>) {
        const actor = subject(context);
        const input = read();
        return accounts.createPrincipal(actor, {
          displayName: input.displayName,
          ...(input.kind === "service" ? { kind: "service" as const } : {}),
        });
      },
      disable(read: Read<In<AccountsContract["principals"]["disable"]>>) {
        const actor = subject(context);
        accounts.disablePrincipal(actor, read().principalId);
        return { disabled: true as const };
      },
      // 契约 §25：明文令牌只在这一次答出去，链接由签发人亲手交给对方。
      issuePasswordReset(
        read: Read<In<AccountsContract["principals"]["issuePasswordReset"]>>,
      ) {
        const actor = subject(context);
        const issued = accounts.issuePasswordReset(actor, read().principalId);
        return { token: issued.token, expiresAtMs: issued.expiresAtMs };
      },
    },
    credentials: {
      list(read: Read<In<AccountsContract["credentials"]["list"]>>) {
        const actor = subject(context);
        return {
          credentials: accounts.listCredentials(actor, read().principalId),
        };
      },
      /**
       * 设口令。入参先取（迁移前的顺序：`kind` 不是口令的答 501 不认人）；有
       * 加固时先认调用方再判口令——一个没登录的人不该靠策略错误码探出账号名。
       * 换了口令撤掉这个人的其它会话（L2）；发请求的这个会话留着。
       */
      setPassword(
        read: Read<In<AccountsContract["credentials"]["setPassword"]>>,
      ) {
        const input = read();
        const kind = input.kind ?? "password";
        if (kind !== "password") throw notImplementedRefusal(`${kind} 凭据`);
        const { principalId, password } = input;
        const set = () => {
          const principal = context.authenticate();
          return accounts.setPassword(
            subjectOf(principal),
            principalId,
            password,
            principal.sessionId,
          );
        };
        const security = context.security;
        if (security === undefined) return set();
        subject(context);
        const displayName = security.security.store.transaction(
          (tx) => tx.accounts.principal(principalId)?.displayName ?? "",
        );
        return checkedPassword(
          security,
          password,
          [displayName, principalId],
          set,
          principalId,
        );
      },
      revoke(read: Read<In<AccountsContract["credentials"]["revoke"]>>) {
        const actor = subject(context);
        accounts.revokeCredential(actor, read().credentialId);
        return { revoked: true as const };
      },
    },
    invitations: {
      list() {
        return { invitations: accounts.listInvitations(subject(context)) };
      },
      issue(read: Read<In<AccountsContract["invitations"]["issue"]>>) {
        const actor = subject(context);
        const input = read();
        return accounts.issueInvitation(actor, {
          role: input.role,
          targetGroupId: input.targetGroupId ?? undefined,
          targetWorkspaceId: input.targetWorkspaceId ?? undefined,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
          ...(input.maxUses === undefined || input.maxUses === null
            ? {}
            : { maxUses: input.maxUses }),
        });
      },
      revoke(read: Read<In<AccountsContract["invitations"]["revoke"]>>) {
        const actor = subject(context);
        accounts.revokeInvitation(actor, read().invitationId);
        return { revoked: true as const };
      },
      accept(read: Read<In<AccountsContract["invitations"]["accept"]>>) {
        const actor = subject(context);
        const input = read();
        return accounts.acceptInvitation(actor, {
          invitationId: input.invitationId,
          token: input.token,
        });
      },
    },
    groups: {
      list() {
        return { groups: accounts.listGroups(subject(context)) };
      },
      create(read: Read<In<AccountsContract["groups"]["create"]>>) {
        const actor = subject(context);
        return accounts.createGroup(actor, read().name);
      },
      rename(read: Read<In<AccountsContract["groups"]["rename"]>>) {
        const actor = subject(context);
        const { groupId, name } = read();
        accounts.renameGroup(actor, groupId, name);
        return { groupId, renamed: true as const };
      },
      remove(read: Read<In<AccountsContract["groups"]["remove"]>>) {
        const actor = subject(context);
        const { groupId } = read();
        accounts.deleteGroup(actor, groupId);
        return { groupId, deleted: true as const };
      },
      putMember(read: Read<In<AccountsContract["groups"]["putMember"]>>) {
        const actor = subject(context);
        const { groupId, principalId, role } = read();
        accounts.putGroupMember(
          actor,
          groupId,
          principalId,
          (role ?? "member") as GroupRole,
        );
        return { groupId, principalId };
      },
      removeMember(read: Read<In<AccountsContract["groups"]["removeMember"]>>) {
        const actor = subject(context);
        const { groupId, principalId } = read();
        accounts.removeGroupMember(actor, groupId, principalId);
        return { groupId, principalId, removed: true as const };
      },
    },
    grants: {
      list(read: Read<In<AccountsContract["grants"]["list"]>>) {
        const actor = subject(context);
        const { workspaceId } = read();
        return {
          workspaceId,
          grants: accounts.listGrants(actor, workspaceId).map(grantView),
          // 角色 → 权限的编译表，界面拿它画共享对话框里的那四个单选项。
          roles: [...SHARE_ROLES],
        };
      },
      put(read: Read<In<AccountsContract["grants"]["put"]>>) {
        const actor = subject(context);
        const input = read();
        return grantView(
          accounts.putGrant(actor, {
            workspaceId: input.workspaceId,
            subjectKind: input.subjectKind as GrantSubjectKind,
            subjectId: input.subjectId,
            role: input.role,
          }),
        );
      },
      revoke(read: Read<In<AccountsContract["grants"]["revoke"]>>) {
        const actor = subject(context);
        const input = read();
        accounts.revokeGrant(actor, {
          workspaceId: input.workspaceId,
          subjectKind: input.subjectKind as GrantSubjectKind,
          subjectId: input.subjectId,
        });
        return { revoked: true as const };
      },
    },
    audit: {
      /**
       * `GET audit`（契约 §18.6）。筛选先校（写错的数字一律 400，不悄悄当成
       * 「不筛」），再认人；多取一行，知道还有没有更早的。
       */
      list(read: Read<In<SecurityContract["audit"]["list"]>>) {
        const query = read() ?? {};
        const filter = auditFilterOf(query);
        const limit = pageLimit(query.limit);
        const rows = accounts.readAudit(subject(context), {
          ...filter,
          limit: limit + 1,
        });
        const entries = rows.slice(0, limit).map(auditEntry);
        return {
          entries,
          nextBeforeId:
            rows.length > limit ? (entries[entries.length - 1]?.id ?? 0) : 0,
        };
      },
    },
  };
}

export type AccountOperations = ReturnType<typeof accountOperations>;

/** 编译出来的权限是只读数组；线上就是一份普通的数组。 */
function grantView<T extends { readonly permissions: readonly string[] }>(
  view: T,
): Omit<T, "permissions"> & { permissions: string[] } {
  return { ...view, permissions: [...view.permissions] };
}

/** 审计一行的 `detail` 是写入时的 JSON；没有时 `null`。 */
function auditEntry<T extends { detail: unknown }>(
  row: T,
): Omit<T, "detail"> & { detail: JsonValue } {
  return { ...row, detail: (row.detail ?? null) as JsonValue };
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/* ----------------------------- 旧路径的分发 ------------------------------ */

function principals(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  ops: AccountOperations,
): Answer | undefined {
  if (segments.length === 1 && method === "GET") {
    return ok(ops.principals.list());
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    return created(
      ops.principals.create(() => ({
        displayName: text(body.displayName),
        ...(body.kind === "service" ? { kind: "service" } : {}),
      })),
    );
  }
  const principalId = segments[1] as string;
  if (segments.length === 3 && segments[2] === "disable" && method === "POST") {
    return ok(ops.principals.disable(() => ({ principalId })));
  }
  if (
    segments.length === 3 &&
    segments[2] === "password-reset" &&
    method === "POST"
  ) {
    return created(ops.principals.issuePasswordReset(() => ({ principalId })));
  }
  return undefined;
}

function credentials(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  ops: AccountOperations,
): Answer | Promise<Answer> | undefined {
  // passkey 与 OAuth 都有了自己的路由（`passkey/*` 契约 §18.2、`oauth/*`
  // 契约 §18.5），`credentials/{passkey,oauth}/*` 的旧占位路径不再存在。
  if (segments.length === 1 && method === "GET") {
    const principalId = request.query.get("principalId") ?? "";
    return ok(ops.credentials.list(() => ({ principalId })));
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    const kind = text(body.kind === undefined ? "password" : body.kind);
    if (kind !== "password") return notImplemented(`${kind} 凭据`);
    const input = {
      kind,
      principalId: text(body.principalId),
      password: text(body.password),
    };
    const answer = ops.credentials.setPassword(() => input);
    return answer instanceof Promise ? answer.then(created) : created(answer);
  }
  if (segments.length === 2 && method === "DELETE") {
    const credentialId = segments[1] as string;
    return ok(ops.credentials.revoke(() => ({ credentialId })));
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
    return created(registerChecked(body, token, password, context));
  }
  security.security.throttle.admitIp(security.remoteIp);
  return checkedPassword(security, password, [displayName], () =>
    registerChecked(body, token, password, context),
  ).then(created);
}

function registerChecked(
  body: Record<string, unknown>,
  token: string,
  password: string,
  context: AccountsHttpContext,
): Record<string, unknown> {
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
    ...session,
    invitation: {
      role: registered.role,
      groupId: registered.groupId,
      workspaceId: registered.workspaceId,
    },
  };
}

function invitations(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  ops: AccountOperations,
): Answer | undefined {
  if (segments.length === 1 && method === "GET") {
    return ok(ops.invitations.list());
  }
  if (segments.length === 1 && method === "POST") {
    const body = object(request);
    return created(
      ops.invitations.issue(() => ({
        role: body.role as string,
        targetGroupId: optional(body.targetGroupId),
        targetWorkspaceId: optional(body.targetWorkspaceId),
        ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
        ...(body.maxUses !== undefined && body.maxUses !== null
          ? { maxUses: body.maxUses as number }
          : {}),
      })),
    );
  }
  const invitationId = segments[1] as string;
  if (segments.length === 2 && method === "DELETE") {
    return ok(ops.invitations.revoke(() => ({ invitationId })));
  }
  if (segments.length === 3 && segments[2] === "accept" && method === "POST") {
    const body = object(request);
    return ok(
      ops.invitations.accept(() => ({
        invitationId,
        token: text(body.token),
      })),
    );
  }
  return undefined;
}

function groups(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  ops: AccountOperations,
): Answer | undefined {
  if (segments.length === 1 && method === "GET") {
    return ok(ops.groups.list());
  }
  if (segments.length === 1 && method === "POST") {
    return created(
      ops.groups.create(() => ({ name: text(object(request).name) })),
    );
  }
  const groupId = segments[1] ?? "";
  if (segments.length === 2 && method === "PATCH") {
    return ok(
      ops.groups.rename(() => ({ groupId, name: text(object(request).name) })),
    );
  }
  if (segments.length === 2 && method === "DELETE") {
    return ok(ops.groups.remove(() => ({ groupId })));
  }
  if (segments.length === 4 && segments[2] === "members") {
    const principalId = segments[3] as string;
    if (method === "PUT") {
      const role = object(request).role;
      return ok(
        ops.groups.putMember(() => ({
          groupId,
          principalId,
          ...(role === undefined ? {} : { role: text(role) }),
        })),
      );
    }
    if (method === "DELETE") {
      return ok(ops.groups.removeMember(() => ({ groupId, principalId })));
    }
  }
  return undefined;
}

function grants(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  ops: AccountOperations,
): Answer | undefined {
  if (segments.length !== 1) return undefined;
  if (method === "GET") {
    const workspaceId = request.query.get("workspaceId") ?? "";
    return ok(ops.grants.list(() => ({ workspaceId })));
  }
  if (method === "PUT") {
    const body = object(request);
    return ok(
      ops.grants.put(() => ({
        workspaceId: text(body.workspaceId),
        subjectKind: text(body.subjectKind),
        subjectId: text(body.subjectId),
        role: body.role as string,
      })),
    );
  }
  if (method === "DELETE") {
    const body = object(request);
    return ok(
      ops.grants.revoke(() => ({
        workspaceId: text(body.workspaceId),
        subjectKind: text(body.subjectKind),
        subjectId: text(body.subjectId),
      })),
    );
  }
  return undefined;
}

/* ================================ 审计查询 ================================ */

/**
 * `GET audit` 与 `GET audit/export`（契约 §18.6）。筛选参数两条一样；导出不
 * 分页，按 id 从新到旧最多 {@link AUDIT_EXPORT_MAX} 行。导出是 CSV 字节流，只在
 * 旧路径上（契约 §42.4）。
 */
function audit(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  ops: AccountOperations,
  context: AccountsHttpContext,
): Answer | undefined {
  if (method !== "GET") return undefined;
  if (segments.length === 1) {
    // 查询串在认人之前校（迁移前的顺序）。
    const query = auditQueryOf(request);
    auditFilterOf(query);
    return ok(ops.audit.list(() => query));
  }
  if (segments.length === 2 && segments[1] === "export") {
    return auditExport(request, context);
  }
  return undefined;
}

export const AUDIT_PAGE_MAX = 500;
export const AUDIT_EXPORT_MAX = 10_000;

/** 每页行数：缺省、不是整数或越界都取 100。 */
function pageLimit(raw: number | undefined): number {
  const limit = raw ?? 100;
  return Number.isInteger(limit) && limit > 0 && limit <= AUDIT_PAGE_MAX
    ? limit
    : 100;
}

type AuditQuery = NonNullable<In<SecurityContract["audit"]["list"]>>;

/** 查询串 → 与 procedure 同一个形状的筛选（数字原样转，校验在 {@link auditFilterOf}）。 */
function auditQueryOf(request: CoreRequest): AuditQuery {
  const query = request.query;
  const number = (name: string): number | undefined => {
    const raw = query.get(name);
    return raw === null || raw === "" ? undefined : Number(raw);
  };
  const limit = query.get("limit");
  return {
    ...(query.get("principalId")
      ? { principalId: query.get("principalId") as string }
      : {}),
    ...(query.get("workspaceId")
      ? { workspaceId: query.get("workspaceId") as string }
      : {}),
    action: query.getAll("action"),
    ...(number("sinceMs") === undefined ? {} : { sinceMs: number("sinceMs") }),
    ...(number("untilMs") === undefined ? {} : { untilMs: number("untilMs") }),
    ...(number("beforeId") === undefined
      ? {}
      : { beforeId: number("beforeId") }),
    ...(limit === null ? {} : { limit: Number(limit) }),
  };
}

/** 筛选。写错的数字一律 400，不悄悄当成「不筛」。 */
function auditFilterOf(query: AuditQuery): AuditFilter {
  const number = (
    value: number | undefined,
    min: number,
  ): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < min) {
      throw new IdentityError("invalid");
    }
    return value;
  };
  const actions = (query.action ?? []).filter((value) => value !== "");
  if (actions.length > 20 || actions.some((value) => value.length > 128)) {
    throw new IdentityError("invalid");
  }
  const sinceMs = number(query.sinceMs, 0);
  const untilMs = number(query.untilMs, 0);
  const beforeId = number(query.beforeId, 1);
  return {
    ...(query.principalId ? { principalId: query.principalId } : {}),
    ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
    ...(beforeId === undefined ? {} : { beforeId }),
  };
}

/** 审计导出（CSV）：与 `audit` 同一套筛选，校完筛选再认人，不分页。 */
function auditExport(
  request: CoreRequest,
  context: AccountsHttpContext,
): Answer {
  const filter = auditFilterOf(auditQueryOf(request));
  const rows = context.accounts.readAudit(subject(context), {
    ...filter,
    limit: AUDIT_EXPORT_MAX,
  });
  return {
    status: 200,
    body: null,
    text: {
      contentType: "text/csv; charset=utf-8",
      filename: "armadra-audit.csv",
      body: auditCsv(rows),
    },
  };
}

/**
 * RFC 4180 的 CSV，`\r\n` 换行，首行表头。以 `= + - @` 或制表、回车开头的
 * 单元格前面补一个 `'`：表格软件会把它们当公式执行（CSV 注入），而 `target`
 * 与 `detail` 里有用户写的名字。
 */
export function auditCsv(
  rows: readonly {
    id: number;
    atMs: number;
    principalId: string;
    deviceId: string;
    action: string;
    target: string;
    workspaceId: string;
    detail: unknown;
  }[],
): string {
  const cell = (value: string): string => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [
    "id,time,principalId,deviceId,action,target,workspaceId,detail",
  ];
  for (const row of rows) {
    lines.push(
      [
        String(row.id),
        new Date(row.atMs).toISOString(),
        row.principalId,
        row.deviceId,
        row.action,
        row.target,
        row.workspaceId,
        row.detail === null || row.detail === undefined
          ? ""
          : JSON.stringify(row.detail),
      ]
        .map(cell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** 调用方是谁。认证失败在这里抛，于是每条路由都不必自己写那个 401。 */
function subject(context: AccountsHttpContext): AuthorizationSubject {
  return subjectOf(context.authenticate());
}

function subjectOf(principal: Principal): AuthorizationSubject {
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
async function checkedPassword<T extends object>(
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

/* ------------------------- 会话内的加固操作（§42.2） ------------------------ */

/**
 * `security.*` 里本人与 owner 的那几条（passkey、两步验证、会话、锁定）。每条
 * 第一件事是认人（{@link me}：写操作在 Cookie 会话上核对 CSRF，`manage` 要
 * `identity:manage`），再取入参。
 */
export function securityOperations(context: SecurityHttpContext) {
  return {
    passkeys: {
      list: () => listPasskeys(context),
      registerOptions: (
        read: Read<In<SecurityContract["passkeys"]["registerOptions"]>>,
      ) => registerOptions(read, context),
      registerVerify: (
        read: Read<In<SecurityContract["passkeys"]["registerVerify"]>>,
      ) => registerVerify(read, context),
      rename: (read: Read<In<SecurityContract["passkeys"]["rename"]>>) =>
        renamePasskey(read, context),
      remove: (read: Read<In<SecurityContract["passkeys"]["remove"]>>) =>
        removePasskey(read, context),
    },
    mfa: {
      status() {
        const principal = me(context, false);
        const requireFor = context.security.settings().mfaRequireFor;
        return {
          ...context.security.mfa.status(principal.principalId),
          requireFor,
          required: mfaRequiredFor(principal.role, requireFor),
        };
      },
      enroll: () => mfaEnroll(context),
      confirm: (read: Read<In<SecurityContract["mfa"]["confirm"]>>) =>
        mfaConfirm(read, context),
      disable: (read: Read<In<SecurityContract["mfa"]["disable"]>>) =>
        mfaWithCode(read, context, "disable"),
      regenerateRecoveryCodes: (
        read: Read<In<SecurityContract["mfa"]["regenerateRecoveryCodes"]>>,
      ) => mfaWithCode(read, context, "regenerate"),
      reset: (read: Read<In<SecurityContract["mfa"]["reset"]>>) =>
        mfaReset(read, context),
    },
    sessions: {
      list(read: Read<In<SecurityContract["sessions"]["list"]>>) {
        const all = read()?.all === true;
        return { sessions: context.service.listSessions(context.actor, all) };
      },
      revoke(read: Read<In<SecurityContract["sessions"]["revoke"]>>) {
        const { sessionId } = read();
        context.service.revokeSessionById(
          { ...context.actor, requireCsrf: context.csrf !== false },
          sessionId,
        );
        return { sessionId, revoked: true as const };
      },
      revokeOthers() {
        const revoked = context.service.revokeOtherSessions({
          ...context.actor,
          requireCsrf: context.csrf !== false,
        });
        return { revoked };
      },
    },
    lockouts: {
      list() {
        me(context, false, true);
        return { lockouts: context.security.throttle.active() };
      },
      clear(read: Read<In<SecurityContract["lockouts"]["clear"]>>) {
        const principal = me(context, true, true);
        const { principalId: target } = read();
        if (!ID_PATTERN.test(target)) throw new IdentityError("invalid");
        const unlocked = context.security.throttle.unlock(principalKey(target));
        record(context.security.store, {
          action: "identity.lockout.clear",
          principalId: principal.principalId,
          deviceId: principal.deviceId,
          target,
        });
        return { principalId: target, unlocked };
      },
    },
  };
}

export type SecurityOperations = ReturnType<typeof securityOperations>;

/** 同步或异步的操作结果 → 旧路径的答案。 */
function answer<T>(
  value: T | Promise<T>,
  status = 200,
): Answer | Promise<Answer> {
  return value instanceof Promise
    ? value.then((body) => ({ status, body }))
    : { status, body: value };
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
  const ops = securityOperations(context).passkeys;
  const step = segments.slice(1).join("/");
  if (segments.length === 1 && method === "GET") return ok(ops.list());
  if (method === "POST" && step === "register/options") {
    return answer(
      ops.registerOptions(() => {
        const body = object(request);
        return body.label === undefined ? {} : { label: text(body.label) };
      }),
    );
  }
  if (method === "POST" && step === "register/verify") {
    return answer(
      ops.registerVerify(() => {
        const body = object(request);
        return {
          challengeId: text(body.challengeId),
          response: body.response as Record<string, never>,
          ...(body.label === undefined ? {} : { label: text(body.label) }),
        };
      }),
      201,
    );
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
  const credentialId = segments[1] as string;
  if (segments.length === 2 && method === "DELETE") {
    // 标识先校，再认人（迁移前的顺序）。
    if (!ID_PATTERN.test(credentialId)) throw new IdentityError("invalid");
    return ok(ops.remove(() => ({ credentialId })));
  }
  if (segments.length === 2 && method === "PATCH") {
    if (!ID_PATTERN.test(credentialId)) throw new IdentityError("invalid");
    return ok(
      ops.rename(() => ({
        credentialId,
        label: text(object(request).label),
      })),
    );
  }
  return undefined;
}

/** passkey 名字的上限（字符数，契约 §18.2 的 `PATCH`）。 */
export const PASSKEY_LABEL_MAX = 64;

/** 1–64 个字符、首尾无空白、无控制字符。 */
export function validPasskeyLabel(label: string): boolean {
  const length = [...label].length;
  return (
    length >= 1 &&
    length <= PASSKEY_LABEL_MAX &&
    label.trim() === label &&
    validName(label)
  );
}

/**
 * 改名：只有本人。别人的（哪怕调用方有 `identity:manage`）与不存在的同样答
 * 404——名字是本人给自己的钥匙起的，owner 要处理别人的钥匙只有删除。
 */
function renamePasskey(
  read: Read<In<SecurityContract["passkeys"]["rename"]>>,
  context: SecurityHttpContext,
) {
  const principal = me(context, true);
  const { credentialId, label } = read();
  if (!ID_PATTERN.test(credentialId)) throw new IdentityError("invalid");
  if (!validPasskeyLabel(label)) throw new IdentityError("invalid");
  context.security.store.transaction((tx) => {
    const row = tx.passkey(credentialId);
    if (
      row === undefined ||
      row.revokedAtMs !== 0 ||
      row.principalId !== principal.principalId ||
      !tx.renamePasskey(credentialId, label)
    ) {
      throw new IdentityError("notFound");
    }
  });
  record(context.security.store, {
    action: "identity.passkey.rename",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
    target: credentialId,
  });
  return { credentialId, label };
}

function listPasskeys(context: SecurityHttpContext) {
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
      transports: [...row.transports],
      createdAtMs: row.createdAtMs,
    }));
  return { ...availability, passkeys };
}

async function registerOptions(
  read: Read<In<SecurityContract["passkeys"]["registerOptions"]>>,
  context: SecurityHttpContext,
) {
  const principal = me(context, true);
  const label = read()?.label ?? "";
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
  // WebAuthn 的选项原样交给页面；过一遍 JSON，答出去的就是线上那一份。
  return {
    challengeId: value.challengeId,
    options: JSON.parse(JSON.stringify(value.options)) as Record<
      string,
      JsonValue
    >,
  };
}

async function registerVerify(
  read: Read<In<SecurityContract["passkeys"]["registerVerify"]>>,
  context: SecurityHttpContext,
) {
  const principal = me(context, true);
  const input = read();
  const challengeId = input.challengeId;
  const label = input.label;
  if (label !== undefined && label.length > 128) {
    throw new IdentityError("invalid");
  }
  const created = await context.security.passkeys.verifyRegistration({
    challengeId,
    principalId: principal.principalId,
    origin: context.origin,
    response: input.response,
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
    credentialId,
    label: created.label,
    aaguid: created.aaguid,
    transports: [...created.transports],
    createdAtMs,
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
  read: Read<In<SecurityContract["passkeys"]["remove"]>>,
  context: SecurityHttpContext,
) {
  const principal = me(context, true);
  const { credentialId } = read();
  if (!ID_PATTERN.test(credentialId)) throw new IdentityError("invalid");
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
  return { credentialId, removed: true as const };
}

/* ----------------------------------- MFA ---------------------------------- */

function mfa(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: SecurityHttpContext,
): Answer | Promise<Answer> | undefined {
  const ops = securityOperations(context).mfa;
  const step = segments.slice(1).join("/");
  if (segments.length === 1 && method === "GET") return ok(ops.status());
  if (method !== "POST") return undefined;
  const code = () => ({ code: text(object(request).code) });
  switch (step) {
    case "verify":
      return mfaVerify(request, context);
    case "totp/enroll":
      return answer(ops.enroll());
    case "totp/confirm":
      return answer(ops.confirm(code));
    case "disable":
      return answer(ops.disable(code));
    case "recovery-codes":
      return answer(ops.regenerateRecoveryCodes(code));
    case "reset":
      return answer(
        ops.reset(() => ({ principalId: text(object(request).principalId) })),
      );
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

async function mfaEnroll(context: SecurityHttpContext) {
  const principal = me(context, true);
  const label = context.security.store.transaction(
    (tx) =>
      tx.accounts.principal(principal.principalId)?.displayName ||
      principal.principalId,
  );
  const value = await context.security.mfa.begin(principal.principalId, label);
  return { secret: value.secret, otpauthUri: value.otpauthUri };
}

async function mfaConfirm(
  read: Read<In<SecurityContract["mfa"]["confirm"]>>,
  context: SecurityHttpContext,
) {
  const principal = me(context, true);
  const { code } = read();
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
  return { recoveryCodes: [...recoveryCodes] };
}

/**
 * 本人停用 MFA 或换一批恢复码：都要一个当前有效的码（TOTP 或恢复码）——偷到
 * 一个会话不等于能拆掉第二因素。码不对计入锁定。
 */
async function mfaWithCode(
  read: Read<{ code: string }>,
  context: SecurityHttpContext,
  action: "disable",
): Promise<{ disabled: true }>;
async function mfaWithCode(
  read: Read<{ code: string }>,
  context: SecurityHttpContext,
  action: "regenerate",
): Promise<{ recoveryCodes: string[] }>;
async function mfaWithCode(
  read: Read<{ code: string }>,
  context: SecurityHttpContext,
  action: "disable" | "regenerate",
): Promise<{ disabled: true } | { recoveryCodes: string[] }> {
  const principal = me(context, true);
  const { code } = read();
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
    return { disabled: true };
  }
  const recoveryCodes = factors.regenerateRecoveryCodes(principal.principalId);
  record(store, {
    action: "identity.mfa.recovery.regenerate",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
  });
  return { recoveryCodes: [...recoveryCodes] };
}

/** owner 替丢了手机的人重置 MFA（`identity:manage`）。 */
async function mfaReset(
  read: Read<In<SecurityContract["mfa"]["reset"]>>,
  context: SecurityHttpContext,
) {
  const principal = me(context, true, true);
  const { principalId: target } = read();
  if (!ID_PATTERN.test(target)) throw new IdentityError("invalid");
  const existed = await context.security.mfa.disable(target);
  record(context.security.store, {
    action: "identity.mfa.reset",
    principalId: principal.principalId,
    deviceId: principal.deviceId,
    target,
  });
  return { principalId: target, reset: existed };
}

/* ---------------------------------- 会话 ---------------------------------- */

function sessions(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: SecurityHttpContext,
): Answer | undefined {
  const ops = securityOperations(context).sessions;
  if (segments.length === 1 && method === "GET") {
    const all = request.query.get("all") === "1";
    return ok(ops.list(() => ({ all })));
  }
  if (segments.length === 2 && segments[1] === "revoke-others") {
    if (method !== "POST") return undefined;
    return ok(ops.revokeOthers());
  }
  if (segments.length === 2 && method === "DELETE") {
    const sessionId = segments[1] as string;
    return ok(ops.revoke(() => ({ sessionId })));
  }
  return undefined;
}

/* ------------------------------- 口令重置链接 ------------------------------- */

/**
 * `GET / POST password-reset/{token}`（契约 §25）：匿名，令牌本身就是凭据。
 * 只在旧路径上（契约 §42.4）。
 *
 * 两条都走配对与刷新那只「失败才扣」的 IP 桶（M4）：桶空了答 429，认不出的
 * 令牌扣一次。口令策略与泄露检查不扣——令牌对了，挡下来的是口令不是猜的人。
 * 设成功之后清掉这个人的登录锁定：锁定挡的是猜旧口令，新口令是签发人放行的。
 */
function passwordReset(
  method: string,
  segments: readonly string[],
  request: CoreRequest,
  context: AccountsHttpContext,
  security: SecurityHttpContext,
): Answer | Promise<Answer> | undefined {
  if (segments.length !== 2) return undefined;
  if (method !== "GET" && method !== "POST") return undefined;
  const token = segments[1] as string;
  const { throttle } = security.security;
  const charged = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof IdentityError) throttle.chargeIp(security.remoteIp);
      throw error;
    }
  };
  throttle.checkIp(security.remoteIp);
  const target = charged(() => context.accounts.inspectPasswordReset(token));
  if (method === "GET") {
    return {
      status: 200,
      body: {
        displayName: target.displayName,
        expiresAtMs: target.expiresAtMs,
      },
    };
  }
  const password = text(object(request).password);
  return checkedPassword(
    security,
    password,
    [target.displayName, target.principalId],
    () => {
      const done = charged(() =>
        context.accounts.completePasswordReset(token, password),
      );
      throttle.unlock(principalKey(done.principalId));
      return done;
    },
    target.principalId,
  ).then(ok);
}

/* ---------------------------------- 锁定 ---------------------------------- */

function lockouts(
  method: string,
  segments: readonly string[],
  context: SecurityHttpContext,
): Answer | undefined {
  const ops = securityOperations(context).lockouts;
  if (segments.length === 1 && method === "GET") return ok(ops.list());
  if (segments.length === 2 && method === "DELETE") {
    const principalId = segments[1] as string;
    return ok(ops.clear(() => ({ principalId })));
  }
  return undefined;
}
