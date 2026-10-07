import type { CoreLog } from "../platform";
import { type PushSender, SENT } from "./types";

/**
 * 没配置时的传输：只写一行 debug 日志，接口照常答 `queued`（补全架构 §10）。
 *
 * 日志里只有种类与设备，不写标题和正文——它们虽然不含终端原文，但日志是会被
 * 人贴出去的东西，没有必要多带一句别人的工作空间名。
 */
export function logSender(log: CoreLog, why: string): PushSender {
  return {
    send(device, payload) {
      log.debug("推送未配置，只记一笔", {
        why,
        kind: payload.kind,
        deviceId: device.deviceId,
        transport: device.transport,
      });
      return Promise.resolve(SENT);
    },
  };
}
