/**
 * 壳收到的分享深链（客户端包 §6.2）：`armadra://join?link=<id>&issuer=<签发方>&s=<片段>`。
 *
 * 壳只认形状、原样转交给页面（`app:join-link` 只是「有一条」的提醒，页面经
 * `app:take-join-link` 取走）——解析、核对与挂载都在页面与 core 里，页面上要人点
 * 「加入」才挂。别的 `armadra://` 深链、超长的、缺参数的一律不认。链接带着秘密，
 * 这里不记日志。
 */

/** 深链的最大长度（与 core 契约 §33.7 入参的上限一致）。 */
export const JOIN_LINK_MAX = 4096;

const PREFIX = "armadra://join?";

/** 认得出就答原样的那一条，否则 `null`。 */
export function deepJoinLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > JOIN_LINK_MAX || !value.startsWith(PREFIX)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const query = url.searchParams;
  for (const name of ["link", "issuer", "s"]) {
    if ((query.get(name) ?? "") === "") return null;
  }
  return value;
}

/**
 * 启动参数里的分享深链（Windows 与 Linux 由系统把深链放进 argv 启动；macOS
 * 走 `open-url` 事件）。有几条取最后一条。
 */
export function joinLinkFromArgv(argv: readonly string[]): string | null {
  let found: string | null = null;
  for (const arg of argv) {
    const link = deepJoinLink(arg);
    if (link !== null) found = link;
  }
  return found;
}

/**
 * 待转交的那一条：壳收到就记下并提醒页面，页面取走即清（页面还没挂好时提醒
 * 丢了也不要紧——挂好时自己来取）。同一时间只留最新的一条。
 */
export class PendingJoinLink {
  private value: string | null;

  constructor(initial: string | null = null) {
    this.value = initial;
  }

  offer(url: unknown): boolean {
    const link = deepJoinLink(url);
    if (link === null) return false;
    this.value = link;
    return true;
  }

  take(): string | null {
    const value = this.value;
    this.value = null;
    return value;
  }
}
