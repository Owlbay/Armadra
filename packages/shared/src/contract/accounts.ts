import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `accounts.*`（契约 §42.3）：账号、凭据、邀请、组与共享（§10），以及替人签发
 * 口令重置链接（§25）。
 *
 * 判定都在身份域（`core/identity/accounts.ts`），与旧路径同一份实现：owner 与
 * 持 `identity:manage` 的人管全部；组 `admin` 管自己所管的组（加减成员、签发
 * 指向本组的邀请、给本组成员签重置链接）；共享看那块画布上的 `workspace:share`。
 * `scope` 一列是旧路由表的那一档（见 `identity.ts` 的说明）。
 *
 * 持邀请注册（建账号 + 兑换 + 登录）发的是会话，留在 REST 匿名面（§42.4）；
 * 已登录的人兑换邀请是 `invitations.accept`。邀请令牌与重置令牌的明文只在签发
 * 那一次答出去，库里只有哈希；口令只进不出。
 */

const denied = errors.pick("unauthenticated", "forbidden");
const invalid = errors.pick("bad_request");
const missing = errors.pick("bad_request", "not_found");

const section = (
  scope: "identity:read" | "identity:manage" | "workspace:share",
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  successStatus?: number,
) =>
  meta({
    scope,
    since: "1.11",
    contract: "§42.3",
    ...(scope === "workspace:share" ? { workspaceKey: "workspaceId" } : {}),
    legacy: {
      method,
      path,
      ...(successStatus === undefined ? {} : { successStatus }),
    },
  });

const none = z.object({}).optional();

export const principalWireSchema = z.object({
  principalId: z.string(),
  kind: z.enum(["owner", "member", "service"]),
  displayName: z.string(),
  createdAtMs: z.number(),
  disabledAtMs: z.number(),
  hasPassword: z.boolean(),
});

export const credentialWireSchema = z.object({
  credentialId: z.string(),
  principalId: z.string(),
  kind: z.string(),
  provider: z.string(),
  createdAtMs: z.number(),
  revokedAtMs: z.number(),
});

export const invitationWireSchema = z.object({
  invitationId: z.string(),
  issuedBy: z.string(),
  role: z.string(),
  targetGroupId: z.string(),
  targetWorkspaceId: z.string(),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  consumedBy: z.string(),
  consumedAtMs: z.number(),
  /** `null` = 一次性。 */
  maxUses: z.number().nullable(),
  uses: z.number(),
});

/** 签发的答案：令牌明文只在这一次。 */
export const issuedInvitationWireSchema = z.object({
  invitationId: z.string(),
  token: z.string(),
  expiresAtMs: z.number(),
  role: z.string(),
  targetGroupId: z.string(),
  targetWorkspaceId: z.string(),
  maxUses: z.number().nullable(),
});

export const groupWireSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string(),
  createdAtMs: z.number(),
  members: z.array(
    z.object({
      principalId: z.string(),
      role: z.enum(["admin", "member"]),
      joinedAtMs: z.number(),
    }),
  ),
});

export const grantWireSchema = z.object({
  grantId: z.string(),
  subjectKind: z.enum(["principal", "group"]),
  subjectId: z.string(),
  workspaceId: z.string(),
  role: z.string(),
  grantedBy: z.string(),
  createdAtMs: z.number(),
  /** 这条授予编译出来的权限名。 */
  permissions: z.array(z.string()),
});

const grantTarget = z.object({
  workspaceId: z.string(),
  subjectKind: z.string(),
  subjectId: z.string(),
});

export const accounts = {
  principals: {
    list: oc
      .input(none)
      .output(z.object({ principals: z.array(principalWireSchema) }))
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/principals")),
    /** 建一个成员（或服务账号）；口令另设。 */
    create: oc
      .input(z.object({ displayName: z.string(), kind: z.string().optional() }))
      .output(principalWireSchema)
      .errors({ ...denied, ...invalid })
      .meta(
        section("identity:manage", "POST", "/api/identity/principals", 201),
      ),
    disable: oc
      .input(z.object({ principalId: z.string() }))
      .output(z.object({ disabled: z.literal(true) }))
      .errors({ ...denied, ...missing })
      .meta(
        section(
          "identity:manage",
          "POST",
          "/api/identity/principals/{principalId}/disable",
        ),
      ),
    /** 替人签发口令重置令牌（契约 §25）：明文只在这一次。 */
    issuePasswordReset: oc
      .input(z.object({ principalId: z.string() }))
      .output(z.object({ token: z.string(), expiresAtMs: z.number() }))
      .errors({ ...denied, ...missing })
      .meta(
        section(
          "identity:manage",
          "POST",
          "/api/identity/principals/{principalId}/password-reset",
          201,
        ),
      ),
  },
  credentials: {
    /** 一个人的凭据：哈希、盐、公钥都不出域。本人或 `identity:manage`。 */
    list: oc
      .input(z.object({ principalId: z.string() }))
      .output(z.object({ credentials: z.array(credentialWireSchema) }))
      .errors({ ...denied, ...invalid })
      .meta(section("identity:read", "GET", "/api/identity/credentials")),
    /**
     * 设（或换）口令：过口令策略与泄露检查；撤掉这个人的其它会话（本人换时留下
     * 当前这个）。`kind` 只认 `password`，别的答 501。
     */
    setPassword: oc
      .input(
        z.object({
          principalId: z.string(),
          password: z.string(),
          kind: z.string().optional(),
        }),
      )
      .output(
        z.object({
          credentialId: z.string(),
          revokedSessions: z.number(),
          passwordBreached: z.literal(true).optional(),
        }),
      )
      .errors({ ...denied, ...missing, ...errors.pick("not_implemented") })
      .meta(
        section("identity:manage", "POST", "/api/identity/credentials", 201),
      ),
    revoke: oc
      .input(z.object({ credentialId: z.string() }))
      .output(z.object({ revoked: z.literal(true) }))
      .errors({ ...denied, ...missing })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/credentials/{credentialId}",
        ),
      ),
  },
  invitations: {
    list: oc
      .input(none)
      .output(z.object({ invitations: z.array(invitationWireSchema) }))
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/invitations")),
    /** 签发：指向一个组、一块画布，或两者；`ttlMs` 最长 30 天，`maxUses` 1–1000。 */
    issue: oc
      .input(
        z.object({
          role: z.string(),
          targetGroupId: z.string().nullable().optional(),
          targetWorkspaceId: z.string().nullable().optional(),
          ttlMs: z.number().optional(),
          maxUses: z.number().nullable().optional(),
        }),
      )
      .output(issuedInvitationWireSchema)
      .errors({ ...denied, ...missing })
      .meta(
        section("identity:manage", "POST", "/api/identity/invitations", 201),
      ),
    revoke: oc
      .input(z.object({ invitationId: z.string() }))
      .output(z.object({ revoked: z.literal(true) }))
      .errors({ ...denied, ...missing })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/invitations/{invitationId}",
        ),
      ),
    /** 已登录的人兑换一张邀请：不存在、用过、过期、令牌不对一律 401。 */
    accept: oc
      .input(z.object({ invitationId: z.string(), token: z.string() }))
      .output(
        z.object({
          role: z.string(),
          groupId: z.string(),
          workspaceId: z.string(),
        }),
      )
      .errors({ ...denied, ...invalid })
      .meta(
        section(
          "identity:read",
          "POST",
          "/api/identity/invitations/{invitationId}/accept",
        ),
      ),
  },
  groups: {
    list: oc
      .input(none)
      .output(z.object({ groups: z.array(groupWireSchema) }))
      .errors(denied)
      .meta(section("identity:read", "GET", "/api/identity/groups")),
    create: oc
      .input(z.object({ name: z.string() }))
      .output(
        z.object({
          groupId: z.string(),
          name: z.string(),
          createdAtMs: z.number(),
        }),
      )
      .errors({ ...denied, ...invalid })
      .meta(section("identity:manage", "POST", "/api/identity/groups", 201)),
    rename: oc
      .input(z.object({ groupId: z.string(), name: z.string() }))
      .output(z.object({ groupId: z.string(), renamed: z.literal(true) }))
      .errors({ ...denied, ...invalid })
      .meta(
        section("identity:manage", "PATCH", "/api/identity/groups/{groupId}"),
      ),
    remove: oc
      .input(z.object({ groupId: z.string() }))
      .output(z.object({ groupId: z.string(), deleted: z.literal(true) }))
      .errors({ ...denied, ...invalid })
      .meta(
        section("identity:manage", "DELETE", "/api/identity/groups/{groupId}"),
      ),
    /** 加人或改组内角色（缺省 `member`）：组 `admin` 管自己的组。 */
    putMember: oc
      .input(
        z.object({
          groupId: z.string(),
          principalId: z.string(),
          role: z.string().optional(),
        }),
      )
      .output(z.object({ groupId: z.string(), principalId: z.string() }))
      .errors({ ...denied, ...missing })
      .meta(
        section(
          "identity:manage",
          "PUT",
          "/api/identity/groups/{groupId}/members/{principalId}",
        ),
      ),
    removeMember: oc
      .input(z.object({ groupId: z.string(), principalId: z.string() }))
      .output(
        z.object({
          groupId: z.string(),
          principalId: z.string(),
          removed: z.literal(true),
        }),
      )
      .errors({ ...denied, ...invalid })
      .meta(
        section(
          "identity:manage",
          "DELETE",
          "/api/identity/groups/{groupId}/members/{principalId}",
        ),
      ),
  },
  grants: {
    /** 一块画布上的共享，加上角色 → 权限的编译表（共享对话框的四个单选项）。 */
    list: oc
      .input(z.object({ workspaceId: z.string() }))
      .output(
        z.object({
          workspaceId: z.string(),
          grants: z.array(grantWireSchema),
          roles: z.array(z.string()),
        }),
      )
      .errors({ ...denied, ...invalid })
      .meta(section("workspace:share", "GET", "/api/identity/grants")),
    /** 授予或改角色：改角色 = 撤旧立新。 */
    put: oc
      .input(grantTarget.extend({ role: z.string() }))
      .output(grantWireSchema)
      .errors({ ...denied, ...missing })
      .meta(section("workspace:share", "PUT", "/api/identity/grants")),
    revoke: oc
      .input(grantTarget)
      .output(z.object({ revoked: z.literal(true) }))
      .errors({ ...denied, ...missing })
      .meta(section("workspace:share", "DELETE", "/api/identity/grants")),
  },
};
