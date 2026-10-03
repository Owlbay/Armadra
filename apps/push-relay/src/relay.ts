import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ENVELOPE_ALG,
  type PushEnvelope,
} from "../../desktop/src/core/push/crypto";

/**
 * 推送中继：商店版 App 的 APNs / FCM 密钥在发布方手里，用户的 core 拿不到，
 * 于是 core 把**已经端到端加密的**信封交给这里，由这里转给苹果 / Google
 * （补全架构 §10 的 `relay`）。
 *
 * **无状态**。中继令牌就是平台令牌用中继自己的钥（`ARMADRA_RELAY_SECRET_FILE`）
 * 封起来的密文：App 来登记时封一次交回去，core 来推送时解开就知道往哪发。不存
 * 任何表——换一台机器、重启、多开几份都一样；换钥等于让所有中继令牌作废（答
 * `badToken`，core 撤销设备，App 下次启动重新登记）。
 *
 * 中继看得到的：平台、平台令牌、折叠键、是否紧急、密文。看不到的：标题、正文、
 * 深链、工作空间——它们在信封里，只有设备私钥解得开。
 *
 *     POST /v1/register  { platform: "ios"|"android", token }  → 200 { relayToken }
 *     POST /v1/push      { relayToken, envelope, collapseId?, urgent? }
 *                        → 202 { accepted: true } | 400 { code } | 410 { code: "gone" }
 *                          | 429 { code: "rateLimited" } | 502 { code: "upstream" }
 *     GET  /health       → 200 { ok: true, platforms: [...] }
 */

export type RelayPlatform = "ios" | "android";

/** 往平台发一条：`gone` = 平台说令牌作废。 */
export interface PlatformSender {
  send(
    token: string,
    envelope: PushEnvelope,
    options: { readonly collapseId: string; readonly urgent: boolean },
  ): Promise<{
    readonly ok: boolean;
    readonly gone: boolean;
    readonly reason: string;
  }>;
}

export interface RelayOptions {
  /** 32 字节，封中继令牌用。 */
  readonly secret: Buffer;
  readonly ios?: PlatformSender;
  readonly android?: PlatformSender;
  /** 每个中继令牌每分钟最多几条（防一个泄露的令牌被拿去刷屏）。 */
  readonly perMinute?: number;
  readonly now?: () => number;
}

export interface RelayAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const MAX_BODY = 8 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;

function answer(status: number, body: Record<string, unknown>): RelayAnswer {
  return { status, body };
}

function refuse(status: number, code: string, message: string): RelayAnswer {
  return answer(status, { code, message });
}

/* -------------------------------- 中继令牌 -------------------------------- */

/** 中继令牌 = b64url(iv ‖ AES-256-GCM(secret, {p, t}) ‖ tag)。 */
export function sealToken(
  secret: Buffer,
  platform: RelayPlatform,
  token: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret, iv);
  cipher.setAAD(Buffer.from("armadra-relay-token-v1"));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify({ p: platform, t: token }), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
}

export function openToken(
  secret: Buffer,
  relayToken: string,
): { readonly platform: RelayPlatform; readonly token: string } | undefined {
  try {
    const raw = Buffer.from(relayToken, "base64url");
    if (raw.length < 12 + 16 + 1) return undefined;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from("armadra-relay-token-v1"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(12, raw.length - 16)),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plain) as { p?: unknown; t?: unknown };
    if (
      (parsed.p !== "ios" && parsed.p !== "android") ||
      typeof parsed.t !== "string"
    ) {
      return undefined;
    }
    return { platform: parsed.p, token: parsed.t };
  } catch {
    return undefined;
  }
}

function validEnvelope(value: unknown): value is PushEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope).sort().join(",");
  if (keys !== "alg,ct,epk,iv,salt,v") return false;
  if (envelope.v !== 1 || envelope.alg !== ENVELOPE_ALG) return false;
  return ["epk", "salt", "iv", "ct"].every(
    (key) =>
      typeof envelope[key] === "string" &&
      B64URL.test(envelope[key] as string) &&
      (envelope[key] as string).length <= 4096,
  );
}

/* --------------------------------- 处理 ---------------------------------- */

export function createRelay(options: RelayOptions) {
  if (options.secret.length !== 32) {
    throw new Error("中继密钥应是 32 字节");
  }
  const now = options.now ?? Date.now;
  const perMinute = options.perMinute ?? 60;
  /** 只在内存里的计数窗口：限流不是状态，重启清零无妨。 */
  const windows = new Map<string, { start: number; count: number }>();

  function limited(relayToken: string): boolean {
    const key = createHash("sha256").update(relayToken).digest("base64url");
    const at = now();
    const window = windows.get(key);
    if (window === undefined || at - window.start >= 60_000) {
      windows.set(key, { start: at, count: 1 });
      if (windows.size > 100_000) windows.clear();
      return false;
    }
    window.count += 1;
    return window.count > perMinute;
  }

  function sender(platform: RelayPlatform): PlatformSender | undefined {
    return platform === "ios" ? options.ios : options.android;
  }

  async function handle(
    method: string,
    path: string,
    body: unknown,
  ): Promise<RelayAnswer> {
    if (method === "GET" && path === "/health") {
      return answer(200, {
        ok: true,
        platforms: [
          ...(options.ios === undefined ? [] : ["ios"]),
          ...(options.android === undefined ? [] : ["android"]),
        ],
      });
    }
    if (method === "POST" && path === "/v1/register") {
      const input = (body ?? {}) as { platform?: unknown; token?: unknown };
      if (input.platform !== "ios" && input.platform !== "android") {
        return refuse(400, "invalid", "platform 应是 ios 或 android");
      }
      if (sender(input.platform) === undefined) {
        return refuse(400, "platformUnavailable", "这台中继不发这个平台");
      }
      if (
        typeof input.token !== "string" ||
        input.token.length === 0 ||
        input.token.length > 1024 ||
        !/^[\x21-\x7e]+$/.test(input.token)
      ) {
        return refuse(400, "invalid", "token 不合法");
      }
      return answer(200, {
        relayToken: sealToken(options.secret, input.platform, input.token),
      });
    }
    if (method === "POST" && path === "/v1/push") {
      const input = (body ?? {}) as {
        relayToken?: unknown;
        envelope?: unknown;
        collapseId?: unknown;
        urgent?: unknown;
      };
      if (typeof input.relayToken !== "string") {
        return refuse(400, "invalid", "缺 relayToken");
      }
      // 只收信封：没有明文这条路，中继永远不经手正文。
      if (!validEnvelope(input.envelope)) {
        return refuse(400, "invalid", "envelope 不是 v1 信封");
      }
      const target = openToken(options.secret, input.relayToken);
      if (target === undefined) {
        return refuse(400, "badToken", "中继令牌解不开");
      }
      const platform = sender(target.platform);
      if (platform === undefined) {
        return refuse(400, "platformUnavailable", "这台中继不发这个平台");
      }
      if (limited(input.relayToken)) {
        return refuse(429, "rateLimited", "这个令牌发得太频繁");
      }
      const collapseId =
        typeof input.collapseId === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(input.collapseId)
          ? input.collapseId
          : "";
      let result;
      try {
        result = await platform.send(target.token, input.envelope, {
          collapseId,
          urgent: input.urgent === true,
        });
      } catch (error) {
        return refuse(502, "upstream", (error as Error).message);
      }
      if (result.ok) return answer(202, { accepted: true });
      if (result.gone) return refuse(410, "gone", "平台说这个令牌已作废");
      return refuse(502, "upstream", result.reason);
    }
    return refuse(404, "notFound", "没有这个接口");
  }

  /** 接到 `node:http` 上。 */
  async function serve(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        send(response, refuse(413, "tooLarge", "请求体太大"));
        request.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown = undefined;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(response, refuse(400, "invalid", "请求体不是 JSON"));
        return;
      }
    }
    const path = new URL(request.url ?? "/", "http://relay").pathname;
    send(response, await handle(request.method ?? "GET", path, body));
  }

  return { handle, serve };
}

function send(response: ServerResponse, answer: RelayAnswer): void {
  const payload = JSON.stringify(answer.body);
  response.writeHead(answer.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}
