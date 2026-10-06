import type { CoreRequest } from "../http/router";
import { IdentityError, IdentityRefusal } from "./errors";
import type { Mfa } from "./mfa";
import {
  type RelyingParty,
  type Passkeys,
  resolveRelyingParty,
} from "./passkey";
import { principalKey } from "./throttle";
import { ID_PATTERN, newId, validName } from "./tokens";
import {
  type AccountsHttpContext,
  type Answer,
  type In,
  type JsonValue,
  type Read,
  type SecurityContract,
  type SecurityHttpContext,
  answer,
  checkedPassword,
  deviceNameOf,
  failed,
  issueSession,
  me,
  mfaRequiredFor,
  object,
  ok,
  record,
  text,
} from "./http-support";

/**
 * 加固那一面（契约 §18.1–§18.4、§25、§42.2）：口令登录两步、passkey、MFA、
 * 会话列表、锁定与口令重置链接。会话内的动作是 {@link securityOperations}，旧
 * 路径的分发（本文件下半部分）与 `security.*` procedure（`procedures.ts`）都调
 * 它；登录、passkey 断言、第二因素与重置链接先于会话存在，只在旧路径上。
 */

/**
 * 口令登录（契约 §18.1、§18.3）。顺序：来源 IP 的桶 → 这个账号锁着吗 → 核对
 * 口令（失败计数）→ 有已确认的 TOTP 就发一张中间票、不建会话 → 否则建会话。
 */
export function hardenedLogin(
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

/* --------------------------------- passkey -------------------------------- */

function relyingParty(context: SecurityHttpContext): RelyingParty {
  const settings = context.security.settings();
  return resolveRelyingParty({
    requestOrigin: context.origin,
    override: settings.rpId,
    publicOrigins: settings.publicOrigins,
  });
}

export function passkey(
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

export function mfa(
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

export function sessions(
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
export function passwordReset(
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

export function lockouts(
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
