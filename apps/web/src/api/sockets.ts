import { runtimeSocketUrl } from "./runtime-url";
import { query } from "./request";
import { type Source, currentSource } from "./source";

/* ------------------------------- WebSocket URL ---------------------------- */

/**
 * WebSocket 的基址不一定等于 HTTP 的基址：桌面壳里 Runtime 的端口由内核分配，
 * 两个基址都由壳在页面加载前一并给出（electron-migration §2.1）；经中继的源
 * 是中继的 `wss://`。所以基址取源的 `wsBase`，每个地址现算，不在模块里留一份。
 * `source` 省略是当前源。
 */
function socketUrl(pathname: string, source: Source): string {
  return runtimeSocketUrl(source.wsBase, pathname);
}

/**
 * `writerId` 让 Runtime 在 `hello` 里带回这个客户端已经落地的输入序号，
 * 重连时只重发没落地的那几条（见 `terminal/input-log.ts`）。
 */
export function terminalWebSocketUrl(
  sessionId: string,
  writerId?: string,
  source: Source = currentSource(),
): string {
  const base = socketUrl(`/api/terminals/${sessionId}/ws`, source);
  return writerId ? `${base}?writer=${query(writerId)}` : base;
}

/**
 * 工作空间事件流：agent.status / agent.approval / terminal.exit / board.changed。
 *
 * 带 `cursor` 时 core 先把那个序号之后的那一段补发出来，再接上实时扇出
 * （R4c）。补发的帧之后各跟一条 `{"type":"cursor",…}` 控制帧——它只发给带
 * 游标的订阅，所以不带游标的那条路上一个字节都没变。
 *
 * `"now"` 是「我还没有位置」：不补发任何历史，只报一次当前水位。页面第一次
 * 连上时用它，断线重连时用记下的那个数。
 */
export function workspaceEventsUrl(
  workspaceId: string,
  cursor?: number | "now",
  source: Source = currentSource(),
): string {
  const base = socketUrl(`/api/workspaces/${workspaceId}/events`, source);
  return cursor === undefined ? base : `${base}?cursor=${cursor}`;
}

/**
 * 远程浏览器节点的画面流（R6c）。
 *
 * 只有服务器壳答这条：那边没有窗口，页面在 core 起的 headless Chromium 里。
 * 桌面壳里浏览器节点是本窗口的一个 `<webview>`，这条路由回 501，页面也不会
 * 去开它。一个节点同时只接受一个观看者，第二个在升级之前就被回 409。
 */
export function browserStreamUrl(
  workspaceId: string,
  nodeId: string,
  source: Source = currentSource(),
): string {
  return socketUrl(
    `/api/workspaces/${workspaceId}/browser/${query(nodeId)}/stream`,
    source,
  );
}

/**
 * 一个语言会话一条 WebSocket（语言服务设计 §2.9）。
 *
 * 文本帧就是一条 JSON-RPC 消息。不复用工作空间事件流：那条是单向推送，
 * 而会话必须能往上发；会话*状态*仍走事件流，所以状态栏和设置页不必为了
 * 看一眼状态就开一条会话 socket。
 */
export function languageSessionUrl(
  workspaceId: string,
  sessionId: string,
  source: Source = currentSource(),
): string {
  return socketUrl(
    `/api/workspaces/${workspaceId}/language/sessions/${query(sessionId)}/stream`,
    source,
  );
}

/**
 * 一块板的实时同步流（契约 §16.1）：二进制帧，`y-protocols` 的 sync 与
 * awareness。页面在 `GET …/realtime` 答 `realtime || enabled` 时才开它。
 */
export function boardSyncUrl(
  workspaceId: string,
  boardId: string,
  source: Source = currentSource(),
): string {
  return socketUrl(
    `/api/workspaces/${query(workspaceId)}/boards/${query(boardId)}/sync`,
    source,
  );
}
