import { sealPayload } from "./crypto";
import { collapseKey } from "./transport-direct";
import {
  type PushSender,
  SENT,
  encodePayload,
  failed,
  retryable,
} from "./types";

/**
 * 经中继推送（补全架构 §10 的 `relay`，商店版 App 用）。
 *
 * 商店版 App 的 APNs / FCM 密钥在发布方手里，不能随包发给每个用户的 core；
 * 所以 core 把**已经端到端加密的**信封交给发布方运行的 `apps/push-relay`，由它
 * 转给苹果 / Google。中继看得到的只有：一个中继令牌（平台令牌被中继自己的钥封在
 * 里面，core 也看不到平台令牌）、一个折叠键、是不是紧急、以及密文。
 *
 * 线上形状（中继 v1，`apps/push-relay/README.md`）：
 *
 *     POST <relayUrl>/v1/push
 *     { "relayToken": "…", "envelope": { v, alg, epk, salt, iv, ct },
 *       "collapseId": "…", "urgent": true }
 *     → 202 { "accepted": true }
 *     → 410 { "code": "gone" }        平台说令牌作废
 *     → 400 { "code": "badToken" }    中继令牌解不开
 *     → 502 / 503                     上游失败，值得再试
 *
 * 是否真的运营这台中继由发布方定（架构 §14 Q6：代码写完，暂不上线）。
 */

export interface RelayOptions {
  /** 中继的基地址，例如 `https://push.example.com`。 */
  readonly url: string;
  readonly fetch?: typeof fetch;
}

export function relayEndpoint(base: string): string {
  return `${base.replace(/\/+$/, "")}/v1/push`;
}

export function relaySender(options: RelayOptions): PushSender {
  const doFetch = options.fetch ?? fetch;
  const endpoint = relayEndpoint(options.url);
  return {
    async send(device, payload) {
      if (device.publicKey === "") {
        // 登记时已经拦过；这里再守一次，明文永远不经过中继。
        return failed("relayRequiresPublicKey");
      }
      const envelope = sealPayload(encodePayload(payload), device.publicKey);
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            relayToken: device.token,
            envelope,
            collapseId: collapseKey(payload.tag),
            urgent: payload.kind === "approval",
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return failed(`network: ${(error as Error).message}`, { retry: true });
      }
      const answer = (await response.json().catch(() => ({}))) as {
        code?: unknown;
      };
      if (response.status >= 200 && response.status < 300) return SENT;
      // 解不开的中继令牌（中继换了钥）与平台说作废的令牌一样：这台设备得重新
      // 登记，再试多少次都一样。
      const gone =
        response.status === 410 ||
        (response.status === 400 && answer.code === "badToken");
      return failed(`relay ${response.status}`, {
        gone,
        retry: !gone && retryable(response.status),
      });
    },
  };
}
