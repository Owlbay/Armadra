import { isNativeShell } from "../host/native-session";
import {
  currentAccessToken,
  renewShellBearer,
  shellBearer,
  shellWsTicket,
} from "./identity";
import { RUNTIME_URL } from "./request";
import { resolveSocketBase } from "./runtime-url";
import { installLocalTransport } from "./source";

/**
 * 桌面壳的请求层（契约 §3.2，安全审查 L9）。
 *
 * core 不再放行回环上没带凭据的请求：本机另一个回环端口上的网页原来能读设置、
 * 开终端、连事件流。所以壳里的页面每一个发往 core 的请求都带票据换来的
 * `Authorization: Bearer`，每一条流都先换一张一次性票，经
 * `Sec-WebSocket-Protocol` 升级——和原生 App 经 Gateway 的做法是同一套
 * （`mobile/native-bridge.ts` 的 `bearerFetch` 与 `ticketedWebSocket`），只是
 * 凭据的来路不同：还没有会话就向壳要票配对，401 时复核、刷新或重新要票，然后
 * 只重发一次。
 *
 * 凭据装在本机源上（`api/source.ts` 的 `localSource`，工程规范化 §2.3.4），
 * 不改写全局的 `fetch` 与 `WebSocket`：`api/*`、RPC 客户端、终端、事件流、实时
 * 同步、语言服务、浏览器画面、资源图片与下载都经 `localSource` 发往 core。只有
 * 发往这台 core 的请求带凭据，别处的原样放过。
 */
export function installShellTransport(): boolean {
  if (!isNativeShell()) return false;
  let origin: string;
  let socketOrigin: string;
  try {
    origin = new URL(RUNTIME_URL).origin;
    const socket = new URL(resolveSocketBase(RUNTIME_URL));
    socketOrigin = `${socket.protocol === "wss:" ? "https:" : "http:"}//${socket.host}`;
  } catch {
    return false;
  }
  installLocalTransport({
    origin,
    socketOrigin,
    authorization: currentAccessToken,
    prepare: async () => {
      await shellBearer();
    },
    wsTicket: shellWsTicket,
    refresh: async (rejected?: string) =>
      (await renewShellBearer(rejected ?? currentAccessToken())) !== "",
  });
  return true;
}
