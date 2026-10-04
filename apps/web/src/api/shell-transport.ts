import { isNativeShell } from "../host/native-session";
import { bearerFetch, ticketedWebSocket } from "../mobile/native-bridge";
import {
  currentAccessToken,
  renewShellBearer,
  shellBearer,
  shellWsTicket,
} from "./identity";
import { RUNTIME_URL } from "./request";
import { resolveSocketBase } from "./runtime-url";

/**
 * 桌面壳的请求层（契约 §3.2，安全审查 L9）。
 *
 * core 不再放行回环上没带凭据的请求：本机另一个回环端口上的网页原来能读设置、
 * 开终端、连事件流。所以壳里的页面每一个发往 core 的请求都带票据换来的
 * `Authorization: Bearer`，每一条流都先换一张一次性票，经
 * `Sec-WebSocket-Protocol` 升级——和原生 App 经 Gateway 的做法是同一套
 * （`mobile/native-bridge.ts` 的 {@link bearerFetch} 与
 * {@link ticketedWebSocket}），只是凭据的来路不同：还没有会话就向壳要票配对，
 * 401 时复核、刷新或重新要票，然后只重发一次。
 *
 * 装在全局的 `fetch` 与 `WebSocket` 上：`api/*`、终端、事件流、实时同步、语言
 * 服务、浏览器画面、资源图片，调用点一个都不用知道自己在壳里。只改写发往这台
 * core 的请求，别处的原样放过。
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
  const scope = globalThis as {
    fetch: typeof fetch;
    WebSocket: typeof WebSocket;
  };
  const transport = {
    origin,
    socketOrigin,
    authorization: currentAccessToken,
    prepare: async () => {
      await shellBearer();
    },
    wsTicket: shellWsTicket,
    refresh: async (rejected?: string) =>
      (await renewShellBearer(rejected ?? currentAccessToken())) !== "",
  };
  scope.fetch = bearerFetch(scope.fetch.bind(globalThis), transport);
  scope.WebSocket = ticketedWebSocket(scope.WebSocket, transport);
  return true;
}
