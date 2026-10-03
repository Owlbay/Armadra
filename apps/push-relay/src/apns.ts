import {
  ApnsClient,
  type ApnsConfig,
  apnsBody,
  apnsResult,
} from "../../desktop/src/core/push/transport-direct";
import type { PlatformSender } from "./relay";

/**
 * 中继的 iOS 一侧：与 core 直连用的是同一个 HTTP/2 客户端与同一种消息形状
 * （`apnsBody` 的信封分支），所以 App 的 Notification Service Extension 只认一种
 * 消息，不管它是 core 直连发的还是中继转的。
 */
export function apnsSender(config: ApnsConfig): PlatformSender & {
  close(): void;
} {
  const client = new ApnsClient(config);
  return {
    async send(token, envelope, options) {
      const result = apnsResult(
        await client.send(token, apnsBody({ envelope }), {
          ...(options.collapseId === ""
            ? {}
            : { collapseId: options.collapseId }),
          urgent: options.urgent,
        }),
      );
      return result.ok
        ? { ok: true, gone: false, reason: "" }
        : { ok: false, gone: result.gone, reason: result.reason };
    },
    close: () => client.close(),
  };
}
