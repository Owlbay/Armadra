/**
 * 个人中转的分享链接（cloud 契约 §10）：
 *
 *  - 网页链接 `<issuer>/j/<linkId>#<秘密>.<core 邀请令牌>`（二维码里是它）；
 *  - 深链 `armadra://join?link=<linkId>&issuer=<issuer>&s=<片段>`。
 *
 * 秘密是 base64url（没有 `.`），邀请令牌自己带点，所以按第一个点切。链接只在
 * 这里解析，不进日志、不进存储。
 */
export interface JoinLink {
  /** `https://host[:port]`（回环上的 `http` 只给开发）。 */
  readonly issuer: string;
  readonly linkId: string;
  readonly secret: string;
  readonly invitationToken: string;
}

const LINK_ID = /^[A-Za-z0-9_-]{8,128}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN = /^[A-Za-z0-9._~-]{16,512}$/;

function loopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/** 规范成签发方来源：HTTPS，回环上允许 HTTP；带路径、查询、片段、口令的不要。 */
export function issuerOrigin(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    );
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "http:" && !loopback(url.hostname)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

function fragmentOf(secretAndToken: string): {
  secret: string;
  invitationToken: string;
} | null {
  const dot = secretAndToken.indexOf(".");
  if (dot <= 0) return null;
  const secret = secretAndToken.slice(0, dot);
  const invitationToken = secretAndToken.slice(dot + 1);
  return SECRET.test(secret) && TOKEN.test(invitationToken)
    ? { secret, invitationToken }
    : null;
}

/** 认不出（含不是分享链接）是 `null`。 */
export function parseJoinLink(text: string): JoinLink | null {
  const value = text.trim();
  if (value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "armadra:") {
    if (url.hostname !== "join") return null;
    const issuer = issuerOrigin(url.searchParams.get("issuer") ?? "");
    const linkId = url.searchParams.get("link") ?? "";
    const parts = fragmentOf(url.searchParams.get("s") ?? "");
    return issuer !== null && LINK_ID.test(linkId) && parts !== null
      ? { issuer, linkId, ...parts }
      : null;
  }
  const issuer = issuerOrigin(url.origin);
  const found = /^\/j\/([^/]+)\/?$/.exec(url.pathname);
  if (issuer === null || found === null) return null;
  const linkId = decodeURIComponent(found[1]!);
  const parts = fragmentOf(url.hash.replace(/^#/, ""));
  return LINK_ID.test(linkId) && parts !== null
    ? { issuer, linkId, ...parts }
    : null;
}

export function isJoinLink(text: string): boolean {
  return parseJoinLink(text) !== null;
}

/** 同一条链接的深链写法（`armadra://join`），给「在应用里打开」。 */
export function joinDeepLink(link: JoinLink): string {
  const query = new URLSearchParams({
    link: link.linkId,
    issuer: link.issuer,
    s: `${link.secret}.${link.invitationToken}`,
  });
  return `armadra://join?${query.toString()}`;
}
