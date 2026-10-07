import { z } from "zod";

/**
 * Push notifications (contract §19, docs/design/completion-architecture.md §10).
 *
 * The core decides who is told what; the page and the native apps only
 * register a device and render what arrives. A notification carries a title,
 * a short body and a deep link — never terminal output or file contents.
 */

/**
 * How a notification leaves the core for a **native app**: straight to APNs /
 * FCM, through the relay, or — when neither is configured — a debug log line.
 * Browsers always use Web Push, independently of this.
 */
export const PUSH_TRANSPORTS = ["direct", "relay", "log"] as const;
export const pushTransportSchema = z.enum(PUSH_TRANSPORTS);

export type PushTransport = (typeof PUSH_TRANSPORTS)[number];

export const PUSH_PLATFORMS = ["web", "ios", "android"] as const;
export const pushPlatformSchema = z.enum(PUSH_PLATFORMS);

/** The route one device is reached by. `webpush` is browsers only. */
export const PUSH_DEVICE_TRANSPORTS = ["webpush", "direct", "relay"] as const;
export const pushDeviceTransportSchema = z.enum(PUSH_DEVICE_TRANSPORTS);

export const PUSH_KINDS = [
  "approval",
  "agentDone",
  "agentError",
  "deliveryFailed",
  "schedule",
  "resources",
  "comment",
  "workflowGate",
  "test",
] as const;
export const pushKindSchema = z.enum(PUSH_KINDS);
export type PushKind = (typeof PUSH_KINDS)[number];

/**
 * The kinds a device can switch off (§27.1). `test` is not one of them: a
 * person who asks for a test notification wants to see it.
 */
export const PUSH_PREFERENCE_KINDS = PUSH_KINDS.filter(
  (kind): kind is Exclude<PushKind, "test"> => kind !== "test",
);
export type PushPreferenceKind = (typeof PUSH_PREFERENCE_KINDS)[number];
export const pushPreferenceKindSchema = z.enum(
  PUSH_PREFERENCE_KINDS as [PushPreferenceKind, ...PushPreferenceKind[]],
);

/** `GET /api/push/config` (§19.1). */
export const pushConfigSchema = z.object({
  webpush: z.object({
    enabled: z.boolean(),
    /** VAPID public key: uncompressed P-256 point, base64url. */
    publicKey: z.string().nullable(),
  }),
  native: z.object({
    transport: pushTransportSchema,
    status: z.enum(["ready", "notConfigured"]),
    /** Which native platforms can be reached right now. */
    platforms: z.array(z.enum(["ios", "android"])),
  }),
});
export type PushConfig = z.infer<typeof pushConfigSchema>;

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** `PUT /api/push/devices` body for a browser (§19.2). */
export const webPushRegistrationSchema = z.object({
  platform: z.literal("web"),
  transport: z.literal("webpush"),
  /** `PushSubscription.toJSON()` minus `expirationTime`. */
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: base64url, auth: base64url }),
  }),
  appVersion: z.string().max(64).optional(),
  locale: z.enum(["zh-CN", "en"]).optional(),
});

/** `PUT /api/push/devices` body for a native app (§19.2, §27.2). */
export const nativePushRegistrationSchema = z
  .object({
    platform: z.enum(["ios", "android"]),
    transport: z.enum(["direct", "relay"]),
    /**
     * APNs / FCM token for `direct`, the relay token for `relay`. May be left
     * out by an Android app that only has a UnifiedPush endpoint.
     */
    token: z.string().min(1).max(4096).optional(),
    /**
     * The device's X25519 public key (32 bytes, base64url). Required for relay
     * and for UnifiedPush.
     */
    publicKey: base64url.optional(),
    /**
     * Android only: the endpoint the user's own UnifiedPush distributor (ntfy
     * and the like) handed out. When present, notifications go there instead
     * of `transport`, always sealed to `publicKey`.
     */
    unifiedpush: z.object({ endpoint: z.string().url().max(4096) }).optional(),
    appVersion: z.string().max(64).optional(),
    locale: z.enum(["zh-CN", "en"]).optional(),
  })
  .refine((value) => value.token !== undefined || value.unifiedpush, {
    message: "token or unifiedpush is required",
  });

export const pushRegistrationSchema = z.union([
  webPushRegistrationSchema,
  nativePushRegistrationSchema,
]);
export type PushRegistration = z.infer<typeof pushRegistrationSchema>;

/** One registered device as the API shows it: no token, no key material. */
export const pushDeviceSchema = z.object({
  deviceId: z.string(),
  platform: pushPlatformSchema,
  transport: pushDeviceTransportSchema,
  appVersion: z.string(),
  locale: z.string(),
  /** Whether what reaches the vendor is ciphertext. */
  encrypted: z.boolean(),
  /** The kinds this device receives (§27.1); every kind until narrowed. */
  kinds: z.array(pushPreferenceKindSchema).optional(),
  /** Notifications reach this device through UnifiedPush (§27.2). */
  unifiedpush: z.boolean().optional(),
  createdAt: z.string().datetime({ offset: true }),
  /** This is the device the request came from. */
  current: z.boolean(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

export const pushDeviceResponseSchema = z.object({ device: pushDeviceSchema });
export const pushDeviceListSchema = z.object({
  devices: z.array(pushDeviceSchema),
});
/** `PATCH /api/push/devices/{deviceId}` body (§27.1). */
export const pushDevicePreferencesSchema = z.object({
  kinds: z.array(pushPreferenceKindSchema),
});
export type PushDevicePreferences = z.infer<typeof pushDevicePreferencesSchema>;

export const pushRevokeResponseSchema = z.object({ revoked: z.boolean() });
export const pushTestResponseSchema = z.object({
  queued: z.literal(true),
  id: z.string(),
});

/**
 * The notification itself (§19.4) — what the service worker shows, and what a
 * native app finds after decrypting the envelope. Nothing beyond these keys.
 */
export const pushPayloadSchema = z
  .object({
    v: z.literal(1),
    kind: pushKindSchema,
    title: z.string().max(64),
    body: z.string().max(120),
    /**
     * `armadra://w/<workspaceId>[/n/<nodeId>][?s=<sourceId>]`, or `armadra://`.
     * `s` is the issuing core's `hostId` (§19.4); older cores omit it.
     */
    url: z.string().startsWith("armadra://"),
    tag: z.string().max(128),
  })
  .strict();
export type PushPayload = z.infer<typeof pushPayloadSchema>;
