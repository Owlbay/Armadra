import { contractEntries, errorStatus } from "@armadra/shared";

import { CoreFailure } from "../http/errors";
import type { CoreRequest } from "../http/router";
import {
  type DomainHandlers,
  type RpcCall,
  registerProcedures,
} from "../http/rpc";
import type { CoreServer } from "../http/server";
import type { AccountsService } from "./accounts";
import {
  type AccountsHttpContext,
  type IdentitySecurity,
  type SecurityHttpContext,
  accountOperations,
  securityOperations,
} from "./accounts-http";
import { IdentityError, identityFailure } from "./errors";
import {
  type IdentityHttp,
  credential,
  csrfRequired,
  remoteAddress,
} from "./http";
import type { OAuthHttp } from "./oauth/http";
import { OAuthError } from "./oauth/providers";
import { scope } from "./scopes";
import type { AccessRequest, IdentityService, Principal } from "./service";

/**
 * 身份三域的 procedure（契约 §42）：`identity.session` / `identity.devices.*`、
 * `security.*`、`accounts.*`。
 *
 * 实现就是旧路径用的那几份操作（`accounts-http.ts` 的 `accountOperations` /
 * `securityOperations`、`http.ts` 的 `identityOperations`、OAuth 的提供方与
 * 绑定），这里只做两件事：
 *
 *   * **认人**：门（回环、Gateway、中继）已经认过这次请求的会话，请求身份里带着
 *     它（`RequestIdentity.session`）；操作按这条会话再认一次
 *     （`AccessRequest.verifiedSessionId`）——会话被撤、设备被撤、账号停用，下一
 *     次调用就失败，和旧路径每次认令牌是同一个效果。控制面上的调用没有令牌，
 *     这是唯一能认的办法。门不在（探针与开发命令起的裸 core）时按请求里的凭据
 *     认，与旧路径同一套：Cookie 会话上的写要 CSRF。
 *   * **拒绝换成注册表里的码**：身份域的大写码（`UNAUTHENTICATED`…）换成
 *     `unauthenticated` / `forbidden` / `bad_request` / `conflict` / `not_found`
 *     / `not_implemented`；§18 的具名码（口令策略、passkey、MFA、限流与锁定、
 *     OAuth）照旧是它们自己的码与状态；限流与锁定的等待秒数进
 *     `details.retryAfterSeconds`（旧路径是 `Retry-After` 头）。原话照旧。
 *
 * CSRF 只对 Cookie 会话：经门进来的 `/api/rpc/` 是 POST，Cookie 会话在门上已经
 * 核对过 `X-Armadra-CSRF`（`identity/loopback.ts`、`gateway/admission.ts`）；
 * Bearer 与控制面不核对，与旧路径一样。
 */

export interface IdentityProcedureDeps {
  readonly service: IdentityService;
  readonly accounts: AccountsService;
  readonly security: IdentitySecurity;
  readonly http: IdentityHttp;
  readonly oauth: OAuthHttp;
}

/** 旧路径不是 GET 的那些：没经门的调用按它决定要不要 CSRF。 */
const WRITES: ReadonlySet<string> = new Set(
  contractEntries()
    .filter(
      (entry) =>
        entry.meta.legacy !== undefined && entry.meta.legacy.method !== "GET",
    )
    .map((entry) => entry.name),
);

/** 身份域的大写码 → 注册表里的码（契约 §34.1）。 */
const REGISTERED: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: "unauthenticated",
  PERMISSION_DENIED: "forbidden",
  INVALID_ARGUMENT: "bad_request",
  CONFLICT: "conflict",
  NOT_FOUND: "not_found",
  NOT_IMPLEMENTED: "not_implemented",
  INTERNAL: "internal",
};

/** 身份域与 OAuth 的拒绝 → 门面认得的 `CoreFailure`；别的原样往上抛。 */
export function rpcFailure(error: unknown): unknown {
  if (error instanceof OAuthError) {
    return new CoreFailure(error.status, error.code, error.message);
  }
  if (error instanceof IdentityError) {
    const failure = identityFailure(error);
    const code = REGISTERED[failure.code] ?? failure.code;
    return new CoreFailure(
      errorStatus(code) ?? failure.status,
      code,
      failure.message,
      failure.retryAfterMs === undefined
        ? undefined
        : {
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(failure.retryAfterMs / 1000),
            ),
          },
    );
  }
  return error;
}

function single(request: CoreRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** 一次 procedure 调用的调用方：凭据、要不要 CSRF、来源与对端。 */
export interface RpcCaller {
  readonly actor: AccessRequest;
  readonly csrf: boolean;
  readonly hostId: string;
  readonly origin: string;
  readonly remoteIp: string;
  readonly userAgent: string;
}

export function rpcCaller(
  service: IdentityService,
  call: RpcCall,
  write: boolean,
): RpcCaller {
  const hostId = service.hostId();
  const request = call.request;
  const remoteIp = remoteAddress(request);
  const userAgent = (single(request, "user-agent") ?? "").slice(0, 256);
  const session = call.identity?.session;
  if (session !== undefined) {
    return {
      actor: {
        accessToken: "",
        verifiedSessionId: session.sessionId,
        hostId,
        origin: session.origin,
      },
      csrf: false,
      hostId,
      origin: session.origin,
      remoteIp,
      userAgent,
    };
  }
  const origin = single(request, "origin") ?? "";
  return {
    actor: {
      accessToken: credential(request, hostId, "access"),
      hostId,
      origin,
      csrfToken: single(request, "x-armadra-csrf") ?? "",
    },
    csrf: write && csrfRequired(request),
    hostId,
    origin,
    remoteIp,
    userAgent,
  };
}

function sessionOnly(): never {
  // procedure 不发会话：登录类的那几条只在旧路径上（契约 §42.4）。
  throw new IdentityError("invalid");
}

export function installIdentityProcedures(
  server: CoreServer,
  deps: IdentityProcedureDeps,
): void {
  const { service, accounts, security, http, oauth } = deps;

  /** 这次调用的两份上下文（与旧路径的分发用的是同一种）。 */
  const contexts = (name: string, call: RpcCall) => {
    const caller = rpcCaller(service, call, WRITES.has(name));
    const authenticate = (): Principal =>
      service.authenticate({ ...caller.actor, requireCsrf: caller.csrf });
    const secured: SecurityHttpContext = {
      security,
      service,
      actor: caller.actor,
      csrf: caller.csrf,
      hostId: caller.hostId,
      origin: caller.origin,
      remoteIp: caller.remoteIp,
      userAgent: caller.userAgent,
      issue: sessionOnly,
    };
    const account: AccountsHttpContext = {
      accounts,
      authenticate,
      login: sessionOnly,
      security: secured,
    };
    return { caller, authenticate, secured, account };
  };

  /** 一条 procedure：拿到上下文、跑操作、把身份域的拒绝换成注册表的码。 */
  const run =
    <I, O>(
      name: string,
      work: (input: I, scope: ReturnType<typeof contexts>) => O | Promise<O>,
    ) =>
    async (input: I, call: RpcCall): Promise<O> => {
      try {
        return await work(input, contexts(name, call));
      } catch (error) {
        throw rpcFailure(error);
      }
    };

  const identity = {
    session: run("identity.session", (_input: unknown, { caller }) =>
      http.operations(caller.actor, caller.csrf).session(),
    ),
    devices: {
      list: run(
        "identity.devices.list",
        (input: { afterId?: string; limit?: number } | undefined, { caller }) =>
          http.operations(caller.actor, caller.csrf).devices.list(() => input),
      ),
      revoke: run(
        "identity.devices.revoke",
        (input: { deviceId: string; expectedRevision: number }, { caller }) =>
          http
            .operations(caller.actor, caller.csrf)
            .devices.revoke(() => input),
      ),
    },
  };

  type Ops = ReturnType<typeof accountOperations>;
  type Sec = ReturnType<typeof securityOperations>;
  /** `accounts.<组>.<动词>` 与 `security.audit.list`：账号操作。 */
  const account =
    <G extends keyof Ops, V extends keyof Ops[G]>(
      domain: "accounts" | "security",
      group: G,
      verb: V,
    ) =>
    (input: unknown, call: RpcCall) =>
      run(`${domain}.${String(group)}.${String(verb)}`, (value, { account }) =>
        (
          accountOperations(account)[group][verb] as unknown as (
            read: () => unknown,
          ) => unknown
        )(() => value),
      )(input, call);
  /** `security.<组>.<动词>`：本人与 owner 的加固操作。 */
  const secure =
    <G extends keyof Sec, V extends keyof Sec[G]>(group: G, verb: V) =>
    (input: unknown, call: RpcCall) =>
      run(`security.${String(group)}.${String(verb)}`, (value, { secured }) =>
        (
          securityOperations(secured)[group][verb] as unknown as (
            read: () => unknown,
          ) => unknown
        )(() => value),
      )(input, call);

  /** 有 `identity:manage` 的调用方；不够就当不管这台服务器的人。 */
  const manager = (actor: AccessRequest): Principal | undefined => {
    try {
      return service.authenticate({
        ...actor,
        requiredScopes: [scope("identity:manage")],
      });
    } catch {
      return undefined;
    }
  };

  const securityHandlers = {
    passkeys: {
      list: secure("passkeys", "list"),
      registerOptions: secure("passkeys", "registerOptions"),
      registerVerify: secure("passkeys", "registerVerify"),
      rename: secure("passkeys", "rename"),
      remove: secure("passkeys", "remove"),
    },
    mfa: {
      status: secure("mfa", "status"),
      enroll: secure("mfa", "enroll"),
      confirm: secure("mfa", "confirm"),
      disable: secure("mfa", "disable"),
      regenerateRecoveryCodes: secure("mfa", "regenerateRecoveryCodes"),
      reset: secure("mfa", "reset"),
    },
    sessions: {
      list: secure("sessions", "list"),
      revoke: secure("sessions", "revoke"),
      revokeOthers: secure("sessions", "revokeOthers"),
    },
    lockouts: {
      list: secure("lockouts", "list"),
      clear: secure("lockouts", "clear"),
    },
    oauth: {
      providers: run(
        "security.oauth.providers",
        async (_input: unknown, { authenticate, caller }) => {
          // 先认人（procedure 要会话），再看够不够管理视图。
          authenticate();
          return oauth.providers(manager(caller.actor));
        },
      ),
      setSecret: run(
        "security.oauth.setSecret",
        (input: { providerId: string; clientSecret: string }, { caller }) =>
          oauth.setSecret(
            () =>
              service.authenticate({
                ...caller.actor,
                requireCsrf: caller.csrf,
                requiredScopes: [scope("identity:manage")],
              }),
            input.providerId,
            () => input.clientSecret,
          ),
      ),
      clearSecret: run(
        "security.oauth.clearSecret",
        (input: { providerId: string }, { caller }) =>
          oauth.clearSecret(
            () =>
              service.authenticate({
                ...caller.actor,
                requireCsrf: caller.csrf,
                requiredScopes: [scope("identity:manage")],
              }),
            input.providerId,
          ),
      ),
      bindings: run(
        "security.oauth.bindings",
        (_input: unknown, { authenticate }) => oauth.bindings(authenticate),
      ),
      unbind: run(
        "security.oauth.unbind",
        (input: { credentialId: string }, { authenticate }) =>
          oauth.unbind(authenticate, input.credentialId),
      ),
    },
    audit: { list: account("security", "audit", "list") },
  };

  const accountHandlers = {
    principals: {
      list: account("accounts", "principals", "list"),
      create: account("accounts", "principals", "create"),
      disable: account("accounts", "principals", "disable"),
      issuePasswordReset: account(
        "accounts",
        "principals",
        "issuePasswordReset",
      ),
    },
    credentials: {
      list: account("accounts", "credentials", "list"),
      setPassword: account("accounts", "credentials", "setPassword"),
      revoke: account("accounts", "credentials", "revoke"),
    },
    invitations: {
      list: account("accounts", "invitations", "list"),
      issue: account("accounts", "invitations", "issue"),
      revoke: account("accounts", "invitations", "revoke"),
      accept: account("accounts", "invitations", "accept"),
    },
    groups: {
      list: account("accounts", "groups", "list"),
      create: account("accounts", "groups", "create"),
      rename: account("accounts", "groups", "rename"),
      remove: account("accounts", "groups", "remove"),
      putMember: account("accounts", "groups", "putMember"),
      removeMember: account("accounts", "groups", "removeMember"),
    },
    grants: {
      list: account("accounts", "grants", "list"),
      put: account("accounts", "grants", "put"),
      revoke: account("accounts", "grants", "revoke"),
    },
  };

  // 形状与契约的对账在门面（出参校验）与对偶测试里；这里的实现树按名字对上。
  registerProcedures(
    server,
    "identity",
    identity as unknown as DomainHandlers<"identity">,
  );
  registerProcedures(
    server,
    "security",
    securityHandlers as unknown as DomainHandlers<"security">,
  );
  registerProcedures(
    server,
    "accounts",
    accountHandlers as unknown as DomainHandlers<"accounts">,
  );
}
