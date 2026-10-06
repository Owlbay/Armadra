import { z } from "zod";

import { devicePlatformSchema } from "../api/identity-security.js";
import { cloud } from "./cloud.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `identity.*`：会话与设备（契约 §42.1），加上云登录与登记 `identity.cloud.*`
 * （§31，A2-3）。
 *
 * 凭据换会话的那几条——配对、hello、刷新、换 CSRF、登出、WebSocket 票、口令 /
 * 第二因素 / passkey 登录、持邀请注册、OAuth 发起与回调、口令重置链接、
 * `cloud/login`——不在这里：它们先于会话存在、或者要发 Cookie，留在
 * `/api/identity/` 的 REST 匿名面（§42.4）。
 *
 * 旧路径由身份域的原样路由答（`core/identity/http.ts`），与 procedure 调同一份
 * 实现。服务器壳上 procedure 的路由门按旧路径去问：`/api/identity/` 是身份域
 * 自己判的那一段（`route-scopes.ts` 的 `SELF_GUARDED`），所以 `scope` 一列写的
 * 是旧路由表里「管别人的」那一档，本人的设备与会话由身份域按请求主体放行。
 */

export { cloud };

const denied = errors.pick("unauthenticated", "forbidden");

const section = (
  scope: "identity:read" | "identity:manage",
  method: "GET" | "POST",
  path: string,
) =>
  meta({
    scope,
    since: "1.11",
    contract: "§42.1",
    legacy: { method, path },
  });

const grantSchema = z.object({
  permission: z.string(),
  workspaceId: z.string(),
  executionHostId: z.string(),
});

/** `GET /api/identity/session` 的形状：密钥不在里面。 */
export const identitySessionWireSchema = z.object({
  hostId: z.string(),
  device: z.object({
    deviceId: z.string(),
    principalId: z.string(),
    displayName: z.string(),
    role: z.string(),
    createdAtUnixMs: z.number(),
    revision: z.number(),
  }),
  scopes: z.array(grantSchema),
  expiresAtUnixMs: z.number(),
});
export type IdentitySessionWire = z.infer<typeof identitySessionWireSchema>;

export const identityDeviceWireSchema = z.object({
  deviceId: z.string(),
  principalId: z.string(),
  name: z.string(),
  role: z.string(),
  epoch: z.number(),
  createdAtMs: z.number(),
  revokedAtMs: z.number(),
  platform: devicePlatformSchema.optional(),
  lastSeenAtMs: z.number().optional(),
});

export const identityDevicePageWireSchema = z.object({
  devices: z.array(identityDeviceWireSchema),
  nextId: z.string(),
  hasMore: z.boolean(),
});
export type IdentityDevicePageWire = z.infer<
  typeof identityDevicePageWireSchema
>;

export const identity = {
  cloud,
  /** 这条会话：登录快照 ∪ 现编的共享授权（成员）。 */
  session: oc
    .input(z.object({}).optional())
    .output(identitySessionWireSchema)
    .errors(denied)
    .meta(section("identity:read", "GET", "/api/identity/session")),
  devices: {
    /** 本人配过的设备，按 id 分页（`limit` 1–200，缺省 50）。 */
    list: oc
      .input(
        z
          .object({
            afterId: z.string().optional(),
            limit: z.number().optional(),
          })
          .optional(),
      )
      .output(identityDevicePageWireSchema)
      .errors({ ...denied, ...errors.pick("bad_request") })
      .meta(section("identity:read", "GET", "/api/identity/devices")),
    /** 撤销本人的一台设备；`expectedRevision` 是读到时的 epoch。 */
    revoke: oc
      .input(z.object({ deviceId: z.string(), expectedRevision: z.number() }))
      .output(z.object({ deviceId: z.string(), revoked: z.literal(true) }))
      .errors({
        ...denied,
        ...errors.pick("bad_request", "not_found", "conflict"),
      })
      .meta(section("identity:manage", "POST", "/api/identity/devices/revoke")),
  },
};
