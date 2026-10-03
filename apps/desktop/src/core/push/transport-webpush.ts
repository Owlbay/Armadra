import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type VapidKeys,
  encryptWebPush,
  generateVapidKeys,
  validP256PublicKey,
  vapidAuthorization,
} from "./crypto";
import {
  type PushSender,
  SENT,
  encodePayload,
  failed,
  retryable,
} from "./types";

/**
 * Web Push（第 1 期，外部服务 §5.2）：VAPID（RFC 8292）签名、aes128gcm
 * （RFC 8291）加密，直发浏览器厂商的推送端点。零第三方、零用户条件。
 */

export function vapidFile(dataDir: string): string {
  return join(dataDir, "push", "vapid.json");
}

/**
 * 读 `<数据目录>/push/vapid.json`，没有就生成一对写进去（0600）。
 *
 * 文件坏了**不**悄悄重新生成：浏览器的订阅绑在旧公钥上，换钥等于让所有已订阅
 * 的浏览器静默失效。坏文件抛错，由调用方把 Web Push 标成不可用。
 */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const file = vapidFile(dataDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const keys = generateVapidKeys();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      `${JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows：模式位没有意义，ACL 由数据目录继承。
    }
    return keys;
  }
  const parsed = JSON.parse(raw) as Partial<VapidKeys>;
  if (
    typeof parsed.publicKey !== "string" ||
    typeof parsed.privateKey !== "string" ||
    !validP256PublicKey(parsed.publicKey)
  ) {
    throw new Error(`${file} 不是一对 VAPID 密钥`);
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

export interface WebPushOptions {
  readonly keys: VapidKeys;
  /** `mailto:` 或 https，厂商据此联系发送方。 */
  readonly subject: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** 秒。通知在厂商那里排队多久之后作废。 */
  readonly ttlSeconds?: number;
}

export function webPushSender(options: WebPushOptions): PushSender {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async send(device, payload) {
      let body: Buffer;
      try {
        body = encryptWebPush(
          encodePayload(payload),
          device.publicKey,
          device.authSecret,
        );
      } catch (error) {
        return failed(`encrypt: ${(error as Error).message}`);
      }
      let response: Response;
      try {
        response = await doFetch(device.token, {
          method: "POST",
          headers: {
            authorization: vapidAuthorization(
              device.token,
              options.keys,
              options.subject,
              now(),
            ),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(options.ttlSeconds ?? 3600),
            urgency: payload.kind === "approval" ? "high" : "normal",
            // RFC 8030 §5.4：同一个 topic 的未送达消息被新的替换。≤ 32 个
            // base64url 字符。
            topic: topicOf(payload.tag),
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return failed(`network: ${(error as Error).message}`, { retry: true });
      }
      await response.arrayBuffer().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return SENT;
      return failed(`webpush ${response.status}`, {
        retry: retryable(response.status),
        // 404 / 410：订阅已经不在了（RFC 8030 §7.3）。
        gone: response.status === 404 || response.status === 410,
      });
    },
  };
}

/** tag 的摘要：topic 只收 32 个 base64url 字符，截断原文会让前缀相同的撞车。 */
function topicOf(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}
