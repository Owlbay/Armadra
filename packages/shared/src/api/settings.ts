import { z } from "zod";
import {
  AGENT_DRIVER_CHOICES,
  BREACH_CHECK_CHOICES,
  COMPLETION_SETTINGS_DEFAULTS,
  GATEWAY_LISTEN_CHOICES,
  GATEWAY_TLS_SOURCES,
  MAX_OAUTH_PROVIDERS,
  MFA_REQUIRE_CHOICES,
  OAUTH_PROVIDER_KINDS,
  PASSWORD_MIN_LENGTH_RANGE,
  PUSH_TRANSPORT_CHOICES,
  UPDATE_CHANNEL_CHOICES,
} from "../completion-settings.js";

export * from "../completion-settings.js";

/**
 * `GET /api/settings/local` — which settings belong to this execution host
 * rather than to the account (Go Host 业务所有权迁移 §1.4).
 *
 * The list is served by the Runtime rather than declared here, because the
 * Runtime is what enforces it: a second copy in the front end would be a
 * second answer to "does this key travel", and the two would drift the first
 * time somebody added a key to one of them.
 *
 * A path here is dotted and matches by prefix — `language.servers` covers
 * `language.servers.rust.path` — which is the same rule the Runtime's own
 * split applies.
 */
export const localSettingsSchema = z.object({
  paths: z.array(z.string()).default([]),
  /** Where the file is, so the page can say it rather than imply it. */
  file: z.string().default(""),
});

export type LocalSettings = z.infer<typeof localSettingsSchema>;

/** Whether a dotted settings path is stored on this machine. */
export function isLocalSettingPath(paths: readonly string[], path: string) {
  return paths.some((local) => path === local || path.startsWith(`${local}.`));
}

/* ------------------------------------------------------------------------- */
/*                  补全计划要读的设置键（G0-3 一次加齐）                         */
/* ------------------------------------------------------------------------- */

/**
 * 补全计划（`docs/design/completion-plan.md` §2 G0-3）各工作包要读的设置键，
 * 在这里一次登记齐，缺省值也在这里：后面的包只读不改这份 schema 与
 * `core/settings/schema.ts`。
 *
 * 规矩与设置文档的其它段相同：手改坏的值**退回缺省**而不是让整份文档解析
 * 失败，所以每个字段都带 `.catch(缺省)`。core 侧 `normalize` 写出的文档必须
 * 被这里原样接受（`core/settings/schema.test.ts` 守）。
 */

const D = COMPLETION_SETTINGS_DEFAULTS;

/** `identity.oauth.providers[]` 的一条。`clientSecret` 不在这里：它在 SecretStore。 */
export const oauthProviderSettingsSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    kind: z.enum(OAUTH_PROVIDER_KINDS),
    /** OIDC 必填（发现文档从这里取）；GitHub 不用。 */
    issuer: z.string().optional(),
    clientId: z.string().min(1).max(512),
    scopes: z.array(z.string().min(1).max(128)).max(32).default([]),
    /** 开着才在首次登录时建 member（这就是 SSO）。 */
    allowSignup: z.boolean().default(false),
    allowedDomains: z.array(z.string().min(1).max(253)).max(64).default([]),
    enabled: z.boolean().default(true),
  })
  .refine(
    (provider) =>
      provider.kind !== "oidc" ||
      (provider.issuer !== undefined &&
        /^https?:\/\/\S+$/.test(provider.issuer)),
    { message: "OIDC provider needs an issuer URL", path: ["issuer"] },
  );

export type OAuthProviderSettings = z.infer<typeof oauthProviderSettingsSchema>;

const fileSetting = z.string().max(4_096).catch("");
const shortSetting = z.string().max(512).catch("");

export const gatewaySettingsSchema = z.looseObject({
  enabled: z.boolean().catch(D.gateway.enabled).default(D.gateway.enabled),
  listen: z
    .enum(GATEWAY_LISTEN_CHOICES)
    .catch(D.gateway.listen)
    .default(D.gateway.listen),
  port: z
    .number()
    .int()
    .min(0)
    .max(65_535)
    .catch(D.gateway.port)
    .default(D.gateway.port),
  publicOrigin: shortSetting.default(D.gateway.publicOrigin),
  tls: z
    .looseObject({
      source: z
        .enum(GATEWAY_TLS_SOURCES)
        .catch(D.gateway.tls.source)
        .default(D.gateway.tls.source),
      certFile: fileSetting.default(""),
      keyFile: fileSetting.default(""),
      acmeEmail: shortSetting.default(""),
    })
    .catch({ ...D.gateway.tls })
    .default({ ...D.gateway.tls }),
});

export const pushSettingsSchema = z.looseObject({
  transport: z
    .enum(PUSH_TRANSPORT_CHOICES)
    .catch(D.push.transport)
    .default(D.push.transport),
  relayUrl: shortSetting.default(""),
  apns: z
    .looseObject({
      keyFile: fileSetting.default(""),
      keyId: shortSetting.default(""),
      teamId: shortSetting.default(""),
      topic: shortSetting.default(""),
      production: z.boolean().catch(false).default(false),
    })
    .catch({ ...D.push.apns })
    .default({ ...D.push.apns }),
  fcm: z
    .looseObject({
      serviceAccountFile: fileSetting.default(""),
      projectId: shortSetting.default(""),
    })
    .catch({ ...D.push.fcm })
    .default({ ...D.push.fcm }),
  webpush: z
    .looseObject({
      enabled: z.boolean().catch(true).default(true),
      subject: shortSetting.default(""),
    })
    .catch({ ...D.push.webpush })
    .default({ ...D.push.webpush }),
});

/**
 * 提供方列表：坏条目丢掉、同 id 留第一条、最多 {@link MAX_OAUTH_PROVIDERS}
 * 条——和 `agents.custom[]` 同一条规矩，手改坏一条不连累其余。
 */
export function oauthProviderList(value: unknown): OAuthProviderSettings[] {
  if (!Array.isArray(value)) return [];
  const kept: OAuthProviderSettings[] = [];
  for (const raw of value) {
    if (kept.length >= MAX_OAUTH_PROVIDERS) break;
    const parsed = oauthProviderSettingsSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (kept.some((provider) => provider.id === parsed.data.id)) continue;
    kept.push(parsed.data);
  }
  return kept;
}

export const identitySettingsSchema = z.looseObject({
  rpId: shortSetting.default(""),
  passwordMinLength: z
    .number()
    .int()
    .min(PASSWORD_MIN_LENGTH_RANGE.min)
    .max(PASSWORD_MIN_LENGTH_RANGE.max)
    .catch(D.identity.passwordMinLength)
    .default(D.identity.passwordMinLength),
  breachCheck: z
    .enum(BREACH_CHECK_CHOICES)
    .catch(D.identity.breachCheck)
    .default(D.identity.breachCheck),
  mfa: z
    .looseObject({
      requireFor: z
        .enum(MFA_REQUIRE_CHOICES)
        .catch(D.identity.mfa.requireFor)
        .default(D.identity.mfa.requireFor),
    })
    .catch({ ...D.identity.mfa })
    .default({ ...D.identity.mfa }),
  oauth: z
    .looseObject({
      providers: z
        .preprocess(oauthProviderList, z.array(oauthProviderSettingsSchema))
        .default([]),
    })
    .catch({ providers: [] })
    .default({ providers: [] }),
});

/**
 * 这几段的形状。只描述 G0-3 加的键：同一段里已有的键（`usage.enabled`、
 * `updates.autoCheck`、`agents.custom` 等）照旧由 `looseObject` 透传。
 */
export const completionSettingsSchema = z.looseObject({
  gateway: gatewaySettingsSchema.catch(() => gatewaySettingsSchema.parse({})),
  push: pushSettingsSchema.catch(() => pushSettingsSchema.parse({})),
  updates: z
    .looseObject({
      channel: z
        .enum(UPDATE_CHANNEL_CHOICES)
        .catch(D.updates.channel)
        .default(D.updates.channel),
    })
    .catch({ ...D.updates })
    .default({ ...D.updates }),
  identity: identitySettingsSchema.catch(() =>
    identitySettingsSchema.parse({}),
  ),
  agents: z
    .looseObject({
      defaultDriver: z
        .enum(AGENT_DRIVER_CHOICES)
        .catch(D.agents.defaultDriver)
        .default(D.agents.defaultDriver),
    })
    .catch({ ...D.agents })
    .default({ ...D.agents }),
  collab: z
    .looseObject({
      realtime: z.boolean().catch(D.collab.realtime).default(D.collab.realtime),
    })
    .catch({ ...D.collab })
    .default({ ...D.collab }),
  usage: z
    .looseObject({
      claudeUsage: z.boolean().catch(false).default(false),
      copilotUsage: z.boolean().catch(false).default(false),
      statusBadges: z.boolean().catch(true).default(true),
    })
    .catch({ ...D.usage })
    .default({ ...D.usage }),
  models: z
    .looseObject({
      catalog: z
        .looseObject({
          autoRefresh: z.boolean().catch(true).default(true),
        })
        .catch({ ...D.models.catalog })
        .default({ ...D.models.catalog }),
    })
    .catch({ catalog: { ...D.models.catalog } })
    .default({ catalog: { ...D.models.catalog } }),
  diagnostics: z
    .looseObject({ crashReportDsn: shortSetting.default("") })
    .catch({ ...D.diagnostics })
    .default({ ...D.diagnostics }),
});

export type CompletionSettings = z.infer<typeof completionSettingsSchema>;
export type GatewaySettings = z.infer<typeof gatewaySettingsSchema>;
export type PushSettings = z.infer<typeof pushSettingsSchema>;
export type IdentitySettings = z.infer<typeof identitySettingsSchema>;
