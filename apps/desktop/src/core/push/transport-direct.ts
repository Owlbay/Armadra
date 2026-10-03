import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ClientHttp2Session,
  connect as connectHttp2,
  constants as http2,
} from "node:http2";
import { type PushEnvelope, sealPayload, signJwt } from "./crypto";
import {
  type PushPayload,
  type PushSender,
  type SendResult,
  SENT,
  encodePayload,
  failed,
  retryable,
} from "./types";

/**
 * 直连 APNs 与 FCM（第 2 期，补全架构 §10 的 `direct`）：自己构建 App 的部署
 * 用自己的 APNs `.p8` 与 Firebase 服务账号。商店版 App 的密钥绑在发布方账号上，
 * 走 `transport-relay.ts`；中继进程（`apps/push-relay`）复用这里的两个客户端与
 * 消息形状，所以 App 只认一种消息。
 *
 * 密钥只从文件读（设置里存的是路径，`.p8` 内容不进环境变量也不进设置文档）。
 * `ARMADRA_PUSH_APNS_ENDPOINT` / `ARMADRA_PUSH_FCM_ENDPOINT` 只给测试：指向
 * dev-stack 的 push-sink。
 */

export const APNS_PRODUCTION = "https://api.push.apple.com";
export const APNS_SANDBOX = "https://api.sandbox.push.apple.com";
export const FCM_ENDPOINT = "https://fcm.googleapis.com";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
/** Apple 要求 provider token 在 20–60 分钟之间换新；取 50 分钟。 */
const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;

/* ------------------------------- 消息形状 -------------------------------- */

/** 折叠键：tag 的摘要（APNs `apns-collapse-id` ≤ 64 字节，FCM 同理）。 */
export function collapseKey(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/**
 * APNs 正文。有信封时提示文案是 App 自己的本地化键（`loc-key`），真正的标题
 * 与正文由 Notification Service Extension 解密后替换——`mutable-content: 1`
 * 就是让它有机会跑。苹果看到的只有那两个键名和密文。
 */
export function apnsBody(
  content:
    | { readonly envelope: PushEnvelope }
    | { readonly plain: PushPayload },
): Record<string, unknown> {
  if ("envelope" in content) {
    return {
      aps: {
        alert: {
          "title-loc-key": "ARMADRA_PUSH_TITLE",
          "loc-key": "ARMADRA_PUSH_BODY",
        },
        "mutable-content": 1,
        sound: "default",
      },
      enc: content.envelope,
    };
  }
  const { title, body, url } = content.plain;
  return {
    aps: { alert: { title, body }, sound: "default" },
    url,
  };
}

/** FCM v1 的 `message`：只发数据消息，App 的处理器解密后自己出通知。 */
export function fcmMessage(
  token: string,
  content:
    | { readonly envelope: PushEnvelope }
    | { readonly plain: PushPayload },
  tag: string,
): Record<string, unknown> {
  const data =
    "envelope" in content
      ? { enc: JSON.stringify(content.envelope) }
      : { payload: JSON.stringify(content.plain) };
  return {
    token,
    data,
    android: {
      priority: "HIGH",
      ttl: "3600s",
      collapse_key: collapseKey(tag),
    },
  };
}

/* --------------------------------- APNs ---------------------------------- */

export interface ApnsConfig {
  /** `.p8` 的路径。 */
  readonly keyFile: string;
  readonly keyId: string;
  readonly teamId: string;
  /** App 的 bundle id（`apns-topic`）。 */
  readonly topic: string;
  readonly production: boolean;
  /** 只给测试：替换 Apple 的地址。 */
  readonly endpoint?: string;
}

export interface ApnsResponse {
  readonly status: number;
  readonly reason: string;
}

export class ApnsClient {
  private readonly key: KeyObject;
  private session: ClientHttp2Session | undefined;
  private token: { value: string; mintedAt: number } | undefined;

  constructor(
    private readonly config: ApnsConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.key = createPrivateKey(readFileSync(config.keyFile, "utf8"));
  }

  get endpoint(): string {
    return (
      this.config.endpoint ??
      (this.config.production ? APNS_PRODUCTION : APNS_SANDBOX)
    );
  }

  private providerToken(): string {
    const now = this.now();
    if (
      this.token === undefined ||
      now - this.token.mintedAt > APNS_TOKEN_TTL_MS
    ) {
      this.token = {
        mintedAt: now,
        value: signJwt(
          "ES256",
          { kid: this.config.keyId },
          { iss: this.config.teamId, iat: Math.floor(now / 1000) },
          this.key,
        ),
      };
    }
    return this.token.value;
  }

  private connection(): ClientHttp2Session {
    if (
      this.session === undefined ||
      this.session.closed ||
      this.session.destroyed
    ) {
      const session = connectHttp2(this.endpoint);
      // 连不上的错误由那次请求自己报；这里只别让它变成未处理的事件。
      session.on("error", () => {});
      session.on("goaway", () => session.close());
      session.unref();
      this.session = session;
    }
    return this.session;
  }

  send(
    deviceToken: string,
    body: Record<string, unknown>,
    options: { readonly collapseId?: string; readonly urgent?: boolean } = {},
  ): Promise<ApnsResponse> {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      let stream: import("node:http2").ClientHttp2Stream;
      try {
        stream = this.connection().request({
          [http2.HTTP2_HEADER_METHOD]: "POST",
          [http2.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(deviceToken)}`,
          authorization: `bearer ${this.providerToken()}`,
          "apns-topic": this.config.topic,
          "apns-push-type": "alert",
          "apns-priority": options.urgent === false ? "5" : "10",
          "apns-expiration": String(Math.floor(this.now() / 1000) + 3600),
          ...(options.collapseId === undefined
            ? {}
            : { "apns-collapse-id": options.collapseId }),
          "content-type": "application/json",
          "content-length": String(encoded.length),
        });
      } catch (error) {
        reject(error);
        return;
      }
      let status = 0;
      const chunks: Buffer[] = [];
      stream.setTimeout(15_000, () => {
        stream.close(http2.NGHTTP2_CANCEL);
        reject(new Error("APNs 超时"));
      });
      stream.on("response", (headers) => {
        status = Number(headers[http2.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => {
        let reason = "";
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (text !== "") {
            reason = String((JSON.parse(text) as { reason?: unknown }).reason);
          }
        } catch {
          reason = "";
        }
        resolve({ status, reason });
      });
      stream.end(encoded);
    });
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }
}

/** APNs 的回答 → 发送结果（Apple「Handling notification responses」）。 */
export function apnsResult(response: ApnsResponse): SendResult {
  if (response.status === 200) return SENT;
  const reason = `apns ${response.status}${response.reason ? ` ${response.reason}` : ""}`;
  const gone =
    response.status === 410 ||
    response.reason === "BadDeviceToken" ||
    response.reason === "Unregistered" ||
    response.reason === "DeviceTokenNotForTopic";
  return failed(reason, { gone, retry: !gone && retryable(response.status) });
}

/* ---------------------------------- FCM ---------------------------------- */

export interface FcmConfig {
  /** 服务账号 JSON 的路径。 */
  readonly serviceAccountFile: string;
  /** 空 = 取服务账号里的 `project_id`。 */
  readonly projectId?: string;
  /**
   * 只给测试：替换 `fcm.googleapis.com`，令牌端点随之变成 `<endpoint>/token`
   * （push-sink 的约定）。
   */
  readonly endpoint?: string;
}

interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id?: string;
  readonly token_uri?: string;
}

export interface FcmResponse {
  readonly status: number;
  /** `details[].errorCode`，没有时是 `status`。 */
  readonly errorCode: string;
}

export class FcmClient {
  private readonly account: ServiceAccount;
  private readonly key: KeyObject;
  private access: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly config: FcmConfig,
    private readonly doFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const account = JSON.parse(
      readFileSync(config.serviceAccountFile, "utf8"),
    ) as ServiceAccount;
    if (
      typeof account.client_email !== "string" ||
      typeof account.private_key !== "string"
    ) {
      throw new Error("服务账号 JSON 缺 client_email 或 private_key");
    }
    this.account = account;
    this.key = createPrivateKey(account.private_key);
  }

  get projectId(): string {
    const id = this.config.projectId || this.account.project_id || "";
    if (id === "") throw new Error("没有 FCM 项目 id");
    return id;
  }

  private get tokenUri(): string {
    if (this.config.endpoint !== undefined)
      return `${this.config.endpoint}/token`;
    return this.account.token_uri ?? "https://oauth2.googleapis.com/token";
  }

  private get messagesUri(): string {
    return `${this.config.endpoint ?? FCM_ENDPOINT}/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`;
  }

  /** 服务账号断言（RS256）换一枚一小时的 access token，提前一分钟换新。 */
  async accessToken(force = false): Promise<string> {
    const now = this.now();
    if (!force && this.access !== undefined && now < this.access.expiresAt) {
      return this.access.value;
    }
    const iat = Math.floor(now / 1000);
    const assertion = signJwt(
      "RS256",
      {},
      {
        iss: this.account.client_email,
        scope: FCM_SCOPE,
        aud: this.tokenUri,
        iat,
        exp: iat + 3600,
      },
      this.key,
    );
    const response = await this.doFetch(this.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new Error(`FCM 令牌端点 ${response.status}`);
    }
    const lifetime = Number(body.expires_in ?? 3600);
    this.access = {
      value: body.access_token,
      expiresAt: now + Math.max(60, lifetime - 60) * 1000,
    };
    return this.access.value;
  }

  async send(message: Record<string, unknown>): Promise<FcmResponse> {
    const post = async (token: string) =>
      this.doFetch(this.messagesUri, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(15_000),
      });
    let response = await post(await this.accessToken());
    if (response.status === 401) {
      // 令牌被提前吊销：换一枚再试一次，不算一次重试。
      await response.arrayBuffer().catch(() => undefined);
      response = await post(await this.accessToken(true));
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    };
    const errorCode =
      body.error?.details?.find((detail) => detail.errorCode)?.errorCode ??
      body.error?.status ??
      "";
    return { status: response.status, errorCode };
  }
}

/** FCM 的回答 → 发送结果（FCM v1 的 `ErrorCode`）。 */
export function fcmResult(response: FcmResponse): SendResult {
  if (response.status >= 200 && response.status < 300) return SENT;
  const gone =
    response.errorCode === "UNREGISTERED" ||
    (response.status === 400 && response.errorCode === "INVALID_ARGUMENT");
  return failed(`fcm ${response.status} ${response.errorCode}`.trim(), {
    gone,
    retry: !gone && retryable(response.status),
  });
}

/* --------------------------------- 发送器 --------------------------------- */

export interface DirectOptions {
  readonly apns?: ApnsClient;
  readonly fcm?: FcmClient;
}

/** 信封或明文：有设备公钥一律加密，没有才发明文（只有 `direct` 允许没有）。 */
export function contentFor(
  devicePublicKey: string,
  payload: PushPayload,
): { readonly envelope: PushEnvelope } | { readonly plain: PushPayload } {
  return devicePublicKey === ""
    ? { plain: payload }
    : { envelope: sealPayload(encodePayload(payload), devicePublicKey) };
}

export function directSender(options: DirectOptions): PushSender {
  return {
    async send(device, payload) {
      const content = contentFor(device.publicKey, payload);
      try {
        if (device.platform === "ios") {
          if (options.apns === undefined) return failed("apnsNotConfigured");
          return apnsResult(
            await options.apns.send(device.token, apnsBody(content), {
              collapseId: collapseKey(payload.tag),
              urgent: payload.kind === "approval",
            }),
          );
        }
        if (device.platform === "android") {
          if (options.fcm === undefined) return failed("fcmNotConfigured");
          return fcmResult(
            await options.fcm.send(
              fcmMessage(device.token, content, payload.tag),
            ),
          );
        }
        return failed("platformNotSupported");
      } catch (error) {
        return failed(`network: ${(error as Error).message}`, { retry: true });
      }
    },
  };
}
