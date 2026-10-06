/**
 * 桌面壳页面经中继访问挂载的源时的 `Origin` 改写（客户端包 §5，契约 §32.3）。
 *
 * 桌面页面的来源是回环（`http://127.0.0.1:<随机端口>`），分享方 core 的隧道准入
 * 只认可信来源与原生 App 的来源，回环一律 403。壳是原生客户端，它代页面把发往
 * 源表里那些中继主机的请求（含 CORS 预检与 WebSocket 升级）的 `Origin` 改成
 * {@link DESKTOP_RELAY_ORIGIN}，再把响应的 CORS 头按页面的真实来源回显。
 *
 * 选 `https://localhost`（原生 App 的来源之一）而不另造一个：core 早就把它当
 * 只走 Bearer、不认 Cookie 的原生客户端（`gateway/admission.ts` 的
 * `NATIVE_APP_ORIGINS`，core 对别的 core 也自称它，`sources/source-client.ts`），
 * 中继边缘的预检名单也认它；另造一个来源要 Gateway、隧道准入、身份域的来源
 * 规范化与中继四处一起认。经隧道的会话照旧绑在中继来源上（准入放行前改写）。
 *
 * 只改源表里中继主机的请求，别的一律不动。不碰 Electron：主进程把
 * `webRequest` 的入参转成这里的调用（`main/remote-trust.ts`）。
 */

export const DESKTOP_RELAY_ORIGIN = "https://localhost";

/** `https://` 与 `wss://` 的地址 → 它的 `https://` 来源；认不出是空串。 */
export function relayOriginOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    return parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

type Headers = Record<string, string>;
type ResponseHeaders = Record<string, string[] | string>;

function find(headers: Readonly<Record<string, unknown>>, name: string) {
  return Object.keys(headers).find((key) => key.toLowerCase() === name);
}

/**
 * 发出去之前：发往中继主机、带着页面来源的请求，`Origin` 换成桌面的原生来源。
 * 答 `null` 表示不动；否则答改好的头与页面的真实来源（回 CORS 头时要用）。
 */
export function rewriteRelayRequest(
  url: string,
  headers: Readonly<Headers>,
  relayOrigins: readonly string[],
): { headers: Headers; pageOrigin: string } | null {
  const target = relayOriginOf(url);
  if (target === "" || !relayOrigins.includes(target)) return null;
  const key = find(headers, "origin");
  if (key === undefined) return null;
  const pageOrigin = headers[key] ?? "";
  if (pageOrigin === "" || pageOrigin === DESKTOP_RELAY_ORIGIN) return null;
  const next: Headers = { ...headers };
  delete next[key];
  next.Origin = DESKTOP_RELAY_ORIGIN;
  return { headers: next, pageOrigin };
}

/**
 * 收到之后：改写过的那个请求的响应，CORS 的允许来源换回页面的真实来源，并带
 * `Vary: Origin`。对端没给允许来源（不是跨源答案、或被拒）就不添——不替它放行。
 */
export function rewriteRelayResponse(
  headers: Readonly<ResponseHeaders>,
  pageOrigin: string,
): ResponseHeaders | null {
  const allow = find(headers, "access-control-allow-origin");
  if (allow === undefined) return null;
  const next: ResponseHeaders = { ...headers };
  delete next[allow];
  next["Access-Control-Allow-Origin"] = [pageOrigin];
  const vary = find(next, "vary");
  const current: string[] = vary === undefined ? [] : [next[vary] ?? []].flat();
  const values = current
    .join(",")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (!values.some((value) => value.toLowerCase() === "origin"))
    values.push("Origin");
  if (vary !== undefined) delete next[vary];
  next.Vary = [values.join(", ")];
  return next;
}
