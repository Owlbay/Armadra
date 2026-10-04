/**
 * 非 GitHub 平台的 REST 传输（GitHub 仍走 `github/client.ts`）。
 *
 * 规矩与 GitHub 客户端一样：
 *
 *   * API 根来自**这台机器的配置**，请求只给路径；任何能把请求重新指向别的
 *     authority 的路径一律拒绝。
 *   * 重定向一律当错误（`redirect: "manual"`）：跟随它会把带令牌的请求搬到别处。
 *   * 读有限次重试；**写永远不重试**——结果没读到报 `unknownOutcome`。
 *   * 单条响应有上限，敌意端点耗不光内存。
 *   * 令牌每次请求现取，不在内存里久留。
 *
 * 地址：只收 HTTPS；回环主机（`localhost`、`127.0.0.1`、`[::1]`）也收明文 HTTP，
 * 那是本机自托管与 dev-stack 的写法，不会把令牌放到线上。
 */

import { forgeError, type ForgeError } from "./types";

type FetchBody = NonNullable<Parameters<typeof fetch>[1]>["body"];

export const MAX_RESPONSE_BYTES = 8 << 20;
export const REQUEST_TIMEOUT_MS = 15_000;
const READ_ATTEMPTS = 2;

const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function loopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase());
}

/**
 * 规范化一个用户给的根地址：去掉末尾斜杠；拒绝带凭据、查询、片段，拒绝非回环的
 * 明文 HTTP。返回 `undefined` 表示不收。
 */
export function normalizeBase(value: string): string | undefined {
  const raw = value.trim();
  if (raw === "" || raw.length > 2048 || /[\s\\]/.test(raw)) return undefined;
  if (raw.includes("?") || raw.includes("#")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:") {
    if (!loopbackHost(host)) return undefined;
  } else if (parsed.protocol !== "https:") {
    return undefined;
  }
  if (!loopbackHost(host) && !HOST_PATTERN.test(host)) return undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.includes("//") || path.includes("..")) return undefined;
  const authority = parsed.port === "" ? host : `${host}:${parsed.port}`;
  return `${parsed.protocol}//${authority}${path}`;
}

export type TokenSource = () => Promise<string>;

export interface ForgeResponse {
  readonly status: number;
  readonly body: Buffer;
  readonly nextPage: number;
}

export interface TransportOptions {
  readonly base: string;
  readonly token: TokenSource;
  /** 令牌放进哪个头、怎么拼：Gitea 是 `Authorization: token <t>`。 */
  readonly authorize: (token: string) => Record<string, string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export class ForgeTransport {
  private readonly base: URL;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: TransportOptions) {
    const base = normalizeBase(options.base);
    if (base === undefined) throw forgeError("invalid", "API_BASE_INVALID");
    this.base = new URL(base);
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get(
    path: string,
    query?: Record<string, string>,
    accept = "application/json",
  ): Promise<ForgeResponse> {
    return this.perform("GET", path, query, undefined, true, accept);
  }

  write(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<ForgeResponse> {
    return this.perform(
      method,
      path,
      undefined,
      body,
      false,
      "application/json",
    );
  }

  private resolve(path: string, query?: Record<string, string>): string {
    if (!path.startsWith("/") || path.includes("//") || /[?#\\]/.test(path)) {
      throw forgeError("invalid", "PATH_INVALID");
    }
    for (const character of path) {
      const code = character.codePointAt(0) ?? 0;
      if (code <= 0x20 || code >= 0x7f) {
        throw forgeError("invalid", "PATH_INVALID");
      }
    }
    const target = new URL(this.base.toString());
    target.pathname = `${this.base.pathname.replace(/\/+$/, "")}${path}`;
    if (query !== undefined && Object.keys(query).length > 0) {
      target.search = new URLSearchParams(query).toString();
    }
    return target.toString();
  }

  private async perform(
    method: string,
    path: string,
    query: Record<string, string> | undefined,
    body: unknown,
    read: boolean,
    accept: string,
  ): Promise<ForgeResponse> {
    const target = this.resolve(path, query);
    const attempts = read ? READ_ATTEMPTS : 1;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.attempt(method, target, body, read, accept);
      } catch (error) {
        last = error;
        if (!read || (error as ForgeError).kind !== "unavailable") throw error;
      }
    }
    throw last;
  }

  private async attempt(
    method: string,
    target: string,
    body: unknown,
    read: boolean,
    accept: string,
  ): Promise<ForgeResponse> {
    const token = await this.options.token();
    if (token === "") throw forgeError("notConfigured", "NO_CREDENTIAL");
    const headers: Record<string, string> = {
      ...this.options.authorize(token),
      accept,
      "user-agent": this.options.userAgent ?? "armadra-core",
    };
    let payload: Uint8Array | undefined;
    if (body !== undefined) {
      payload = new Uint8Array(Buffer.from(JSON.stringify(body), "utf8"));
      headers["content-type"] = "application/json";
    }
    let result: Response;
    try {
      result = await this.doFetch(target, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload as FetchBody }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // 写可能已经送到，只是响应丢了。
      throw read
        ? forgeError("unavailable", "TRANSPORT_FAILED")
        : forgeError("unknownOutcome", "TRANSPORT_FAILED");
    }
    let data: Buffer;
    try {
      data = Buffer.from(await result.arrayBuffer());
    } catch {
      throw read
        ? forgeError("unavailable", "TRANSPORT_FAILED")
        : forgeError("unknownOutcome", "TRANSPORT_FAILED");
    }
    if (data.byteLength > MAX_RESPONSE_BYTES) {
      throw forgeError("unavailable", "RESPONSE_TOO_LARGE");
    }
    if (result.status >= 200 && result.status < 300) {
      return {
        status: result.status,
        body: data,
        nextPage: nextPage(result.headers.get("link") ?? ""),
      };
    }
    throw classify(result.status, read);
  }
}

function classify(status: number, read: boolean): ForgeError {
  if (status === 401) return forgeError("credentialRejected", "TOKEN_REJECTED");
  if (status === 403) return forgeError("remoteForbidden", "FORBIDDEN");
  if (status === 404) return forgeError("notFound", "NOT_FOUND");
  if (status === 409) return forgeError("conflict", "CONFLICT");
  if (status === 405) return forgeError("conflict", "NOT_ALLOWED");
  if (status === 422) return forgeError("invalid", "UNPROCESSABLE");
  if (status === 429) return forgeError("rateLimited", "RATE_LIMITED");
  if (status >= 300 && status < 400) {
    return forgeError("unavailable", "REDIRECT_REFUSED");
  }
  if (status >= 500) {
    return read
      ? forgeError("unavailable", "REMOTE_UNAVAILABLE")
      : forgeError("unknownOutcome", "REMOTE_UNAVAILABLE");
  }
  return forgeError("invalid", "UNEXPECTED_STATUS");
}

/** 只从 Link 头里读页码，远端 URL 本身既不跟随也不交回。 */
export function nextPage(link: string): number {
  for (const section of link.split(",")) {
    const parts = section.trim().split(";");
    if (parts.length < 2) continue;
    const next = parts
      .slice(1)
      .some((part) => /^rel="?next"?$/.test(part.trim()));
    if (!next) continue;
    const raw = (parts[0] as string).trim();
    if (!raw.startsWith("<") || !raw.endsWith(">")) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw.slice(1, -1));
    } catch {
      continue;
    }
    const page = Number.parseInt(parsed.searchParams.get("page") ?? "", 10);
    if (Number.isInteger(page) && page >= 2 && page <= 10_000) return page;
  }
  return 0;
}

export function decodeJson<T>(response: ForgeResponse): T {
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  }
}
