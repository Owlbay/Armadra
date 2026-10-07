import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";

/**
 * 桌面壳对「这台 core 记住的远程服务与源」的信任（客户端包 §3，契约 §33）。
 *
 * 页面要直接连这些来源（分享本机时调远程服务、挂载的源经直连或中继连），壳得
 * 做两件事，两件都只看 core 的源表，不信页面说的：
 *
 *   1. `connect-src` 放行这些来源（`csp.ts` 的 `sourceConnectGrants`）；
 *   2. 自签的个人中转与 Gateway 本地 CA：按表里的指纹钉扎——证书链里有一张
 *      信任锚的 DER SHA-256 等于这个主机登记的指纹，且从叶证书逐级验签到它、
 *      主机名与有效期都对，才算可信。与 core 的钉扎同一个定义（契约 §33.5）。
 *
 * 不碰 Electron：主进程把 `setCertificateVerifyProc` 的请求转成这里的入参。
 */

export interface PinnedHost {
  /** 小写主机名（IPv6 不带方括号）。 */
  readonly host: string;
  /** 信任锚指纹，64 位小写十六进制。 */
  readonly fingerprint: string;
}

export interface RemoteTrust {
  /** 要放行的来源（`https://host[:port]`），按字典序去重。 */
  readonly origins: readonly string[];
  readonly pins: readonly PinnedHost[];
  /**
   * 页面要以原生客户端身份去连的来源（按字典序去重）：经中继挂载的源的中继来源，
   * 与直连挂载的源的 Gateway 来源。页面发往它们的请求由壳改写 `Origin`
   * （`relay-origin.ts`）——两处都只认原生来源上的 Bearer，回环来源一律 403。
   */
  readonly rewriteOrigins: readonly string[];
}

export const EMPTY_TRUST: RemoteTrust = {
  origins: [],
  pins: [],
  rewriteOrigins: [],
};

const FINGERPRINT = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function httpsOrigin(value: string): URL | null {
  if (value === "") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function bare(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * `GET /api/sources` 的答案（契约 §33.1 `sources.list`）→ 要放行的来源与钉扎。
 * 认不出的行跳过；整个答案认不出就是空表（什么也不放行）。
 */
export function trustFromSourceTable(answer: unknown): RemoteTrust {
  const body = record(answer);
  const origins = new Set<string>();
  const pins = new Map<string, PinnedHost>();
  const pin = (url: URL, fingerprint: string) => {
    if (!FINGERPRINT.test(fingerprint)) return;
    const host = bare(url.hostname);
    pins.set(`${host} ${fingerprint}`, { host, fingerprint });
  };
  const remotes = Array.isArray(body.remotes) ? body.remotes : [];
  const issuerPins = new Map<string, string>();
  for (const item of remotes) {
    const row = record(item);
    const url = httpsOrigin(text(row.issuer));
    if (url === null) continue;
    origins.add(url.origin);
    pin(url, text(row.fingerprint));
    issuerPins.set(url.origin, text(row.fingerprint));
  }
  const rewriteOrigins = new Set<string>();
  const sources = Array.isArray(body.sources) ? body.sources : [];
  for (const item of sources) {
    const row = record(item);
    if (text(row.kind) === "local") continue;
    const base = httpsOrigin(text(row.baseUrl));
    if (base !== null) {
      origins.add(base.origin);
      // 直连的源：core 以原生来源配对（`core/sources/source-client.ts`），换给页面
      // 的访问令牌绑在 Gateway 的 Bearer 模式上，页面也得以原生来源去连。
      rewriteOrigins.add(base.origin);
      pin(base, text(row.fingerprint));
    }
    const relay = httpsOrigin(text(row.relayOrigin));
    if (relay !== null) {
      origins.add(relay.origin);
      rewriteOrigins.add(relay.origin);
      // 中继就是远程服务本身（个人中转）才沿用它的指纹（契约 §33.5）。
      const inherited = issuerPins.get(relay.origin);
      if (inherited !== undefined) pin(relay, inherited);
    }
  }
  return {
    origins: [...origins].sort(),
    pins: [...pins.values()].sort((a, b) =>
      `${a.host} ${a.fingerprint}`.localeCompare(`${b.host} ${b.fingerprint}`),
    ),
    rewriteOrigins: [...rewriteOrigins].sort(),
  };
}

function fingerprintOf(certificate: X509Certificate): string {
  return createHash("sha256").update(certificate.raw).digest("hex");
}

function current(certificate: X509Certificate, now: number): boolean {
  return (
    Date.parse(certificate.validFrom) <= now &&
    now <= Date.parse(certificate.validTo)
  );
}

/**
 * 对端给的链（叶证书在前，PEM）在这个主机上是否按钉扎可信：链里第 i 张的
 * 指纹等于这个主机登记的某个指纹，叶证书到它逐级验签、每张都在有效期内、叶
 * 证书的名字对得上主机。任何一步不成立都是 `false`——交回系统的判断。
 */
export function pinnedChainTrusted(
  hostname: string,
  chainPem: readonly string[],
  pins: readonly PinnedHost[],
  now: number = Date.now(),
): boolean {
  const host = bare(hostname);
  const wanted = new Set(
    pins.filter((one) => one.host === host).map((one) => one.fingerprint),
  );
  if (wanted.size === 0 || chainPem.length === 0) return false;
  let chain: X509Certificate[];
  try {
    chain = chainPem.map((pem) => new X509Certificate(pem));
  } catch {
    return false;
  }
  const anchor = chain.findIndex((one) => wanted.has(fingerprintOf(one)));
  if (anchor < 0) return false;
  const leaf = chain[0] as X509Certificate;
  const named =
    isIP(host) === 0
      ? leaf.checkHost(host) !== undefined
      : leaf.checkIP(host) !== undefined;
  if (!named) return false;
  for (let index = 0; index <= anchor; index += 1) {
    const certificate = chain[index] as X509Certificate;
    if (!current(certificate, now)) return false;
    // 信任锚自己不必再验它的签发者；其余每张都要由下一张签。
    if (index < anchor) {
      const issuer = chain[index + 1] as X509Certificate;
      if (!certificate.verify(issuer.publicKey)) return false;
    }
  }
  return true;
}

/**
 * `next` 是否放行了 `loaded` 没放行的来源——只有这时页面才必须重载（CSP 只在
 * 文档载入时生效）。少了来源不必重载：多放行一个已删掉的来源，页面也不会再去连。
 */
export function addsOrigins(next: RemoteTrust, loaded: RemoteTrust): boolean {
  return next.origins.some((origin) => !loaded.origins.includes(origin));
}
