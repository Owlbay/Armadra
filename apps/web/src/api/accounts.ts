import { z } from "zod";

import {
  identityRequest,
  identitySessionSchema,
  rememberCsrf,
  type IdentitySession,
} from "./identity";
import { localClient } from "./client";
import { identityRpc } from "./identity-rpc";

/**
 * 账号、组、邀请与共享的客户端（`docs/design/server-accounts-and-sharing.md`
 * §3，契约 §10、§42.3）：`accounts.*` procedure，经本机源的契约客户端发
 * （`identity-rpc.ts`）。桌面壳的页面是 Bearer、服务器壳托管的页面是 Cookie +
 * CSRF，由源决定，这里不碰凭据。持邀请注册与口令登录发的是会话，留在 REST
 * 匿名面（`identity.ts` 的传输）。
 */

export const SHARE_ROLES = ["viewer", "editor", "operator", "driver"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

const shareRoleSchema = z.enum(SHARE_ROLES);

const principalSchema = z.object({
  principalId: z.string(),
  kind: z.enum(["owner", "member", "service"]),
  displayName: z.string().default(""),
  createdAtMs: z.number().default(0),
  disabledAtMs: z.number().default(0),
  hasPassword: z.boolean().default(false),
});
export type Principal = z.infer<typeof principalSchema>;

const groupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string().default(""),
  createdAtMs: z.number().default(0),
  members: z
    .array(
      z.object({
        principalId: z.string(),
        role: z.enum(["admin", "member"]),
        joinedAtMs: z.number().default(0),
      }),
    )
    .default([]),
});
export type Group = z.infer<typeof groupSchema>;
export type GroupRole = Group["members"][number]["role"];

const invitationSchema = z.object({
  invitationId: z.string(),
  issuedBy: z.string().default(""),
  role: shareRoleSchema,
  targetGroupId: z.string().default(""),
  targetWorkspaceId: z.string().default(""),
  createdAtMs: z.number().default(0),
  expiresAtMs: z.number().default(0),
  consumedBy: z.string().default(""),
  consumedAtMs: z.number().default(0),
});
export type Invitation = z.infer<typeof invitationSchema>;

const issuedInvitationSchema = z.object({
  invitationId: z.string(),
  token: z.string(),
  expiresAtMs: z.number(),
  role: shareRoleSchema,
  targetGroupId: z.string().default(""),
  targetWorkspaceId: z.string().default(""),
});
export type IssuedInvitation = z.infer<typeof issuedInvitationSchema>;

const grantSchema = z.object({
  grantId: z.string(),
  subjectKind: z.enum(["principal", "group"]),
  subjectId: z.string(),
  workspaceId: z.string(),
  role: shareRoleSchema,
  grantedBy: z.string().default(""),
  createdAtMs: z.number().default(0),
  permissions: z.array(z.string()).default([]),
});
export type Grant = z.infer<typeof grantSchema>;

/* --------------------------------- 成员 ---------------------------------- */

export async function listPrincipals(): Promise<Principal[]> {
  return z
    .array(principalSchema)
    .parse(
      (await identityRpc((client) => client.accounts.principals.list()))
        .principals,
    );
}

/** 管理员直接建一个成员并给他设初始口令。 */
export async function createMember(
  displayName: string,
  password: string,
): Promise<{ principal: Principal; passwordBreached: boolean }> {
  const created = principalSchema.parse(
    await identityRpc((client) =>
      client.accounts.principals.create({ displayName }),
    ),
  );
  const { passwordBreached } = await setPassword(created.principalId, password);
  return { principal: created, passwordBreached };
}

export async function disablePrincipal(principalId: string): Promise<void> {
  await identityRpc((client) =>
    client.accounts.principals.disable({ principalId }),
  );
}

/**
 * 设口令。答撤掉了这个人几个其它会话（安全审查 L2：本人换口令留下当前会话，
 * owner 替人设时那个人的会话全撤；旧 core 不报时为 0），以及泄露检查 `warn`
 * 档是否命中（契约 §18.1）。
 */
export async function setPassword(
  principalId: string,
  password: string,
): Promise<{ revokedSessions: number; passwordBreached: boolean }> {
  const answer = z
    .object({
      revokedSessions: z.number().default(0),
      passwordBreached: z.boolean().default(false),
    })
    .parse(
      await identityRpc((client) =>
        client.accounts.credentials.setPassword({
          kind: "password",
          principalId,
          password,
        }),
      ),
    );
  return {
    revokedSessions: answer.revokedSessions,
    passwordBreached: answer.passwordBreached,
  };
}

/* ---------------------------------- 组 ----------------------------------- */

export async function listGroups(): Promise<Group[]> {
  return z
    .array(groupSchema)
    .parse(
      (await identityRpc((client) => client.accounts.groups.list())).groups,
    );
}

export async function createGroup(name: string): Promise<void> {
  await identityRpc((client) => client.accounts.groups.create({ name }));
}

export async function deleteGroup(groupId: string): Promise<void> {
  await identityRpc((client) => client.accounts.groups.remove({ groupId }));
}

export async function putGroupMember(
  groupId: string,
  principalId: string,
  role: GroupRole,
): Promise<void> {
  await identityRpc((client) =>
    client.accounts.groups.putMember({ groupId, principalId, role }),
  );
}

export async function removeGroupMember(
  groupId: string,
  principalId: string,
): Promise<void> {
  await identityRpc((client) =>
    client.accounts.groups.removeMember({ groupId, principalId }),
  );
}

/* --------------------------------- 邀请 ---------------------------------- */

export async function listInvitations(): Promise<Invitation[]> {
  return z
    .array(invitationSchema)
    .parse(
      (await identityRpc((client) => client.accounts.invitations.list()))
        .invitations,
    );
}

export async function issueInvitation(input: {
  role: ShareRole;
  targetWorkspaceId?: string;
  targetGroupId?: string;
}): Promise<IssuedInvitation> {
  return issuedInvitationSchema.parse(
    await identityRpc((client) => client.accounts.invitations.issue(input)),
  );
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  await identityRpc((client) =>
    client.accounts.invitations.revoke({ invitationId }),
  );
}

/**
 * 邀请链接：页面根上的 `#invite=<令牌>`，和服务器壳 `invitationUrl` 同一个
 * 拼法。令牌只在片段里，不上请求行。
 */
export function invitationLink(token: string, origin = location.origin) {
  return `${origin}/#invite=${token}`;
}

/** 地址栏里有没有一张待兑换的邀请（不取走）。 */
export function hasInvitationFragment(): boolean {
  return /^#invite=[A-Za-z0-9._~-]+$/.test(globalThis.location?.hash ?? "");
}

/** 取走地址栏里的邀请令牌并把片段抹掉，免得它留在分享出去的链接里。 */
export function takeInvitationToken(): string {
  const location = globalThis.location;
  const found = /^#invite=([A-Za-z0-9._~-]+)$/.exec(location?.hash ?? "");
  if (!found) return "";
  try {
    globalThis.history?.replaceState(
      null,
      "",
      `${location.pathname}${location.search}`,
    );
  } catch {
    /* 抹不掉地址栏不该让兑换失败。 */
  }
  return found[1] as string;
}

/** 注册的答案：会话，泄露检查 `warn` 命中时多 `passwordBreached`。 */
const registeredSchema = identitySessionSchema.extend({
  passwordBreached: z.boolean().optional(),
});

/** 拿着邀请注册：建账号、兑换邀请、登录，一次请求。 */
export async function redeemInvitation(input: {
  token: string;
  displayName: string;
  password: string;
}): Promise<IdentitySession & { passwordBreached?: boolean }> {
  const session = await identityRequest("register", registeredSchema, {
    method: "POST",
    anonymous: true,
    body: { ...input, deviceName: deviceName() },
  });
  rememberCsrf(session.csrfToken ?? "");
  return session;
}

/** 口令登录。账号标识是注册之后页面上给出的那一串。 */
export async function loginWithPassword(
  principalId: string,
  password: string,
): Promise<IdentitySession> {
  const session = await identityRequest("login", identitySessionSchema, {
    method: "POST",
    anonymous: true,
    body: { principalId, password, deviceName: deviceName() },
  });
  rememberCsrf(session.csrfToken ?? "");
  return session;
}

function deviceName(): string {
  const agent = globalThis.navigator?.userAgent ?? "";
  const browser = /Firefox\//.test(agent)
    ? "Firefox"
    : /Edg\//.test(agent)
      ? "Edge"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  return `Armadra · ${browser}`;
}

/* --------------------------------- 共享 ---------------------------------- */

export async function listGrants(workspaceId: string): Promise<Grant[]> {
  return z
    .array(grantSchema)
    .parse(
      (
        await identityRpc((client) =>
          client.accounts.grants.list({ workspaceId }),
        )
      ).grants,
    );
}

export async function putGrant(input: {
  workspaceId: string;
  subjectKind: Grant["subjectKind"];
  subjectId: string;
  role: ShareRole;
}): Promise<void> {
  await identityRpc((client) => client.accounts.grants.put(input));
}

export async function revokeGrant(input: {
  workspaceId: string;
  subjectKind: Grant["subjectKind"];
  subjectId: string;
}): Promise<void> {
  await identityRpc((client) => client.accounts.grants.revoke(input));
}

/* --------------------------------- 签发方 --------------------------------- */

/** 主体来自哪里：本机，或某个中转（按登记的服务标签）。 */
export type Origin =
  | { readonly kind: "local" }
  | { readonly kind: "relay"; readonly label: string };

const LOCAL: Origin = { kind: "local" };

async function providerOf(issuer: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(issuer),
  );
  const hex = Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // 与 core 的映射凭据 provider 同一写法（契约 §31）。
  return `cloud:${hex.slice(0, 16)}`;
}

/**
 * 每个主体的来源：映射凭据 `provider` 是 `cloud:<issuer 摘要>` 的，来自对应
 * 中转；其余（口令、本机建的）算本机。只读现有字段，任一步读不到都按本机。
 */
export async function listOrigins(
  principalIds: readonly string[],
): Promise<Record<string, Origin>> {
  const labels = new Map<string, string>();
  try {
    const { remotes } = await localClient().sources.list({});
    for (const remote of remotes) {
      labels.set(
        await providerOf(remote.issuer),
        remote.label || remote.issuer,
      );
    }
  } catch {
    // 没有本机 core 的页面（托管）：全部算本机。
  }
  const result: Record<string, Origin> = {};
  await Promise.all(
    principalIds.map(async (principalId) => {
      result[principalId] = LOCAL;
      if (labels.size === 0) return;
      try {
        const { credentials } = await identityRpc((client) =>
          client.accounts.credentials.list({ principalId }),
        );
        for (const credential of credentials) {
          const label = labels.get(credential.provider);
          if (credential.revokedAtMs === 0 && label !== undefined) {
            result[principalId] = { kind: "relay", label };
            return;
          }
        }
      } catch {
        // 读不到按本机。
      }
    }),
  );
  return result;
}
