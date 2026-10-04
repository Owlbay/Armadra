import { createHash } from "node:crypto";
import { sealPayload } from "./crypto";
import {
  type PushSender,
  SENT,
  encodePayload,
  failed,
  retryable,
} from "./types";

/**
 * UnifiedPush（契约 §27.2，外部服务 §5.2 的「可选」那一期）。
 *
 * 没有 Google 服务的 Android 手机靠用户自己挑的分发器（自托管 ntfy 等）收推送：
 * App 向分发器要一个端点 URL，登记时交给 core（`unifiedpush.endpoint`），core
 * 往那个 URL POST 正文，分发器把正文原样交给手机上的 App。
 *
 * 端点是**用户给的地址**，不是这张出站表里的固定主机（`net/outbound.ts` 的
 * `unifiedPush`）。分发器再怎么是用户自己的，它也是一台服务器：正文一律是对
 * 设备公钥封好的信封（与中继、FCM 同一种，契约 §19.5），分发器只看得到密文。
 *
 * 线上形状：
 *
 *     POST <endpoint>
 *     Content-Type: application/json
 *     TTL: 3600            （RFC 8030 的头，分发器可以不认）
 *     Urgency: high|normal
 *     Topic: <tag 的摘要>
 *     { "v": 1, "alg": "x25519-hkdf-sha256-a256gcm", "epk", "salt", "iv", "ct" }
 *
 *     → 2xx              收下
 *     → 404 / 410        端点已注销：设备登记撤销
 *     → 413              太大（UnifiedPush 上限 4096 字节；信封远小于它）
 *     → 429 / 5xx        值得再试
 */

/** UnifiedPush 规定分发器至少收 4096 字节的正文。 */
export const UNIFIEDPUSH_MAX_BODY = 4096;

export interface UnifiedPushOptions {
  readonly fetch?: typeof fetch;
  /** 秒。通知在分发器那里排队多久之后作废。 */
  readonly ttlSeconds?: number;
}

export function unifiedPushSender(
  options: UnifiedPushOptions = {},
): PushSender {
  const doFetch = options.fetch ?? fetch;
  return {
    async send(device, payload) {
      const endpoint = device.unifiedpushEndpoint;
      if (endpoint === "") return failed("unifiedpushMissingEndpoint");
      if (device.publicKey === "") {
        // 登记时已经拦过；这里再守一次，明文永远不交给分发器。
        return failed("unifiedpushRequiresPublicKey");
      }
      const body = JSON.stringify(
        sealPayload(encodePayload(payload), device.publicKey),
      );
      if (Buffer.byteLength(body) > UNIFIEDPUSH_MAX_BODY) {
        return failed("unifiedpushPayloadTooLarge");
      }
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ttl: String(options.ttlSeconds ?? 3600),
            urgency: payload.kind === "approval" ? "high" : "normal",
            topic: topicOf(payload.tag),
          },
          body,
          // 用户给的地址：不跟随重定向，免得一条 3xx 把密文送到别处。
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return failed(`network: ${(error as Error).message}`, { retry: true });
      }
      await response.arrayBuffer().catch(() => undefined);
      if (response.status >= 200 && response.status < 300) return SENT;
      const gone = response.status === 404 || response.status === 410;
      return failed(`unifiedpush ${response.status}`, {
        gone,
        retry: !gone && retryable(response.status),
      });
    },
  };
}

/** 与 Web Push 同一种 Topic：tag 的摘要，≤ 32 个 base64url 字符。 */
function topicOf(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}
