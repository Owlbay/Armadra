import type { DatabaseSync } from "node:sqlite";
import { validP256PublicKey, validX25519PublicKey, fromB64url } from "./crypto";
import {
  DEVICE_TRANSPORTS,
  type DeviceTransport,
  PUSH_PLATFORMS,
  type PushDevice,
  type PushPlatform,
} from "./types";

/**
 * 推送设备登记（`push_devices`）。
 *
 * 一行挂在一台身份设备（`identity_devices`）上，主键就是那台设备的 id：登记
 * 永远是「这次请求的那台设备」，不能替别的设备登记，所以不存在「我把你的手机
 * 登记到我名下」这种问题。收不收得到某条通知不看这里，看那台设备的 principal
 * 今天对那个工作空间有没有 `canvas:read`（`triggers.ts`）。
 */

export const PUSH_LOCALES = ["zh-CN", "en"] as const;

export interface Registration {
  readonly platform: PushPlatform;
  readonly transport: DeviceTransport;
  readonly token: string;
  readonly publicKey: string;
  readonly authSecret: string;
  readonly appVersion: string;
  readonly locale: string;
}

export type ParsedRegistration =
  | { readonly ok: true; readonly registration: Registration }
  | { readonly ok: false; readonly message: string };

function text(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) return undefined;
  return value;
}

function loopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

/**
 * Web Push 端点必须是 https；只有回环上的 http 放行——那是 dev-stack 的
 * push-sink 与本机测试，不会是浏览器厂商。
 */
function validEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.username !== "" || url.password !== "") return false;
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && loopback(url.hostname))
    );
  } catch {
    return false;
  }
}

/** 请求体 → 一次登记。错误信息是给人看的一句话，码由路由给。 */
export function parseRegistration(body: unknown): ParsedRegistration {
  const fail = (message: string): ParsedRegistration => ({
    ok: false,
    message,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("请求体应是一个对象");
  }
  const input = body as Record<string, unknown>;
  const platform = input.platform;
  const transport = input.transport;
  if (!(PUSH_PLATFORMS as readonly unknown[]).includes(platform)) {
    return fail("platform 应是 web、ios 或 android");
  }
  if (!(DEVICE_TRANSPORTS as readonly unknown[]).includes(transport)) {
    return fail("transport 应是 webpush、direct 或 relay");
  }
  if ((platform === "web") !== (transport === "webpush")) {
    return fail("浏览器只能走 webpush，原生 App 只能走 direct 或 relay");
  }
  const appVersion = text(input.appVersion, 64);
  const localeRaw = text(input.locale, 16);
  if (appVersion === undefined || localeRaw === undefined) {
    return fail("appVersion 或 locale 不合法");
  }
  const locale = (PUSH_LOCALES as readonly string[]).includes(localeRaw)
    ? localeRaw
    : "";

  if (transport === "webpush") {
    const subscription = input.subscription as
      | {
          endpoint?: unknown;
          keys?: { p256dh?: unknown; auth?: unknown };
        }
      | undefined;
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (
      typeof endpoint !== "string" ||
      endpoint.length > 4096 ||
      !validEndpoint(endpoint)
    ) {
      return fail("subscription.endpoint 应是 https 地址");
    }
    if (typeof p256dh !== "string" || !validP256PublicKey(p256dh)) {
      return fail("subscription.keys.p256dh 不是 P-256 公钥");
    }
    if (typeof auth !== "string" || fromB64url(auth).length !== 16) {
      return fail("subscription.keys.auth 应是 16 字节");
    }
    return {
      ok: true,
      registration: {
        platform: platform as PushPlatform,
        transport,
        token: endpoint,
        publicKey: p256dh,
        authSecret: auth,
        appVersion,
        locale,
      },
    };
  }

  const token = input.token;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    // 令牌进 URL 路径（APNs）或 JSON：只收可见 ASCII。
    !/^[\x21-\x7e]+$/.test(token)
  ) {
    return fail("token 应是 1–4096 个可见 ASCII 字符");
  }
  const publicKey = text(input.publicKey, 256);
  if (publicKey === undefined) return fail("publicKey 不合法");
  if (publicKey !== "" && !validX25519PublicKey(publicKey)) {
    return fail("publicKey 应是 32 字节的 X25519 公钥");
  }
  if (transport === "relay" && publicKey === "") {
    // 经中继的载荷必须端到端加密：没有公钥就没有办法不让中继看到正文。
    return fail("经中继推送必须提供设备公钥");
  }
  return {
    ok: true,
    registration: {
      platform: platform as PushPlatform,
      transport: transport as DeviceTransport,
      token,
      publicKey,
      authSecret: "",
      appVersion,
      locale,
    },
  };
}

interface DeviceRow {
  readonly device_id: string;
  readonly principal_id: string;
  readonly platform: string;
  readonly transport: string;
  readonly token: string;
  readonly public_key: string;
  readonly auth_secret: string;
  readonly app_version: string;
  readonly locale: string;
  readonly created_at_ms: number;
  readonly revoked_at_ms: number;
}

const SELECT = `
  SELECT pd.device_id, d.principal_id, pd.platform, pd.transport, pd.token,
         pd.public_key, pd.auth_secret, pd.app_version, pd.locale,
         pd.created_at_ms, pd.revoked_at_ms
    FROM push_devices pd
    JOIN identity_devices d ON d.device_id = pd.device_id`;

function device(row: DeviceRow): PushDevice {
  return {
    deviceId: row.device_id,
    principalId: row.principal_id,
    platform: row.platform as PushPlatform,
    transport: row.transport as DeviceTransport,
    token: row.token,
    publicKey: row.public_key,
    authSecret: row.auth_secret,
    appVersion: row.app_version,
    locale: row.locale,
    createdAtMs: Number(row.created_at_ms),
    revokedAtMs: Number(row.revoked_at_ms),
  };
}

/** 一台设备，以及它所属的 principal 是不是 owner。 */
export interface Recipient {
  readonly device: PushDevice;
  readonly principalKind: string;
}

export class DeviceStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: () => number = Date.now,
  ) {}

  /** 这台身份设备还在、没被撤销。登记只对这样的设备开放。 */
  identityDeviceActive(deviceId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS ok FROM identity_devices d
           JOIN identity_principals p ON p.principal_id = d.principal_id
          WHERE d.device_id = ? AND d.revoked_at_ms = 0 AND p.disabled_at_ms = 0`,
      )
      .get(deviceId) as { ok?: number } | undefined;
    return row?.ok === 1;
  }

  /** 覆盖式登记：同一台设备重新订阅就是换掉这一行，撤销状态一并清掉。 */
  register(deviceId: string, registration: Registration): PushDevice {
    const now = this.clock();
    this.database
      .prepare(
        `INSERT INTO push_devices (device_id, platform, transport, token, public_key,
           auth_secret, app_version, locale, created_at_ms, revoked_at_ms, revoked_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
         ON CONFLICT(device_id) DO UPDATE SET
           platform = excluded.platform, transport = excluded.transport,
           token = excluded.token, public_key = excluded.public_key,
           auth_secret = excluded.auth_secret, app_version = excluded.app_version,
           locale = excluded.locale, created_at_ms = excluded.created_at_ms,
           revoked_at_ms = 0, revoked_reason = ''`,
      )
      .run(
        deviceId,
        registration.platform,
        registration.transport,
        registration.token,
        registration.publicKey,
        registration.authSecret,
        registration.appVersion,
        registration.locale,
        now,
      );
    return this.get(deviceId) as PushDevice;
  }

  get(deviceId: string): PushDevice | undefined {
    const row = this.database
      .prepare(`${SELECT} WHERE pd.device_id = ?`)
      .get(deviceId) as DeviceRow | undefined;
    return row === undefined ? undefined : device(row);
  }

  /** 某个 principal 名下还有效的登记；`undefined` = 全部（owner 看全部）。 */
  list(principalId: string | undefined): PushDevice[] {
    const rows = (principalId === undefined
      ? this.database
          .prepare(
            `${SELECT} WHERE pd.revoked_at_ms = 0 ORDER BY pd.created_at_ms`,
          )
          .all()
      : this.database
          .prepare(
            `${SELECT} WHERE pd.revoked_at_ms = 0 AND d.principal_id = ?
               ORDER BY pd.created_at_ms`,
          )
          .all(principalId)) as unknown as DeviceRow[];
    return rows.map(device);
  }

  /** 撤销；已经撤销的再撤一次什么也不改，返回是否真的改了。 */
  revoke(deviceId: string, reason: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE push_devices SET revoked_at_ms = ?, revoked_reason = ?
          WHERE device_id = ? AND revoked_at_ms = 0`,
      )
      .run(this.clock(), reason.slice(0, 64), deviceId);
    return Number(result.changes) > 0;
  }

  /**
   * 可能收通知的全部设备：登记有效、身份设备没撤销、principal 没停用。权限
   * 过滤在调用方——这里不知道通知是关于哪块画布的。
   */
  recipients(): Recipient[] {
    const rows = this.database
      .prepare(
        `${SELECT.replace("SELECT pd.device_id", "SELECT p.kind AS principal_kind, pd.device_id")}
           JOIN identity_principals p ON p.principal_id = d.principal_id
          WHERE pd.revoked_at_ms = 0 AND d.revoked_at_ms = 0 AND p.disabled_at_ms = 0`,
      )
      .all() as unknown as (DeviceRow & { principal_kind: string })[];
    return rows.map((row) => ({
      device: device(row),
      principalKind: row.principal_kind,
    }));
  }
}
