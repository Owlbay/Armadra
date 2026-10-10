import type {
  AccountsTx,
  GrantSubjectKind,
  InvitationRow,
} from "./accounts-store";
import { type AuthorizationSubject, compileGrants } from "./authorize";
import { IdentityError } from "./errors";
import { accessChanged } from "./gate";
import { type GrantTargetKind, HOST_WORKSPACE, type ShareRole } from "./roles";
import { permits, scope } from "./scopes";
import type { IdentityStore, IdentityTx } from "./store";
import { ID_PATTERN, newId, validIdentifier, validName } from "./tokens";

/**
 * 授予的来源、租约与目标（契约 §60）：云登录按断言同步授予、续租，撤链接停用访客，
 * SaaS 免邀请建成员；以及 {@link AccountsService} 也用的「放一条授予」。从
 * `accounts.ts` 拆出来，判定仍走同一条 `permits`（设计 S3）。
 */

/** 授予的租约（契约 §60）：经云登录来的授予缺省活 30 天，每次登录续。 */
export const GRANT_LEASE_MS = 30 * 24 * 60 * 60 * 1000;

/** 云登录要同步的一条授予（契约 §60）：断言的 `role` / `scp` 编译出来的目标。 */
export interface AssertedGrant {
  readonly targetKind: GrantTargetKind;
  /** 整台时为空串。 */
  readonly workspaceId: string;
  /** 会话 id；其余为空串。 */
  readonly targetId: string;
  readonly role: ShareRole;
}

/** 经云登录兑换邀请、同步授予时，授予记成哪个来源、租到什么时候、要不要压成只读。 */
export interface GrantProvenance {
  readonly origin: string;
  readonly leaseUntilMs: number;
  /** 断言带 `ro`：兑换出的授予压到 viewer。 */
  readonly readOnly?: boolean;
}

/**
 * 授予或改角色、续租：同一目标同一角色同一来源原地续租，否则撤旧立新——一个主体对
 * 一个目标永远只有一条有效授予。调用方已在事务里。
 */
export function putGrantRow(
  accounts: AccountsTx,
  input: {
    subjectKind: GrantSubjectKind;
    subjectId: string;
    workspaceId: string;
    role: ShareRole;
    grantedBy: string;
    nowMs: number;
    /** 契约 §60 的四列；不给就是本地、不过期、工作空间。 */
    targetKind?: GrantTargetKind;
    targetId?: string;
    origin?: string;
    expiresAtMs?: number;
  },
): {
  grantId: string;
  subjectKind: GrantSubjectKind;
  subjectId: string;
  workspaceId: string;
  role: ShareRole;
  grantedBy: string;
  createdAtMs: number;
} {
  const targetKind = input.targetKind ?? "workspace";
  const targetId = input.targetId ?? "";
  const origin = input.origin ?? "";
  const expiresAtMs = input.expiresAtMs ?? 0;
  const live = accounts.liveGrant(
    input.subjectKind,
    input.subjectId,
    input.workspaceId,
    targetKind,
    targetId,
  );
  if (live !== undefined) {
    // 同一目标、同一角色、同一来源：原地续租，不撤旧立新。租约过期的不算数，重立。
    const leased = live.expiresAtMs === 0 || live.expiresAtMs > input.nowMs;
    if (live.role === input.role && live.origin === origin && leased) {
      if (origin !== "" && expiresAtMs !== live.expiresAtMs) {
        accounts.renewGrant(live.grantId, expiresAtMs);
      }
      return {
        grantId: live.grantId,
        subjectKind: live.subjectKind,
        subjectId: live.subjectId,
        workspaceId: live.workspaceId,
        role: live.role,
        grantedBy: live.grantedBy,
        createdAtMs: live.createdAtMs,
      };
    }
    accounts.revokeGrant(live.grantId, input.nowMs);
  }
  const grantId = newId();
  const row = {
    grantId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    workspaceId: input.workspaceId,
    role: input.role,
    grantedBy: input.grantedBy,
    createdAtMs: input.nowMs,
  };
  accounts.createGrant({
    ...row,
    revokedAtMs: 0,
    origin,
    expiresAtMs,
    targetKind,
    targetId,
  });
  return row;
}

/** 邀请的终点在不在断言声明的范围里；没声明范围就不比。 */
export function invitationWithin(
  row: InvitationRow,
  scope:
    | { workspaceIds: readonly string[]; sessionIds: readonly string[] }
    | undefined,
): boolean {
  if (scope === undefined) return true;
  if (scope.workspaceIds.length > 0) {
    if (row.targetHost) return false;
    if (!scope.workspaceIds.includes(row.targetWorkspaceId)) return false;
  }
  if (scope.sessionIds.length > 0) {
    if (!scope.sessionIds.includes(row.targetSessionId)) return false;
  }
  return true;
}

/**
 * 云登录后的授予同步与续租（契约 §60），在一笔事务里：
 *
 *   * `asserted` 给了（断言带 `role`）：这个主体经 `origin` 来的授予整份换成它——
 *     不在里面的撤掉、在里面的建或续租；本地授予（`origin = ''`）不动。
 *   * 没给（旧签发方、个人中转）：只给经 `origin` 来的授予续租；`readOnly` 时把它们
 *     压到 viewer（会话授予本来就只读）。
 *
 * owner 不同步：owner 的判定恒真，云端声明不改变它。答这次有没有改动授予。
 */
export function applyCloudGrants(
  store: IdentityStore,
  nowMs: number,
  input: {
    principalId: string;
    provenance: GrantProvenance;
    asserted?: readonly AssertedGrant[];
  },
): boolean {
  const { origin, leaseUntilMs } = input.provenance;
  const readOnly = input.provenance.readOnly === true;
  if (!ID_PATTERN.test(input.principalId) || origin === "") {
    throw new IdentityError("invalid");
  }
  const changed = store.transaction((tx) => {
    const principal = tx.accounts.principal(input.principalId);
    if (principal === undefined || principal.kind === "owner") return false;
    const grantedBy = tx.accounts.owner()?.principalId ?? input.principalId;
    const now = nowMs;
    const current = tx.accounts.originGrants(input.principalId, origin);
    const key = (grant: {
      targetKind: GrantTargetKind;
      workspaceId: string;
      targetId: string;
    }) =>
      `${grant.targetKind}\u0000${grant.workspaceId}\u0000${grant.targetId}`;
    const desired =
      input.asserted ??
      current.map((grant) => ({
        targetKind: grant.targetKind,
        workspaceId: grant.workspaceId,
        targetId: grant.targetId,
        role: grant.role,
      }));
    const wanted = new Map<string, AssertedGrant>();
    for (const grant of desired) {
      const workspaceId =
        grant.targetKind === "host" ? HOST_WORKSPACE : grant.workspaceId;
      if (
        (grant.targetKind !== "host" &&
          (workspaceId === "" || !validIdentifier(workspaceId))) ||
        (grant.targetKind === "session" &&
          (grant.targetId === "" || !validIdentifier(grant.targetId)))
      ) {
        continue;
      }
      const role: ShareRole =
        readOnly || grant.targetKind === "session" ? "viewer" : grant.role;
      wanted.set(key({ ...grant, workspaceId }), {
        ...grant,
        workspaceId,
        role,
      });
    }
    let touched = false;
    for (const grant of current) {
      const next = wanted.get(key(grant));
      if (next === undefined || next.role !== grant.role) {
        tx.accounts.revokeGrant(grant.grantId, now);
        touched = true;
      }
    }
    for (const grant of wanted.values()) {
      const before = tx.accounts.liveGrant(
        "principal",
        input.principalId,
        grant.workspaceId,
        grant.targetKind,
        grant.targetId,
      );
      // 本地给的同一目标授予优先：云端不覆盖 owner 手工给的那一条。
      if (before !== undefined && before.origin === "") continue;
      const row = putGrantRow(tx.accounts, {
        subjectKind: "principal",
        subjectId: input.principalId,
        workspaceId: grant.workspaceId,
        targetKind: grant.targetKind,
        targetId: grant.targetId,
        role: grant.role,
        grantedBy,
        nowMs: now,
        origin,
        expiresAtMs: leaseUntilMs,
      });
      if (before?.grantId !== row.grantId) touched = true;
    }
    if (touched) {
      tx.accounts.appendAudit({
        atMs: now,
        principalId: input.principalId,
        deviceId: "",
        action: "share.grant.sync",
        target: input.principalId,
        workspaceId: "",
        detailJson: JSON.stringify({
          origin,
          grants: [...wanted.values()].map((grant) => ({
            target: grant.targetKind,
            workspaceId: grant.workspaceId,
            ...(grant.targetId === "" ? {} : { sessionId: grant.targetId }),
            role: grant.role,
          })),
        }),
      });
    }
    return touched;
  });
  if (changed) accessChanged();
  return changed;
}

/**
 * 撤一条分享链接时连同已经进来的访客一起停用（契约 §60）：经这个签发方、
 * `subject` 以 `guest:<linkId>:` 开头的主体，停用并撤掉活会话。答停用了几个。
 */
export function disableLinkGuests(
  store: IdentityStore,
  nowMs: number,
  actor: AuthorizationSubject,
  input: { provider: string; linkId: string },
): number {
  if (input.provider === "" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.linkId)) {
    throw new IdentityError("invalid");
  }
  const disabled = store.transaction((tx) => {
    requireManage(tx.accounts, actor, nowMs);
    const now = nowMs;
    let count = 0;
    for (const principalId of tx.accounts.oauthPrincipalsWithSubjectPrefix(
      input.provider,
      `guest:${input.linkId}:`,
    )) {
      const row = tx.accounts.principal(principalId);
      if (row === undefined || row.kind === "owner") continue;
      if (row.disabledAtMs === 0) {
        tx.accounts.disablePrincipal(principalId, now);
        count += 1;
      }
      revokeSessionsOf(tx, principalId, now);
    }
    if (count > 0) {
      note(tx.accounts, actor, now, {
        action: "identity.principal.disable.link",
        target: input.linkId,
        detail: { count },
      });
    }
    return count;
  });
  if (disabled > 0) accessChanged();
  return disabled;
}

/**
 * 凭一个外部身份、不经邀请建成员（契约 §60）：SaaS 登记的签发方带 `org` 与 `role`
 * 声明时，组织就是准入，授予随后由 {@link applyCloudGrants} 按声明同步。
 */
export function registerExternal(
  store: IdentityStore,
  nowMs: number,
  input: {
    displayName: string;
    provider: string;
    subject: string;
    createdVia: string;
  },
): { principalId: string } {
  if (
    !validName(input.displayName) ||
    input.provider === "" ||
    input.subject === ""
  ) {
    throw new IdentityError("invalid");
  }
  return store.transaction((tx) => {
    const now = nowMs;
    if (tx.accounts.liveOAuth(input.provider, input.subject) !== undefined) {
      throw new IdentityError("conflict");
    }
    const principalId = newId();
    tx.accounts.createPrincipal({
      principalId,
      kind: "member",
      displayName: input.displayName,
      createdAtMs: now,
      disabledAtMs: 0,
    });
    tx.accounts.createCredential({
      credentialId: newId(),
      principalId,
      kind: "oauth",
      provider: input.provider,
      subject: input.subject,
      secretHash: Buffer.alloc(0),
      salt: Buffer.alloc(0),
      kdf: "",
      cost: 0,
      block: 0,
      parallel: 0,
      length: 0,
      createdAtMs: now,
      revokedAtMs: 0,
    });
    note(tx.accounts, { principalId, kind: "member", scopes: [] }, now, {
      action: "identity.principal.register",
      target: principalId,
      detail: { createdVia: input.createdVia },
    });
    return { principalId };
  });
}

/** 撤掉这个人的全部活会话。 */
function revokeSessionsOf(
  tx: IdentityTx,
  principalId: string,
  now: number,
): void {
  for (const { session } of tx.liveSessions(now, principalId)) {
    tx.revokeSession(session.sessionId, now);
  }
}

/** 全局 `identity:manage`（owner 恒有）。 */
function requireManage(
  accounts: AccountsTx,
  actor: AuthorizationSubject,
  nowMs: number,
): void {
  if (actor.kind === "owner") return;
  const granted = [
    ...actor.scopes,
    ...compileGrants(accounts, actor.principalId, nowMs),
  ];
  if (!permits(granted, [scope("identity:manage")])) {
    throw new IdentityError("permission");
  }
}

function note(
  accounts: AccountsTx,
  actor: AuthorizationSubject,
  nowMs: number,
  event: { action: string; target: string; detail: Record<string, unknown> },
): void {
  accounts.appendAudit({
    atMs: nowMs,
    principalId: actor.principalId,
    deviceId: "",
    action: event.action,
    target: event.target,
    workspaceId: "",
    detailJson: JSON.stringify(event.detail),
  });
}
