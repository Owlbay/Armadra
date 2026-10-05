import { z } from "zod";

import { json, request } from "../api/request";
import { localSource } from "../api/source";
import type { CredentialProvider, SourceAccess, Via } from "./types";

export { type SessionTokens, createSessionTokens } from "./session-tokens";

/**
 * 凭据的来路（客户端包 §1.2）。
 *
 * 凭据跟着源走：每个源一份，只在内存里。本机源的会话由身份面
 * （`api/identity.ts`）持有一份 `SessionTokens`（`sources/session-tokens.ts`）；远程源的访问由一个
 * {@link CredentialProvider} 按 `sourceId` 各管各的——
 *
 * - **desktop**（桌面与服务器壳的页面）：本机 core 代为换票，刷新令牌留在 core
 *   的 SecretStore 里，页面只拿到访问令牌（`POST /api/sources/{id}/session`，
 *   契约 §33）。{@link createDesktopCredentialProvider}。
 * - **mobile**（钥匙串 + 远程服务）与 **browser-cloud**（内存 + 云会话）：形状
 *   相同，实现分别在 A1-5 与 SaaS 页面落地；它们只要实现
 *   {@link CredentialProvider}，或给 {@link createCachedCredentialProvider} 一个
 *   换票函数。
 */

/** 换一份访问：给源与路，答访问。 */
export type AccessExchange = (
  sourceId: string,
  via: Via,
) => Promise<SourceAccess>;

/** 访问令牌离到期不到这么久就当它已经过期，先换一份。 */
export const ACCESS_RENEW_LEAD_MS = 30_000;

/**
 * 按源缓存访问的凭据来源：同一个源同一条路的并发请求只换一次；快到期的先换；
 * `refresh` 不看缓存。换票本身交给 `exchange`。
 */
export function createCachedCredentialProvider(
  exchange: AccessExchange,
  now: () => number = Date.now,
): CredentialProvider {
  const cache = new Map<string, { via: Via; access: SourceAccess }>();
  const pending = new Map<string, Promise<SourceAccess>>();

  const fresh = (access: SourceAccess) =>
    access.expiresAtMs === 0 ||
    access.expiresAtMs - now() > ACCESS_RENEW_LEAD_MS;

  const run = (sourceId: string, via: Via): Promise<SourceAccess> => {
    const key = `${sourceId}\u0000${via}`;
    let inflight = pending.get(key);
    if (inflight === undefined) {
      inflight = exchange(sourceId, via)
        .then((access) => {
          cache.set(sourceId, { via, access });
          return access;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, inflight);
    }
    return inflight;
  };

  return {
    getAccess(sourceId, via) {
      const cached = cache.get(sourceId);
      if (cached !== undefined && cached.via === via && fresh(cached.access))
        return Promise.resolve(cached.access);
      return run(sourceId, via);
    },
    refresh(sourceId, via) {
      cache.delete(sourceId);
      return run(sourceId, via);
    },
    invalidate(sourceId) {
      cache.delete(sourceId);
    },
  };
}

const sessionAnswerSchema = z.object({
  accessToken: z.string().min(1),
  accessExpiresAtMs: z.number(),
  httpBase: z.string().min(1),
  wsBase: z.string().min(1),
  via: z.enum(["direct", "relayed"]),
  relayToken: z.string().optional(),
  relayTokenExpiresAtMs: z.number().optional(),
});

/**
 * 桌面与服务器壳的页面：经本机 core 换票（`POST /api/sources/{id}/session`，
 * 契约 §33）。刷新令牌与远程服务的会话都留在 core，页面只拿访问令牌；
 * 刷新失败时 core 自己经远程服务重取断言，再失败答 `source_unauthorized`。
 */
export const exchangeViaLocalCore: AccessExchange = async (sourceId, via) => {
  const answer = await request(
    `/api/sources/${encodeURIComponent(sourceId)}/session`,
    sessionAnswerSchema,
    {
      method: "POST",
      ...json(via === "local" ? {} : { via }),
    },
    localSource,
  );
  return {
    accessToken: answer.accessToken,
    expiresAtMs: answer.accessExpiresAtMs,
    httpBase: answer.httpBase.replace(/\/+$/, ""),
    wsBase: answer.wsBase.replace(/\/+$/, ""),
    ...(answer.relayToken === undefined
      ? {}
      : { relayToken: answer.relayToken }),
  };
};

export function createDesktopCredentialProvider(
  exchange: AccessExchange = exchangeViaLocalCore,
  now?: () => number,
): CredentialProvider {
  return createCachedCredentialProvider(exchange, now);
}
