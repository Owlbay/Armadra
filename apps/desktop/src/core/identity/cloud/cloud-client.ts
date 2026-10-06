/**
 * 登记时对远程服务的三次调用（平台规格 core 包 §2.5；远程服务一侧见
 * armadra-cloud 的 cloud-api §2、§4、§10）：`platform.info`、`sources.register`、
 * `platform.jwks`。外呼登记 `net/outbound.ts` 的 `cloudApi` 与 `cloudJwks`。
 *
 * 发送点与 `core/sources` 是同一个（按远程服务的 CA 指纹钉扎、带超时）。远程服务
 * 的码收拢成契约 §31 的码，原话不透传；注册令牌只出现在发出去的那一次请求里。
 */

import {
  type Ed25519PublicJwk,
  type JwkSet,
  jwkSetSchema,
} from "@armadra/platform-protocol/assertion";

import { fail } from "../../http/errors";
import type { Transport } from "../../sources/http-client";

const TIMEOUT_MS = 10_000;

export interface PlatformInfo {
  readonly mode: "personal" | "saas";
  readonly issuer: string;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly capabilities: readonly string[];
}

export interface SourceRegistration {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly relayOrigins: readonly string[];
  readonly trustedOrigins: readonly string[];
  readonly sourceId: string;
  readonly ownerAccountId: string;
}

export interface RegisterRequest {
  readonly registrationToken: string;
  readonly sourceId: string;
  readonly publicKey: Ed25519PublicJwk;
  readonly name: string;
  readonly kind: "desktop" | "server";
  readonly coreVersion: string;
  readonly capabilities: readonly string[];
  readonly protocol: { readonly major: number; readonly minor: number };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((one): one is string => typeof one === "string")
    : [];
}

/** 远程服务的失败 → 契约 §31 的码。 */
function rejected(status: number, body: unknown, during: string): never {
  const answer = record(body);
  const details = record(answer.details);
  switch (str(answer.code)) {
    case "registration_token_invalid":
      throw fail("registration_token_invalid", "登记令牌无效或已过期");
    case "protocol_unsupported":
      throw fail("protocol_unsupported", "远程服务的协议版本不兼容");
    case "source_taken":
      throw fail(
        "cloud_already_registered",
        "远程服务上这台机器已由另一把钥登记",
      );
    case "rate_limited":
      throw fail(
        "rate_limited",
        "远程服务限流，请稍后重试",
        typeof details.retryAfterMs === "number"
          ? { retryAfterMs: details.retryAfterMs }
          : undefined,
      );
    case "not_implemented":
      throw fail("not_implemented", "远程服务没有这项能力");
    default:
      break;
  }
  throw fail("source_unreachable", `远程服务没能完成${during}（${status}）`);
}

export class CloudClient {
  constructor(private readonly transport: Transport) {}

  private async call(
    url: string,
    fingerprint: string,
    method: "GET" | "POST",
    during: string,
    body?: unknown,
  ): Promise<unknown> {
    const answer = await this.transport({
      method,
      url,
      fingerprint,
      timeoutMs: TIMEOUT_MS,
      ...(body === undefined ? {} : { body }),
    });
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    return rejected(answer.status, answer.body, during);
  }

  async info(issuer: string, fingerprint: string): Promise<PlatformInfo> {
    const body = record(
      await this.call(
        `${issuer}/.well-known/armadra-platform`,
        fingerprint,
        "GET",
        "握手",
      ),
    );
    const protocol = record(body.protocol);
    if (
      (body.mode !== "personal" && body.mode !== "saas") ||
      typeof protocol.major !== "number" ||
      typeof protocol.minor !== "number"
    ) {
      throw fail("source_unreachable", "这个地址不是一个远程服务");
    }
    return {
      mode: body.mode,
      issuer: str(body.issuer),
      protocol: { major: protocol.major, minor: protocol.minor },
      capabilities: strings(body.capabilities),
    };
  }

  async register(
    issuer: string,
    fingerprint: string,
    request: RegisterRequest,
  ): Promise<SourceRegistration> {
    const body = record(
      await this.call(
        `${issuer}/v1/sources/register`,
        fingerprint,
        "POST",
        "登记",
        request,
      ),
    );
    const registration: SourceRegistration = {
      issuer: str(body.issuer),
      jwksUrl: str(body.jwksUrl),
      relayOrigins: strings(body.relayOrigins),
      trustedOrigins: strings(body.trustedOrigins),
      sourceId: str(body.sourceId),
      ownerAccountId: str(body.ownerAccountId),
    };
    if (registration.jwksUrl === "" || registration.sourceId === "") {
      throw fail("source_unreachable", "远程服务的登记答案不完整");
    }
    return registration;
  }

  async jwks(url: string, fingerprint: string): Promise<JwkSet> {
    const parsed = jwkSetSchema.safeParse(
      await this.call(url, fingerprint, "GET", "取公钥"),
    );
    if (!parsed.success) {
      throw fail("source_unreachable", "远程服务的公钥集不是 JWKS");
    }
    return parsed.data;
  }
}
