/**
 * 测试用：一个假的个人中转（登记这一侧的 `/.well-known/*` 与 `sources.register`），
 * 挂在一个 {@link Transport} 上，不开端口；签断言用协议包的测试钥。
 *
 * 只有 `*.test.ts` import 它。
 */

import {
  type KeyObject,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

import {
  TOKEN_TYPES,
  buildSigningInput,
  joinCompactJws,
} from "@armadra/platform-protocol/assertion";
import { TEST_KEYS } from "@armadra/platform-protocol/fixtures";

import { fail } from "../../http/errors";
import type {
  OutboundAnswer,
  OutboundRequest,
  Transport,
} from "../../sources/http-client";
import type { SecretBackend } from "../../secrets/backend";
import type { CloudRelay } from "./register";

export const ISSUER = "https://relay.test";
export const REGISTRATION_TOKEN = "registration-token-secret-value";
export const ISSUER_KEY: KeyObject = createPrivateKey({
  key: TEST_KEYS.issuer.privateJwk,
  format: "jwk",
});

export interface FakeRelayWorld {
  readonly transport: Transport;
  readonly requests: OutboundRequest[];
  /** `platform.info` 的答案（可改）。 */
  info: Record<string, unknown>;
  /** `sources.register` 收到的体（最后一次）。 */
  registered?: Record<string, unknown>;
  /** 登记答案里的覆写。 */
  registerOverride: Record<string, unknown>;
  /** JWKS（可改：换钥）。 */
  keys: Record<string, unknown>[];
  /** `true`：JWKS 取不到（远程服务离线）。 */
  jwksDown: boolean;
  jwksFetches: number;
  /** 下一次登记答的错误码（一次性）。 */
  refuseRegister?: { status: number; code: string };
}

export function fakeRelayWorld(issuer = ISSUER): FakeRelayWorld {
  const world: FakeRelayWorld = {
    requests: [],
    info: {
      mode: "personal",
      issuer,
      protocol: { major: 1, minor: 0 },
      capabilities: ["auth.password", "links.source-invite", "me.stream"],
      relay: { addressing: "path" },
    },
    registerOverride: {},
    keys: [TEST_KEYS.issuer.publicJwk],
    jwksDown: false,
    jwksFetches: 0,
    transport: async (request): Promise<OutboundAnswer> => {
      world.requests.push(request);
      const url = new URL(request.url);
      if (url.origin !== issuer) {
        throw fail("source_unreachable", "连不上这个地址");
      }
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /.well-known/armadra-platform") {
        return { status: 200, body: world.info };
      }
      if (route === "GET /.well-known/jwks.json") {
        world.jwksFetches += 1;
        if (world.jwksDown) throw fail("source_unreachable", "连不上这个地址");
        return { status: 200, body: { keys: world.keys } };
      }
      if (route === "POST /v1/sources/register") {
        const body = request.body as Record<string, unknown>;
        if (world.refuseRegister !== undefined) {
          const refusal = world.refuseRegister;
          world.refuseRegister = undefined;
          return {
            status: refusal.status,
            body: { code: refusal.code, message: "refused" },
          };
        }
        if (body.registrationToken !== REGISTRATION_TOKEN) {
          return {
            status: 401,
            body: { code: "registration_token_invalid", message: "bad token" },
          };
        }
        world.registered = body;
        return {
          status: 200,
          body: {
            issuer,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            relayOrigins: [issuer],
            trustedOrigins: [issuer],
            sourceId: body.sourceId,
            ownerAccountId: "acct:dev",
            ...world.registerOverride,
          },
        };
      }
      return { status: 404, body: { code: "not_found", message: "no" } };
    },
  };
  return world;
}

/** 签一张断言（缺省：测试钥、5 分钟、随机 `jti`）。 */
export function signAssertion(input: {
  readonly aud: string;
  readonly nowMs: number;
  readonly iss?: string;
  readonly sub?: string;
  readonly kid?: string;
  readonly key?: KeyObject;
  readonly typ?: string;
  readonly ttlS?: number;
  readonly jti?: string;
  readonly extra?: Record<string, unknown>;
}): string {
  const iat = Math.floor(input.nowMs / 1000);
  const { signingInput, encodedHeader, encodedPayload } = buildSigningInput(
    {
      alg: "EdDSA",
      kid: input.kid ?? TEST_KEYS.issuer.kid,
      typ: input.typ ?? TOKEN_TYPES.assertion,
    },
    {
      iss: input.iss ?? ISSUER,
      sub: input.sub ?? "acct:dev",
      aud: input.aud,
      iat,
      exp: iat + (input.ttlS ?? 300),
      jti: input.jti ?? randomBytes(8).toString("hex"),
      ver: 1,
      name: "Dev",
      device: { deviceId: "dev-1", platform: "browser", name: "Chrome" },
      ...input.extra,
    },
  );
  return joinCompactJws(
    encodedHeader,
    encodedPayload,
    sign(null, signingInput, input.key ?? ISSUER_KEY),
  );
}

/** 内存里的 SecretStore 后端。 */
export function memoryBackend(): SecretBackend & {
  readonly values: Map<string, string>;
  sets: number;
} {
  const values = new Map<string, string>();
  const backend = {
    values,
    sets: 0,
    kind: "file" as const,
    get: async (name: string) => values.get(name),
    set: async (name: string, value: string) => {
      backend.sets += 1;
      values.set(name, value);
    },
    delete: async (name: string) => {
      values.delete(name);
    },
  };
  return backend as unknown as SecretBackend & {
    readonly values: Map<string, string>;
    sets: number;
  };
}

/** 记下起停的假隧道。 */
export function fakeRelay(): CloudRelay & {
  readonly started: string[];
  readonly stopped: string[];
} {
  const started: string[] = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    start: (issuer) => void started.push(issuer),
    stop: (issuer) => void stopped.push(issuer),
    status: (issuer) => ({
      state:
        started.includes(issuer) && !stopped.includes(issuer)
          ? "connecting"
          : "disabled",
      node: null,
      since: null,
      streams: 0,
      lastError: null,
    }),
  };
}
