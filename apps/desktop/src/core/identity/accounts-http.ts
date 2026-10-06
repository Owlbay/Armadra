import type {
  AuditFilter,
  GrantSubjectKind,
  GroupRole,
} from "./accounts-store";
import { IdentityError } from "./errors";
import type { CoreRequest } from "../http/router";
import { SHARE_ROLES } from "./roles";
import {
  type AccountsContract,
  type AccountsHttpContext,
  type Answer,
  type In,
  type JsonValue,
  type Read,
  type SecurityContract,
  checkedPassword,
  created,
  notImplemented,
  notImplementedRefusal,
  object,
  ok,
  optional,
  subject,
  subjectOf,
  text,
} from "./http-support";
import {
  hardenedLogin,
  lockouts,
  mfa,
  passkey,
  passwordReset,
  sessions,
} from "./security-http";

export {
  type AccountsHttpContext,
  type Answer,
  type IdentitySecurity,
  type Read,
  type SecurityHttpContext,
  type SecuritySettings,
  createIdentitySecurity,
  mfaRequiredFor,
  notImplemented,
} from "./http-support";
export {
  PASSKEY_LABEL_MAX,
  type SecurityOperations,
  securityOperations,
  validPasskeyLabel,
} from "./security-http";

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
 * `oauth/`（契约 §18.5），自己挂更长的原样前缀。passkey、MFA、会话列表、锁定（契约 §18.1–§18.4）在
 * `security-http.ts`，由 `IdentitySecurity` 驱动；没有它时那几条路径按 404 回答。
 *
 * **一份实现，两条路**（契约 §42）：每条会话内的动作是一个操作
 * （{@link accountOperations}、{@link securityOperations}），旧路径的分发与
 * `accounts.*` / `security.*` procedure（`procedures.ts`）都调它。操作的入参是
 * 取值函数：旧路径在认人之后才解析体（迁移前的顺序，没登录的人拿不到字段级的
 * 400），procedure 交的是契约已经解析好的值。凭据换会话的那几条（登录、持邀请
 * 注册、重置链接）只在旧路径上。
 */

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
