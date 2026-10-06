/**
 * 客户端源与远程服务的出站 HTTP（契约 §33，外呼登记 `cloudApi` / `sourceGateway`）。
 *
 * 一次请求一个 JSON 答案，带超时；地址只收 `https:`，回环主机另收 `http:`（探针
 * 与同机明文终止）。给了指纹就**钉扎**：信任锚 DER 的 SHA-256（小写十六进制、
 * 无分隔符，与 Gateway `tls.source = localCa`、个人中转 `/ca.crt` 同一定义）。
 *
 * 钉扎分两步，而不是在一条不验证的连接上自己比证书：
 *
 *   1. 先不验证地握一次手，从对端发来的链里找指纹相符的那张；链里没有（服务端
 *      只发叶证书）就取 `GET /ca.crt`，比它的指纹。都对不上 → `fingerprint_mismatch`。
 *   2. 真请求以那一张作为唯一的 `ca`、照常验证（链与主机名都验）。对端拿一张
 *      公开的 CA 配自己的叶证书冒充，第 2 步验链不过，同样是 `fingerprint_mismatch`。
 *
 * 不给指纹就用系统信任（ACME / 公网证书）。答案与错误里从不带请求体：口令、
 * 刷新令牌只出现在发出去的那一次请求里。
 */

import { createHash, X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";

import { fail } from "../http/errors";

export interface OutboundRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON 体；`undefined` 不发体。 */
  readonly body?: unknown;
  /** 信任锚指纹；空串 = 系统信任。 */
  readonly fingerprint: string;
  readonly timeoutMs: number;
}

export interface OutboundAnswer {
  readonly status: number;
  /** JSON 解析后的体；不是 JSON 时是 `undefined`。 */
  readonly body: unknown;
}

/** 可替换的发送点：测试换成假的远程服务。 */
export type Transport = (request: OutboundRequest) => Promise<OutboundAnswer>;

/** 64 位小写十六进制；接受带冒号或大写的写法，存与比的一律是规范拼法。 */
export function normalizeFingerprint(value: string | undefined): string {
  if (value === undefined) return "";
  const compact = value.replace(/:/g, "").trim().toLowerCase();
  if (compact === "") return "";
  if (!/^[0-9a-f]{64}$/.test(compact)) {
    throw fail("bad_request", "指纹应为 64 位十六进制");
  }
  return compact;
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;
  const version = isIP(host);
  if (version === 4) return host.startsWith("127.");
  if (version === 6) return host === "::1";
  return false;
}

/**
 * 一个来源的规范拼法：`https://host[:port]`，无路径、无尾斜杠。`http:` 只许回环。
 */
export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw fail("bad_request", "地址不是一个合法的 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw fail("bad_request", "地址只收 https");
  }
  if (url.protocol === "http:" && !loopbackHost(url.hostname)) {
    throw fail("bad_request", "明文 http 只许回环地址");
  }
  if (url.username !== "" || url.password !== "") {
    throw fail("bad_request", "地址里不能带账号");
  }
  return url.origin;
}

function sha256(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toPem(raw: Buffer): string {
  const base64 = raw.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${base64.replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
}

/** 对端发来的整条链（叶证书在前），不验证。 */
function peerChain(url: URL, timeoutMs: number): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket = tls.connect({
      host,
      port: Number(url.port || 443),
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(fail("source_unreachable", "连接超时"));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const chain: Buffer[] = [];
      const seen = new Set<string>();
      let certificate: tls.DetailedPeerCertificate | undefined =
        socket.getPeerCertificate(true);
      while (certificate?.raw !== undefined) {
        const key = sha256(certificate.raw);
        if (seen.has(key)) break;
        seen.add(key);
        chain.push(certificate.raw);
        certificate = certificate.issuerCertificate;
      }
      socket.end();
      resolve(chain);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(fail("source_unreachable", "连不上这个地址"));
    });
  });
}

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** 按指纹找到的信任锚 PEM，按 `origin + 指纹` 缓存在内存里。 */
const anchors = new Map<string, string>();

async function anchorFor(
  url: URL,
  fingerprint: string,
  timeoutMs: number,
): Promise<string> {
  const key = `${url.origin} ${fingerprint}`;
  const cached = anchors.get(key);
  if (cached !== undefined) return cached;
  const chain = await peerChain(url, timeoutMs);
  let found = chain.find((raw) => sha256(raw) === fingerprint);
  if (found === undefined) {
    // 服务端只发了叶证书：信任锚在 `/ca.crt`（Gateway 与个人中转都有）。
    const answer = await send(
      {
        method: "GET",
        url: `${url.origin}/ca.crt`,
        fingerprint: "",
        timeoutMs,
      },
      { insecure: true, raw: true },
    ).catch(() => undefined);
    const text = typeof answer?.body === "string" ? answer.body : "";
    for (const block of text.match(PEM_BLOCK) ?? []) {
      try {
        const raw = new X509Certificate(block).raw;
        if (sha256(raw) === fingerprint) found = raw;
      } catch {
        // 不是一张证书：跳过。
      }
    }
  }
  if (found === undefined) {
    throw fail("fingerprint_mismatch", "对端证书的指纹与给定的不一致");
  }
  const pem = toPem(found);
  anchors.set(key, pem);
  return pem;
}

/**
 * 按指纹找到的信任锚 PEM（同 {@link networkTransport} 的钉扎），给不经这里发
 * HTTP 的连接用——中继隧道的 `wss://` 以它作唯一的 `ca`。空指纹答 `undefined`
 * （系统信任）。对不上答 `fingerprint_mismatch`。
 */
export async function pinnedAnchor(
  url: string,
  fingerprint: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (fingerprint === "") return undefined;
  const parsed = new URL(url);
  // 同一主机同一端口上的 TLS：`wss:` 与 `https:` 握的是同一张证书。
  const https = new URL(`https://${parsed.host}`);
  return anchorFor(https, fingerprint, timeoutMs);
}

/** 测试用：清掉信任锚缓存。 */
export function forgetAnchors(): void {
  anchors.clear();
}

interface SendOptions {
  readonly ca?: string;
  /** 只用于取 `/ca.crt` 这一次：不验证、体按文本返回。 */
  readonly insecure?: boolean;
  readonly raw?: boolean;
}

function send(
  request: OutboundRequest,
  options: SendOptions = {},
): Promise<OutboundAnswer> {
  const url = new URL(request.url);
  const payload =
    request.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(request.body), "utf8");
  const headers: Record<string, string> = {
    accept: "application/json",
    ...request.headers,
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.byteLength);
  }
  return new Promise((resolve, reject) => {
    const common = {
      method: request.method,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false as const,
    };
    const onResponse = (response: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024) {
          response.destroy();
          reject(fail("source_unreachable", "对端答得太大"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        if (options.raw === true) body = text;
        else {
          try {
            body = text === "" ? undefined : JSON.parse(text);
          } catch {
            body = undefined;
          }
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
      response.on("error", () => {
        clearTimeout(timer);
        reject(fail("source_unreachable", "连接中断"));
      });
    };
    const outgoing =
      url.protocol === "http:"
        ? http.request(common, onResponse)
        : https.request(
            {
              ...common,
              ...(options.insecure === true
                ? { rejectUnauthorized: false }
                : options.ca !== undefined
                  ? { ca: options.ca, rejectUnauthorized: true }
                  : {}),
            },
            onResponse,
          );
    const timer = setTimeout(() => {
      outgoing.destroy();
      reject(fail("source_unreachable", "请求超时"));
    }, request.timeoutMs);
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code = error.code ?? "";
      if (
        options.ca !== undefined &&
        (code.startsWith("ERR_TLS") ||
          code.includes("CERT") ||
          code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
          code === "SELF_SIGNED_CERT_IN_CHAIN" ||
          code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")
      ) {
        reject(fail("fingerprint_mismatch", "对端证书没有由钉扎的信任锚签发"));
        return;
      }
      reject(fail("source_unreachable", "连不上这个地址"));
    });
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

/** 缺省的发送点：真网络，按指纹钉扎。 */
export const networkTransport: Transport = async (request) => {
  const url = new URL(request.url);
  if (url.protocol === "http:" && !loopbackHost(url.hostname)) {
    throw fail("bad_request", "明文 http 只许回环地址");
  }
  if (url.protocol === "https:" && request.fingerprint !== "") {
    const ca = await anchorFor(url, request.fingerprint, request.timeoutMs);
    return send(request, { ca });
  }
  return send(request);
};
