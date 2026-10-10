import {
  clientSourceSchema as protocolClientSourceSchema,
  mountInputSchema,
  remoteAddInputSchema as protocolRemoteAddInputSchema,
  remoteAddOutputSchema as protocolRemoteAddOutputSchema,
  remoteDevicePollOutputSchema,
  remoteServiceSchema as protocolRemoteServiceSchema,
  remoteSessionOutputSchema,
  remoteSourceSummarySchema,
  remoteSourcesOutputSchema,
  serviceIdInputSchema,
  sourceIdInputSchema,
  sourcesAddDirectInputSchema,
  sourcesListOutputSchema as protocolSourcesListOutputSchema,
  sourcesSessionInputSchema as protocolSourcesSessionInputSchema,
  sourcesSessionOutputSchema,
  sourcesUpdateInputSchema,
  viaSchema,
} from "@armadra/platform-protocol/core-api";
import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `sources.*`（契约 §33）：这台 core 作为「客户端宿主」记住的别的源，以及它
 * 登记过 / 能登录的远程服务。全部 owner 专用：读 `settings:read`，写
 * `settings:write`。
 *
 * 出入参就是协议包 `@armadra/platform-protocol/core-api` 的那一组 schema 对象
 * （cloud 仓与这里同一份，不另抄）；长度、地址、指纹这些语义检查在 core 的域里。
 * 凭据只在 core 的 SecretStore，答案里只有 `hasCredentials`——刷新令牌、口令从不
 * 出现在任何出参里。
 */

/**
 * 一台主机的一条到达方式（契约 §55，迁移 0044）：直连 Gateway 或经某个中继。
 * `origin` 是直连的 Gateway 来源或中继来源；没有凭据，只有地址与时刻。
 */
export const clientSourceRouteSchema = z.object({
  via: viaSchema,
  origin: z.string(),
  cloudIssuer: z.string(),
  fingerprint: z.string(),
  preferred: z.boolean(),
  lastOkAtMs: z.number().int(),
});

/**
 * 源表的一行：协议包的形状加 `routes`（§55）。原有的地址字段照旧，是首选路由的
 * 镜像。协议包是 cloud 仓的，这一处追加只在 core 契约里，字段逐个沿用协议包的。
 */
export const clientSourceSchema = protocolClientSourceSchema.extend({
  routes: z.array(clientSourceRouteSchema),
  /**
   * 服务端报的名字（契约 §61，迁移 0046）：直连主机 hello 的 `hostName`、远程服务
   * 目录里的源名称、本机的「主机名称」。`label ≠ defaultLabel` 即本机改过名。
   */
  defaultLabel: z.string(),
});

/** 远程服务一行：协议包的形状加 `defaultLabel`（§61，platform.info 的 `name`）。 */
export const remoteServiceSchema = protocolRemoteServiceSchema.extend({
  defaultLabel: z.string(),
});

const [personalAddInput, saasAddInput] = protocolRemoteAddInputSchema.options;

/**
 * `sources.remoteAdd` 的入参：协议包的形状，个人中转那支加可选的 `challengeToken`
 * （§62）——远程服务的 `platform.info.challenge` 要求挑战时，挑战组件交回的一次性令牌。
 */
export const remoteAddInputSchema = z.discriminatedUnion("kind", [
  personalAddInput.extend({ challengeToken: z.string().max(2048).optional() }),
  saasAddInput,
]);

export const remoteAddOutputSchema = protocolRemoteAddOutputSchema.extend({
  remote: remoteServiceSchema,
});

export const sourcesListOutputSchema = protocolSourcesListOutputSchema.extend({
  sources: z.array(clientSourceSchema),
  remotes: z.array(remoteServiceSchema),
});

/** `sources.remoteUpdate`（§61）：改远程服务的显示名；空串恢复缺省名。 */
export const remoteUpdateInputSchema = z.object({
  serviceId: serviceIdInputSchema.shape.serviceId,
  label: z.string().max(256),
});

/**
 * `sources.remotePasswordChange`（§63）：改远程服务账号的口令。`password` 是旧口令；
 * 远程服务要求挑战时带 `challengeToken`（同 §62）。口令不存、不记。
 */
export const remotePasswordChangeInputSchema = z.object({
  serviceId: serviceIdInputSchema.shape.serviceId,
  password: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
  challengeToken: z.string().max(2048).optional(),
});

/** 一条路的标识：`(via, origin)`。 */
export const sourceRouteRefSchema = z.object({
  via: viaSchema,
  origin: z.string().min(1).max(2048),
});

/** `sources.session` 的入参：协议包的形状加可选的 `route`（§55）。 */
export const sourcesSessionInputSchema =
  protocolSourcesSessionInputSchema.extend({
    route: sourceRouteRefSchema.optional(),
  });

export const sourceRouteInputSchema = sourceRouteRefSchema.extend({
  sourceId: sourceIdInputSchema.shape.sourceId,
});

export { remoteSourceSummarySchema };
export const sourceSessionSchema = sourcesSessionOutputSchema;

const empty = z.object({});

const read = (path: string, method: "GET" | "POST" = "GET") =>
  meta({
    scope: "settings:read",
    since: "1.3",
    contract: "§33.1",
    legacy: { method, path },
  });

const write = (
  section: "§33.1" | "§33.2" | "§33.6" | "§33.7" | "§33.9",
  method: "POST" | "PUT" | "DELETE",
  path: string,
) =>
  meta({
    scope: "settings:write",
    since: "1.3",
    contract: section,
    legacy: { method, path },
  });

const denied = errors.pick("unauthenticated", "forbidden");

/**
 * `sources.mountByLink` 的入参（契约 §33.7）：分享链接原样交给 core——网页链接
 * `<issuer>/j/<linkId>#<秘密>.<邀请令牌>` 或深链 `armadra://join?…`。协议包里
 * 还没有这一条，形状在这里定义；`fingerprint` 是首次核对过的签发方指纹。
 */
export const mountByLinkInputSchema = z.object({
  url: z.string().min(1).max(4096),
  fingerprint: z.string().optional(),
  label: z.string().optional(),
});

/**
 * 分享链接（契约 §33.9）：本机经一个远程服务发出的 `source_invite` 链接。`state`
 * 由 core 按远程服务的记录算：撤销 > 过期 > 用尽 > 生效。`copyable` 表示本机还
 * 存着带片段的整条链接（只有生效中的才存）；整条链接只经 `shareLinkUrl` 与创建的
 * 答案出来，列表里没有。
 */
export const shareLinkStateSchema = z.enum([
  "active",
  "expired",
  "exhausted",
  "revoked",
]);

/**
 * 分享范围（契约 §60）：整台主机、一个工作空间、或那个工作空间里的一个会话
 * （只读）。缺省 = 工作空间（§33.9 的旧行为）。
 */
export const shareTargetSchema = z.enum(["host", "workspace", "session"]);

export const shareLinkSchema = z.object({
  linkId: z.string(),
  label: z.string(),
  role: z.string(),
  /** 链接背后那张邀请指向的工作空间；本机没有记录、或分享整台时为空串。 */
  workspaceId: z.string(),
  /** §60：分享范围；本机没有记录时不出现（当作工作空间）。 */
  target: shareTargetSchema.optional(),
  /** §60：`target = session` 时的会话 id。 */
  sessionId: z.string().optional(),
  /** §60：只读（会话分享总是只读）。 */
  readOnly: z.boolean().optional(),
  createdAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
  uses: z.number().int(),
  maxUses: z.number().int().nullable(),
  revokedAtMs: z.number().int().nullable(),
  state: shareLinkStateSchema,
  copyable: z.boolean(),
});

/** 一条链接最多可用的次数（与 core 邀请的 `maxUses` 上限相同）。 */
export const SHARE_LINK_MAX_USES = 1000;

const shareLinkRefSchema = z.object({
  serviceId: z.string(),
  linkId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

/** 改一条链接的备注（§33.10）：只改远程服务上的 `label`，空串清掉。 */
export const shareLinkUpdateInputSchema = shareLinkRefSchema.extend({
  label: z.string().max(128),
});

export const shareLinkCreateInputSchema = z.object({
  serviceId: z.string(),
  /** `target = host` 时为空串；其余必填（§60，core 答 `bad_request`）。 */
  workspaceId: z.string().max(256),
  /** §60：缺省 `workspace`。 */
  target: shareTargetSchema.optional(),
  /** §60：`target = session` 时必填。 */
  sessionId: z.string().min(1).max(256).optional(),
  /** §60：只读；`viewer` 之外的角色压成 `viewer`。会话分享总是只读。 */
  readOnly: z.boolean().optional(),
  role: z.string(),
  ttlMs: z.number().int().positive(),
  maxUses: z.number().int().min(1).max(SHARE_LINK_MAX_USES),
  label: z.string().max(128).optional(),
});

export const sources = {
  list: oc
    .input(empty.optional())
    .output(sourcesListOutputSchema)
    .errors(denied)
    .meta(read("/api/sources")),
  /** core 代页面完成配对（`POST <origin>/api/identity/pair`），存刷新令牌。 */
  addDirect: oc
    .input(sourcesAddDirectInputSchema)
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "address_invalid",
        "address_https_only",
        "address_plaintext_loopback_only",
        "address_has_credentials",
        "fingerprint_invalid",
        "conflict",
        "source_unreachable",
        "source_unauthorized",
        "fingerprint_mismatch",
      ),
    })
    .meta(write("§33.1", "POST", "/api/sources/direct")),
  update: oc
    .input(sourcesUpdateInputSchema)
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "address_invalid",
        "address_https_only",
        "address_plaintext_loopback_only",
        "address_has_credentials",
        "not_found",
      ),
    })
    .meta(write("§33.1", "PUT", "/api/sources/{sourceId}")),
  /** 删行 + 删 SecretStore；`local` 行答 `conflict`。 */
  remove: oc
    .input(sourceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(write("§33.1", "DELETE", "/api/sources/{sourceId}")),
  /** 只删凭据，保留行（「断开」）。 */
  forget: oc
    .input(sourceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(write("§33.1", "POST", "/api/sources/{sourceId}/forget")),
  /** 用刷新令牌换一对新令牌（旋转写回），答访问令牌与该走的地址。 */
  session: oc
    .input(sourcesSessionInputSchema)
    .output(sourceSessionSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "conflict",
        "source_unauthorized",
        "source_unreachable",
      ),
    })
    .meta(write("§33.1", "POST", "/api/sources/{sourceId}/session")),
  /** 设为首选的路（§55）：镜像随之改写。 */
  routePrefer: oc
    .input(sourceRouteInputSchema)
    .output(clientSourceSchema)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.27",
        contract: "§55.2",
        legacy: {
          method: "POST",
          path: "/api/sources/{sourceId}/routes/prefer",
        },
      }),
    ),
  /** 删一条路与它的凭据（§55）；最后一条答 `conflict`（删源用 `remove`）。 */
  routeRemove: oc
    .input(sourceRouteInputSchema)
    .output(clientSourceSchema)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.27",
        contract: "§55.2",
        legacy: {
          method: "POST",
          path: "/api/sources/{sourceId}/routes/remove",
        },
      }),
    ),
  remoteAdd: oc
    .input(remoteAddInputSchema)
    .output(remoteAddOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "address_invalid",
        "address_https_only",
        "address_plaintext_loopback_only",
        "address_has_credentials",
        "fingerprint_invalid",
        "credentials_invalid",
        "account_locked",
        "rate_limited",
        "fingerprint_mismatch",
        "challenge_required",
        "challenge_invalid",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes")),
  remoteDevicePoll: oc
    .input(serviceIdInputSchema)
    .output(remoteDevicePollOutputSchema)
    .errors({ ...denied, ...errors.pick("not_found", "not_implemented") })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/poll")),
  /** 改远程服务的显示名，只在本机；空串恢复成它报的名字（§61）。 */
  remoteUpdate: oc
    .input(remoteUpdateInputSchema)
    .output(remoteServiceSchema)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.34",
        contract: "§61.2",
        legacy: { method: "PUT", path: "/api/sources/remotes/{serviceId}" },
      }),
    ),
  /** 删远程服务：尽力登出，删行与凭据。 */
  remoteRemove: oc
    .input(serviceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(write("§33.2", "DELETE", "/api/sources/remotes/{serviceId}")),
  remoteSources: oc
    .input(serviceIdInputSchema)
    .output(remoteSourcesOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:read",
        since: "1.3",
        contract: "§33.2",
        legacy: {
          method: "GET",
          path: "/api/sources/remotes/{serviceId}/sources",
        },
      }),
    ),
  /** 取断言 → 经 `relayBaseUrl` `cloud/login` → 存刷新令牌；建 `relayed` 行。 */
  mount: oc
    .input(mountInputSchema)
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "conflict",
        "source_offline",
        "source_unauthorized",
        "source_unreachable",
        "cloud_account_unlinked",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/mount")),
  /** 页面要直接调远程服务（分享、链接）时用的访问令牌。 */
  remoteSession: oc
    .input(serviceIdInputSchema)
    .output(remoteSessionOutputSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/session")),
  /** 登出远程服务：尽力 `auth.logout`，删凭据，留行（契约 §33.6）。 */
  remoteLogout: oc
    .input(serviceIdInputSchema)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(write("§33.6", "POST", "/api/sources/remotes/{serviceId}/logout")),
  /**
   * 改远程服务账号的口令（§63，cloud-api §18）：远程服务撤销账号的其它设备，这台设备
   * 换新的刷新令牌写回；远程服务不报 `auth.password-change` 答 `not_implemented`。
   */
  remotePasswordChange: oc
    .input(remotePasswordChangeInputSchema)
    .output(empty)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "credentials_invalid",
        "account_locked",
        "rate_limited",
        "password_too_short",
        "password_too_long",
        "password_contains_name",
        "password_too_common",
        "password_breached",
        "challenge_required",
        "challenge_invalid",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.36",
        contract: "§63.1",
        legacy: {
          method: "POST",
          path: "/api/sources/remotes/{serviceId}/password",
        },
      }),
    ),
  /**
   * 按分享链接挂载（§33.7）：`links.accept` → 经中继 `cloud/login`（断言 + 邀请
   * 令牌）→ 存凭据，建 `relayed` 行（远程服务没登记过的顺带建一行访客的）。
   */
  mountByLink: oc
    .input(mountByLinkInputSchema)
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "address_invalid",
        "address_https_only",
        "address_plaintext_loopback_only",
        "address_has_credentials",
        "fingerprint_invalid",
        "conflict",
        "fingerprint_mismatch",
        "link_invalid",
        "link_expired",
        "link_exhausted",
        "link_secret_invalid",
        "invitation_invalid",
        "rate_limited",
        "source_offline",
        "source_unauthorized",
        "source_unreachable",
        "cloud_not_registered",
        "not_implemented",
      ),
    })
    .meta(write("§33.7", "POST", "/api/sources/join")),
  /**
   * 本机经这个远程服务发出的分享链接（§33.9），含已撤销、过期、用尽的；顺带删掉
   * 不再生效的那些存着的整条链接。本机没登记到它时答空表。
   */
  shareLinks: oc
    .input(z.object({ serviceId: z.string() }))
    .output(z.object({ links: z.array(shareLinkSchema) }))
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:read",
        since: "1.16",
        contract: "§33.9",
        legacy: {
          method: "GET",
          path: "/api/sources/remotes/{serviceId}/links",
        },
      }),
    ),
  /** 签一张本机邀请，请远程服务建一条指向它的链接，整条链接存进 SecretStore。 */
  shareLinkCreate: oc
    .input(shareLinkCreateInputSchema)
    .output(z.object({ link: shareLinkSchema, url: z.string() }))
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "not_found",
        "cloud_not_registered",
        "source_unauthorized",
        "source_unreachable",
        "rate_limited",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.16",
        contract: "§33.9",
        legacy: {
          method: "POST",
          path: "/api/sources/remotes/{serviceId}/links",
        },
      }),
    ),
  /** 再取一次整条链接（含 `#` 片段）；本机没存着答 `not_found`。 */
  shareLinkUrl: oc
    .input(shareLinkRefSchema)
    .output(z.object({ url: z.string() }))
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.16",
        contract: "§33.9",
        legacy: {
          method: "POST",
          path: "/api/sources/remotes/{serviceId}/links/{linkId}/url",
        },
      }),
    ),
  /**
   * 改备注（§33.10）：远程服务 `links.update`；它不报 `links.update` 能力时答
   * `not_implemented`。答改过之后的这条链接。
   */
  shareLinkUpdate: oc
    .input(shareLinkUpdateInputSchema)
    .output(z.object({ link: shareLinkSchema }))
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.17",
        contract: "§33.10",
        legacy: {
          method: "PUT",
          path: "/api/sources/remotes/{serviceId}/links/{linkId}",
        },
      }),
    ),
  /** 远程服务撤链接（连同它名下的访客），本机作废那张邀请、删存着的整条链接。 */
  shareLinkRevoke: oc
    .input(shareLinkRefSchema)
    .output(empty)
    .errors({
      ...denied,
      ...errors.pick(
        "not_found",
        "source_unauthorized",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(
      meta({
        scope: "settings:write",
        since: "1.16",
        contract: "§33.9",
        legacy: {
          method: "DELETE",
          path: "/api/sources/remotes/{serviceId}/links/{linkId}",
        },
      }),
    ),
};

export type ClientSource = z.infer<typeof clientSourceSchema>;
export type ClientSourceRoute = z.infer<typeof clientSourceRouteSchema>;
export type SourceRouteRef = z.infer<typeof sourceRouteRefSchema>;
export type RemoteService = z.infer<typeof remoteServiceSchema>;
export type RemoteSourceSummary = z.infer<typeof remoteSourceSummarySchema>;
export type SourceSession = z.infer<typeof sourceSessionSchema>;
export type RemoteAddInput = z.infer<typeof remoteAddInputSchema>;
export type MountByLinkInput = z.infer<typeof mountByLinkInputSchema>;
export type ShareLink = z.infer<typeof shareLinkSchema>;
export type ShareTarget = z.infer<typeof shareTargetSchema>;
export type ShareLinkState = z.infer<typeof shareLinkStateSchema>;
export type ShareLinkCreateInput = z.infer<typeof shareLinkCreateInputSchema>;
export type ShareLinkUpdateInput = z.infer<typeof shareLinkUpdateInputSchema>;
