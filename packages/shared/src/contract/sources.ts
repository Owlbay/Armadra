import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `sources.*`（契约 §33）：这台 core 作为「客户端宿主」记住的别的源，以及它
 * 登记过 / 能登录的远程服务。全部 owner 专用：读 `settings:read`，写
 * `settings:write`。
 *
 * 形状与协议包 `core-api/sources.ts` 同形（协议包还没发布，这里按同一份写；
 * 发布后改为从协议包 import 同一组对象）。凭据只在 core 的 SecretStore，答案里
 * 只有 `hasCredentials`——刷新令牌、口令从不出现在任何出参里。
 */

const hex32 = z.string().regex(/^[0-9a-f]{32}$/);

export const clientSourceKindSchema = z.enum([
  "local",
  "direct",
  "relayed",
  "hosted",
]);
export const remoteServiceKindSchema = z.enum(["personal", "saas"]);
export const sourceViaSchema = z.enum(["direct", "relayed"]);

export const clientSourceSchema = z.object({
  sourceId: hex32,
  kind: clientSourceKindSchema,
  label: z.string(),
  baseUrl: z.string(),
  relayOrigin: z.string(),
  fingerprint: z.string(),
  cloudIssuer: z.string(),
  principalHint: z.string(),
  addedAtMs: z.number().int(),
  lastOkAtMs: z.number().int(),
  orderIndex: z.number().int(),
  hasCredentials: z.boolean(),
});

export const remoteServiceSchema = z.object({
  serviceId: hex32,
  kind: remoteServiceKindSchema,
  issuer: z.string(),
  label: z.string(),
  accountHint: z.string(),
  fingerprint: z.string(),
  addedAtMs: z.number().int(),
  lastOkAtMs: z.number().int(),
  /** 本机是否登记到它（A2-3 的登记表；没有登记表时恒为 `false`）。 */
  registered: z.boolean(),
  hasCredentials: z.boolean(),
});

/** 远程服务 `me.sources` 的一行，加上本机是否已挂载。 */
export const remoteSourceSummarySchema = z.object({
  sourceId: hex32,
  name: z.string(),
  kind: z.enum(["desktop", "server", "hosted"]),
  online: z.boolean(),
  lastSeenAtMs: z.number().int().nullable(),
  owner: z.boolean(),
  via: z.enum(["owner", "link", "org"]),
  relayOrigin: z.string(),
  coreVersion: z.string(),
  mounted: z.boolean(),
});

export const sourceSessionSchema = z.object({
  accessToken: z.string(),
  accessExpiresAtMs: z.number().int(),
  httpBase: z.string(),
  wsBase: z.string(),
  via: sourceViaSchema,
  relayToken: z.string().optional(),
  relayTokenExpiresAtMs: z.number().int().optional(),
});

const label = z.string().min(1).max(128);
const fingerprint = z.string().regex(/^[0-9a-fA-F:]{64,95}$/);
const sourceRef = z.object({ sourceId: hex32 });
const serviceRef = z.object({ serviceId: hex32 });
const empty = z.object({});

export const remoteAddInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("personal"),
    issuer: z.string().min(1).max(2048),
    account: z.string().min(1).max(256),
    password: z.string().min(1).max(1024),
    label: label.optional(),
    fingerprint: fingerprint.optional(),
  }),
  z.object({
    kind: z.literal("saas"),
    issuer: z.string().min(1).max(2048),
    label: label.optional(),
  }),
]);

const read = (path: string, method: "GET" | "POST" = "GET") =>
  meta({
    scope: "settings:read",
    since: "1.3",
    contract: "§33.1",
    legacy: { method, path },
  });

const write = (
  section: "§33.1" | "§33.2",
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

export const sources = {
  list: oc
    .input(empty.optional())
    .output(
      z.object({
        sources: z.array(clientSourceSchema),
        remotes: z.array(remoteServiceSchema),
      }),
    )
    .errors(denied)
    .meta(read("/api/sources")),
  /** core 代页面完成配对（`POST <origin>/api/identity/pair`），存刷新令牌。 */
  addDirect: oc
    .input(
      z.object({
        pairLink: z.string().max(4096).optional(),
        origin: z.string().max(2048).optional(),
        code: z.string().max(32).optional(),
        fingerprint: fingerprint.optional(),
        label: label.optional(),
      }),
    )
    .output(clientSourceSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "conflict",
        "source_unreachable",
        "source_unauthorized",
        "fingerprint_mismatch",
      ),
    })
    .meta(write("§33.1", "POST", "/api/sources/direct")),
  update: oc
    .input(
      sourceRef.extend({
        label: label.optional(),
        orderIndex: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        baseUrl: z.string().max(2048).optional(),
        relayOrigin: z.string().max(2048).optional(),
      }),
    )
    .output(clientSourceSchema)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(write("§33.1", "PUT", "/api/sources/{sourceId}")),
  /** 删行 + 删 SecretStore；`local` 行答 `conflict`。 */
  remove: oc
    .input(sourceRef)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(write("§33.1", "DELETE", "/api/sources/{sourceId}")),
  /** 只删凭据，保留行（「断开」）。 */
  forget: oc
    .input(sourceRef)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found", "conflict") })
    .meta(write("§33.1", "POST", "/api/sources/{sourceId}/forget")),
  /** 用刷新令牌换一对新令牌（旋转写回），答访问令牌与该走的地址。 */
  session: oc
    .input(sourceRef.extend({ via: sourceViaSchema.optional() }))
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
  remoteAdd: oc
    .input(remoteAddInputSchema)
    .output(
      z.object({
        remote: remoteServiceSchema,
        next: z.union([
          z.literal("ready"),
          z.object({
            deviceCode: z.object({
              userCode: z.string(),
              verificationUrl: z.string(),
              expiresAtMs: z.number().int(),
            }),
          }),
        ]),
      }),
    )
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "credentials_invalid",
        "account_locked",
        "rate_limited",
        "fingerprint_mismatch",
        "source_unreachable",
        "not_implemented",
      ),
    })
    .meta(write("§33.2", "POST", "/api/sources/remotes")),
  remoteDevicePoll: oc
    .input(serviceRef)
    .output(
      z.object({ status: z.enum(["pending", "ready", "denied", "expired"]) }),
    )
    .errors({ ...denied, ...errors.pick("not_found", "not_implemented") })
    .meta(write("§33.2", "POST", "/api/sources/remotes/{serviceId}/poll")),
  /** 删远程服务：尽力登出，删行与凭据。 */
  remoteRemove: oc
    .input(serviceRef)
    .output(empty)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(write("§33.2", "DELETE", "/api/sources/remotes/{serviceId}")),
  remoteSources: oc
    .input(serviceRef)
    .output(z.object({ sources: z.array(remoteSourceSummarySchema) }))
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
    .input(
      serviceRef.extend({
        sourceId: hex32,
        label: label.optional(),
      }),
    )
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
    .input(serviceRef)
    .output(
      z.object({
        accessToken: z.string(),
        accessExpiresAtMs: z.number().int(),
        issuer: z.string(),
        capabilities: z.array(z.string()),
      }),
    )
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
};

export type ClientSource = z.infer<typeof clientSourceSchema>;
export type RemoteService = z.infer<typeof remoteServiceSchema>;
export type RemoteSourceSummary = z.infer<typeof remoteSourceSummarySchema>;
export type SourceSession = z.infer<typeof sourceSessionSchema>;
export type RemoteAddInput = z.infer<typeof remoteAddInputSchema>;
