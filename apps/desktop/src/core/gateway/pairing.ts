/**
 * 配对票的二维码与深链载荷（架构 §7，契约 §17）。
 *
 *   * 网页：`https://<host>:<port>/#pair=<票>&fp=<指纹>`。票只进片段——片段不上
 *     请求行，于是不进任何访问日志，也不进 `Referer`。
 *   * 原生：`armadra://pair?host=<host:port>&ticket=<票>&fp=<指纹>`。App 按 `fp`
 *     钉信任锚（有本地 CA 时是 CA，指定文件时是叶证书），不装 CA。
 *
 * 票两分钟、一次性（`identity/service.ts` 的 `BOOTSTRAP_TTL_MS`），绑在 `origin`
 * 上：用别的来源兑换是 401。
 */

export interface PairingTicket {
  readonly ticket: string;
  readonly expiresAtMs: number;
  /** 票绑定的 Gateway 来源。 */
  readonly origin: string;
  /** 信任锚 DER 的 SHA-256，小写十六进制。 */
  readonly fingerprint: string;
  readonly webUrl: string;
  readonly deepLink: string;
}

export function pairingLinks(
  origin: string,
  ticket: string,
  fingerprint: string,
): { webUrl: string; deepLink: string } {
  const host = new URL(origin).host;
  const query = new URLSearchParams({ host, ticket, fp: fingerprint });
  return {
    webUrl: `${origin}/#pair=${ticket}&fp=${fingerprint}`,
    deepLink: `armadra://pair?${query.toString()}`,
  };
}

/** 契约 §17 的线上形状：`POST /api/gateway/pairing` 的回答。 */
export function pairingJson(ticket: PairingTicket): Record<string, unknown> {
  return {
    origin: ticket.origin,
    ticket: ticket.ticket,
    fingerprint: ticket.fingerprint,
    expiresAt: new Date(ticket.expiresAtMs).toISOString(),
    webUrl: ticket.webUrl,
    deepLink: ticket.deepLink,
  };
}
