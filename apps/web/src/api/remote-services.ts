import type { RelayPending, ShareLink } from "@armadra/shared";
import { z } from "zod";

import type { ShareRole } from "./accounts";
import { localClient } from "./client";
import { RuntimeRequestError } from "./request";

/**
 * 设置 → 远程服务（客户端包 §3）的调用面。
 *
 * 两类对端：
 *
 * - **本机 core**：源表与远程服务（契约 §33，`sources.*`）、本机登记到远程服务
 *   （§31，`identity.cloud.*`）、本机邀请（§42.3，`accounts.invitations.*`）。
 * - **远程服务本身**（个人中转 `/v1/*`，cloud-api §4）：取注册令牌、为本机签断言。
 *   分享链接的建 / 列 / 撤由本机 core 代办（§33.9）。访问令牌由本机 core 代管（`sources.remoteSession`），
 *   页面只在这一次调用里拿着它，不存。桌面壳按源表放行这个来源并按指纹钉扎
 *   （`apps/desktop/src/main/remote-trust.ts`）。
 *
 * 失败一律 `RuntimeRequestError`，界面按 `code` 取文案（`localizedFailure`）。
 */

export type {
  ClientSource,
  RelayPending,
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

/**
 * 按分享链接挂载（契约 §33.7）：网页链接或 `armadra://join` 原样交给本机 core。
 * 签发方第一次见、系统不信任它的证书时先答指纹，请人核对后带着它重调。
 */
export function mountSourceByLink(input: {
  url: string;
  fingerprint?: string;
}) {
  return confirmable(() =>
    localClient().sources.mountByLink({
      url: input.url.trim(),
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    }),
  );
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

/**
 * 挂载的源排成这个顺序（`sources.update.orderIndex`）：按位置编号 1、2、3…，
 * 一行一行地写。页面手里的编号可能是旧的（排过一次还没重读源表），所以每行都写。
 */
export async function reorderSources(
  sourceIds: readonly string[],
): Promise<void> {
  for (const [index, sourceId] of sourceIds.entries()) {
    await localClient().sources.update({ sourceId, orderIndex: index + 1 });
  }
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

/* ------------------------------ 本机邀请 ------------------------------- */

const issuedSchema = z.object({
  invitationId: z.string().min(1),
  token: z.string().min(1),
  expiresAtMs: z.number(),
});

/**
 * 本机邀请（契约 §42.3 `accounts.invitations.*`）：经本机源的契约客户端发，
 * 桌面壳是 Bearer、不带 Cookie，跨端口过得了 CORS。
 */
export async function issueInvitation(input: {
  role: ShareRole;
  targetWorkspaceId: string;
  ttlMs: number;
}) {
  return issuedSchema.parse(
    await localClient().accounts.invitations.issue(input),
  );
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  await localClient().accounts.invitations.revoke({ invitationId });
}

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

/**
 * 停止分享本机：撤销本机对这个远程服务的登记（隧道断开、断言不再被认），core
 * 随后尽力删中继侧的源记录（契约 §31.4）。答这个 issuer 是否还欠着中继侧清理
 * 与码（`null` = 不欠）。
 */
export async function stopSharing(issuer: string): Promise<string | null> {
  await localClient().identity.cloud.revoke({ issuer });
  return pendingCode(await relayPending(), issuer);
}

/** 已撤销、中继侧还欠着清理的登记（§31.4）。 */
export async function relayPending(): Promise<RelayPending[]> {
  return (await localClient().identity.cloud.relayPending({})).pending;
}

/** 重试一条中继侧清理；答还欠着时的码（`null` = 清掉了）。 */
export async function retryRelayCleanup(
  issuer: string,
): Promise<string | null> {
  const answer = await localClient().identity.cloud.relayCleanup({ issuer });
  return answer.pending ? answer.code : null;
}

/**
 * 放弃一条中继侧清理（§31.5）：只清本机的登记，中继侧那条源记录留给远程服务。
 * 远程服务已经删了、没有会话可以重试时用。
 */
export async function dismissRelayCleanup(issuer: string): Promise<void> {
  await localClient().identity.cloud.relayDismiss({ issuer });
}

/** 列表里这个 issuer 欠着的码。 */
export function pendingCode(
  pending: readonly RelayPending[],
  issuer: string,
): string | null {
  return pending.find((one) => one.issuer === issuer)?.code ?? null;
}

/* ------------------------------ 分享链接 ------------------------------- */

export type { ShareLink, ShareLinkState } from "@armadra/shared";
export { SHARE_LINK_MAX_USES } from "@armadra/shared";

/**
 * 本机经这个远程服务发出的分享链接（契约 §33.9），含历史；core 顺带删掉失效链接
 * 存着的整条链接。本机没分享到它时是空表。
 */
export async function listShareLinks(serviceId: string): Promise<ShareLink[]> {
  return (await localClient().sources.shareLinks({ serviceId })).links;
}

/**
 * 新建分享链接：core 签一张多次可用的本机邀请、请远程服务建链接，整条链接
 * （`<url>#<秘密>.<邀请令牌>`）存进本机 SecretStore，之后随时可再取。
 */
export function createShareLink(input: {
  serviceId: string;
  workspaceId: string;
  role: ShareRole;
  ttlMs: number;
  maxUses: number;
  label: string;
}) {
  const label = input.label.trim().slice(0, 128);
  return localClient().sources.shareLinkCreate({
    serviceId: input.serviceId,
    workspaceId: input.workspaceId,
    role: input.role,
    ttlMs: input.ttlMs,
    maxUses: input.maxUses,
    ...(label === "" ? {} : { label }),
  });
}

/** 再取一次整条链接（复制、二维码、系统分享都用它）。 */
export async function shareLinkUrl(
  serviceId: string,
  linkId: string,
): Promise<string> {
  return (await localClient().sources.shareLinkUrl({ serviceId, linkId })).url;
}

/** 改一条链接的备注（§33.10）：答改过的链接。 */
export async function renameShareLink(
  serviceId: string,
  linkId: string,
  label: string,
): Promise<ShareLink> {
  return (
    await localClient().sources.shareLinkUpdate({
      serviceId,
      linkId,
      label: label.trim().slice(0, 128),
    })
  ).link;
}

/** 撤销：远程服务撤链接与它名下的访客，本机作废邀请、删存着的整条链接。 */
export async function revokeShareLink(
  serviceId: string,
  linkId: string,
): Promise<void> {
  await localClient().sources.shareLinkRevoke({ serviceId, linkId });
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

/** 桌面壳有系统分享菜单（`app:share`，目前只在 macOS）。 */
export function shellCanShare(): boolean {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  return bridge?.share?.available === true;
}

/**
 * 交给桌面壳的系统分享菜单；答 `false`（没有壳、平台没有菜单、壳拒了）时由
 * 调用方退回复制。
 */
export async function shareViaShell(
  title: string,
  url: string,
): Promise<boolean> {
  const bridge = typeof window === "undefined" ? undefined : window.armadra;
  if (bridge?.share?.available !== true) return false;
  try {
    return (await bridge.share.url({ title, url })).shared === true;
  } catch {
    return false;
  }
}
