import {
  FcmClient,
  type FcmConfig,
  fcmMessage,
  fcmResult,
} from "../../desktop/src/core/push/transport-direct";
import type { PlatformSender } from "./relay";

/**
 * 中继的 Android 一侧：FCM v1 数据消息，`data.enc` 是原样转过来的信封——与
 * core 直连同一个客户端、同一种形状（`fcmMessage`）。
 */
export function fcmSender(config: FcmConfig): PlatformSender {
  const client = new FcmClient(config);
  return {
    async send(token, envelope, options) {
      const result = fcmResult(
        await client.send(
          fcmMessage(
            token,
            { envelope },
            // fcmMessage 自己做摘要；中继拿到的已经是 core 的折叠键，再摘一次
            // 仍然稳定（同一个输入同一个输出）。
            options.collapseId,
          ),
        ),
      );
      return result.ok
        ? { ok: true, gone: false, reason: "" }
        : { ok: false, gone: result.gone, reason: result.reason };
    },
  };
}
