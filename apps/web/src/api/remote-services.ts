import { z } from "zod";

import { type ShareRole, issueInvitation, revokeInvitation } from "./accounts";
import { localClient } from "./client";
import { RuntimeRequestError } from "./request";

/**
 * 设置 → 远程服务（客户端包 §3）的调用面。
 *
 * 两类对端：
 *
 * - **本机 core**：源表与远程服务（契约 §33，`sources.*`）、本机登记到远程服务
 *   （§31，`identity.cloud.*`）、本机邀请（`/api/identity/invitations`）。
 * - **远程服务本身**（个人中转 `/v1/*`，cloud-api §4–§5）：取注册令牌、为本机
 *   签断言、建 / 列 / 撤分享链接。访问令牌由本机 core 代管（`sources.remoteSession`），
 *   页面只在这一次调用里拿着它，不存。桌面壳按源表放行这个来源并按指纹钉扎
 *   （`apps/desktop/src/main/remote-trust.ts`）。
 *
 * 失败一律 `RuntimeRequestError`，界面按 `code` 取文案（`localizedFailure`）。
 */

export type {
  ClientSource,
  RemoteService,
  RemoteSourceSummary,
} from "@armadra/shared";

/** 源表与远程服务（`sources.list`）。 */
export function listSources() {
  return localClient().sources.list({});
}

/* ------------------------------ 指纹核对 ------------------------------- */

/**
 * core 没拿到指纹、系统又不信任对端证书时答 `fingerprint_mismatch`，
 * `details.fingerprint` 是对端的信任锚指纹（契约 §33.6）。认出这种答案就返回
 * 指纹，请人核对后带着它重调；别的失败原样抛。
 */
export function presentedFingerprint(error: unknown): string | null {
  if (
    !(error instanceof RuntimeRequestError) ||
    error.code !== "fingerprint_mismatch"
  )
    return null;
  const body = error.body as { details?: { fingerprint?: unknown } } | null;
  const value = body?.details?.fingerprint;
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

export type Confirmable<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "confirm"; readonly fingerprint: string };

async function confirmable<T>(work: () => Promise<T>): Promise<Confirmable<T>> {
  try {
    return { kind: "done", value: await work() };
  } catch (error) {
    const fingerprint = presentedFingerprint(error);
    if (fingerprint === null) throw error;
    return { kind: "confirm", fingerprint };
  }
}

/* ------------------------------ 远程服务 ------------------------------- */

/** 加个人中转或重新登录（同一 `issuer` 再加一次就是重新登录）。 */
export function addPersonalRelay(input: {
  issuer: string;
  account: string;
  password: string;
  fingerprint?: string;
}) {
  return confirmable(() =>
    localClient().sources.remoteAdd({
      kind: "personal",
      issuer: input.issuer.trim(),
      account: input.account.trim(),
      password: input.password,
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    }),
  );
}

export function logoutRemote(serviceId: string) {
  return localClient().sources.remoteLogout({ serviceId });
}

export function removeRemote(serviceId: string) {
  return localClient().sources.remoteRemove({ serviceId });
}

export function remoteSources(serviceId: string) {
  return localClient().sources.remoteSources({ serviceId });
}

export function mountRemoteSource(serviceId: string, sourceId: string) {
  return localClient().sources.mount({ serviceId, sourceId });
}

/* -------------------------------- 源 ---------------------------------- */

/** 自托管直连：配对链接，或地址 + 配对码。 */
export function addDirectSource(input: {
  pairLink?: string;
  origin?: string;
  code?: string;
  fingerprint?: string;
}) {
  return confirmable(() =>
    localClient().sources.addDirect({
      ...(input.pairLink ? { pairLink: input.pairLink.trim() } : {}),
      ...(input.origin ? { origin: input.origin.trim() } : {}),
      ...(input.code ? { code: input.code.trim() } : {}),
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    }),
  );
}

export function forgetSource(sourceId: string) {
  return localClient().sources.forget({ sourceId });
}

export function removeSource(sourceId: string) {
  return localClient().sources.remove({ sourceId });
}

/** 输入框里的是一条配对链接（`#pair=` 或 `armadra://pair`），还是一个地址。 */
export function isPairLink(value: string): boolean {
  const text = value.trim();
  return /^armadra:\/\/pair\b/i.test(text) || /#pair=/.test(text);
}

/* ------------------------- 直接调远程服务（/v1） ------------------------- */

interface RemoteAccess {
  readonly issuer: string;
  readonly accessToken: string;
}

async function remoteAccess(serviceId: string): Promise<RemoteAccess> {
  const session = await localClient().sources.remoteSession({ serviceId });
  return {
    issuer: session.issuer.replace(/\/+$/, ""),
    accessToken: session.accessToken,
  };
}

/**
 * 对远程服务发一次 JSON 请求。线上错误是 `{ code, message }`（cloud-api §1），
 * 改写成 `RuntimeRequestError`；连不上是 `source_unreachable`。
 */
export async function remoteFetch<T>(
  access: RemoteAccess,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown } = {},
  fetcher: typeof fetch = (input, options) => fetch(input, options),
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${access.issuer}${path}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${access.accessToken}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    throw new RuntimeRequestError(0, "", "source_unreachable");
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const failure = (payload ?? {}) as { code?: unknown; message?: unknown };
    throw new RuntimeRequestError(
      response.status,
      typeof failure.message === "string" ? failure.message : "",
      typeof failure.code === "string" ? failure.code : undefined,
      payload,
    );
  }
  return schema.parse(payload ?? {});
}

const registrationTokenSchema = z.object({
  registrationToken: z.string().min(1),
  expiresAtMs: z.number(),
});

const assertionSchema = z.object({ assertion: z.string().min(1) });

const createdLinkSchema = z.object({
  linkId: z.string().min(1),
  url: z.string().min(1),
  secret: z.string().optional(),
  expiresAtMs: z.number(),
});

const linkSummarySchema = z.object({
  linkId: z.string(),
  kind: z.string(),
  label: z.string().default(""),
  role: z.string().optional(),
  sourceId: z.string().optional(),
  url: z.string().default(""),
  uses: z.number().default(0),
  maxUses: z.number().nullable().default(null),
  expiresAtMs: z.number(),
  createdAtMs: z.number().default(0),
  revokedAtMs: z.number().nullable().default(null),
});

export type ShareLinkSummary = z.infer<typeof linkSummarySchema>;

/* ------------------------------ 分享本机 ------------------------------- */

/** 本机登记到哪些远程服务（§31 `identity.cloud.status`）。 */
export function shareStatus() {
  return localClient().identity.cloud.status({});
}

/**
 * 分享本机：用远程服务会话取注册令牌 → 本机登记（`issuer` 用远程服务行里那
 * 一份：`registered` 才会亮，登记按它的指纹钉扎）→ 用同一会话为本机签一张断言
 * → `bind`，把远程服务的这个账号映射到本机 owner，自己经中继进来才是 owner。
 */
export async function shareThisMachine(input: {
  serviceId: string;
  issuer: string;
  label: string;
}) {
  const access = await remoteAccess(input.serviceId);
  const token = await remoteFetch(
    access,
    "/v1/sources/registration-tokens",
    registrationTokenSchema,
    { method: "POST", body: {} },
  );
  const registered = await localClient().identity.cloud.register({
    issuer: input.issuer,
    registrationToken: token.registrationToken,
    ...(input.label.trim() === "" ? {} : { label: input.label.trim() }),
  });
  try {
    const signed = await remoteFetch(
      access,
      `/v1/sources/${encodeURIComponent(registered.sourceId)}/assertion`,
      assertionSchema,
      { method: "POST", body: {} },
    );
    await localClient().identity.cloud.bind({ assertion: signed.assertion });
  } catch (error) {
    // 已经映射过（`conflict`）不算失败；别的失败不撤登记——分享已经成立，
    // 只是 owner 自己经中继进来还要再绑一次。
    if (!(error instanceof RuntimeRequestError && error.code === "conflict")) {
      throw error;
    }
  }
  return registered;
}

/** 停止分享本机：撤销本机对这个远程服务的登记（隧道断开、断言不再被认）。 */
export function stopSharing(issuer: string) {
  return localClient().identity.cloud.revoke({ issuer });
}

/**
 * 分享链接（cloud-api §10）：先在本机签一张邀请，再请远程服务建一条指向它的链接。
 * 分享出去的是 `<url>#<secret>.<邀请令牌>`——两样秘密都只在 `#` 片段里。
 */
export async function createShareLink(input: {
  serviceId: string;
  sourceId: string;
  workspaceId: string;
  role: ShareRole;
  ttlMs: number;
  label: string;
}) {
  const invitation = await issueInvitation({
    role: input.role,
    targetWorkspaceId: input.workspaceId,
    ttlMs: input.ttlMs,
  });
  try {
    const access = await remoteAccess(input.serviceId);
    const link = await remoteFetch(access, "/v1/links", createdLinkSchema, {
      method: "POST",
      body: {
        kind: "source_invite",
        sourceId: input.sourceId,
        invitationId: invitation.invitationId,
        label: input.label.slice(0, 128),
        role: input.role,
        expiresAtMs: invitation.expiresAtMs,
      },
    });
    return {
      linkId: link.linkId,
      invitationId: invitation.invitationId,
      url: shareLinkUrl(link.url, link.secret ?? "", invitation.token),
      expiresAtMs: Math.min(link.expiresAtMs, invitation.expiresAtMs),
    };
  } catch (error) {
    // 链接没建成，邀请也不留：一张没有链接指向的邀请只是一枚多余的令牌。
    await revokeInvitation(invitation.invitationId).catch(() => undefined);
    throw error;
  }
}

/** `<url>#<secret>.<邀请令牌>`（personal 带 secret；saas 只有邀请令牌）。 */
export function shareLinkUrl(url: string, secret: string, token: string) {
  return `${url}#${secret === "" ? token : `${secret}.${token}`}`;
}

/** 这台机器还生效的分享链接（未撤销、未过期）。 */
export async function listShareLinks(
  serviceId: string,
  sourceId: string,
  now: number = Date.now(),
): Promise<ShareLinkSummary[]> {
  const access = await remoteAccess(serviceId);
  const answer = await remoteFetch(
    access,
    `/v1/links?sourceId=${encodeURIComponent(sourceId)}`,
    z.object({ links: z.array(linkSummarySchema) }),
  );
  return answer.links.filter(
    (link) =>
      link.kind === "source_invite" &&
      link.revokedAtMs === null &&
      link.expiresAtMs > now,
  );
}

/** 停用一条分享链接：远程服务撤链接；本机那张邀请一并作废（知道 id 时）。 */
export async function revokeShareLink(input: {
  serviceId: string;
  linkId: string;
  invitationId?: string;
}) {
  const access = await remoteAccess(input.serviceId);
  await remoteFetch(
    access,
    `/v1/links/${encodeURIComponent(input.linkId)}`,
    z.unknown(),
    { method: "DELETE" },
  );
  if (input.invitationId) {
    await revokeInvitation(input.invitationId).catch(() => undefined);
  }
}

/* ------------------------------ 桌面壳 ------------------------------- */

/**
 * 源表变了：告诉桌面壳重读（CSP 与证书钉扎）。答 `true` 表示新来源要重载页面
 * 才放行。浏览器里没有壳，答 `false`。
 */
export async function notifyShellSourcesChanged(): Promise<boolean> {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  try {
    return (await bridge?.sources?.changed())?.reload === true;
  } catch {
    return false;
  }
}
