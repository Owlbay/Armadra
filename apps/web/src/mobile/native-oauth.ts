import {
  oauthNativeOutcomeSchema,
  oauthStartSchema,
  type OAuthResult,
} from "@armadra/shared";

import {
  IdentityRequestError,
  adoptIdentitySession,
  identityRequest,
  identitySessionSchema,
} from "../api/identity";
import { nativeBridge, type NativeBridge } from "./native-bridge";

/**
 * 原生 App 发起 OAuth（R-56，契约 §18.5「原生 App」）。
 *
 * 授权页开在系统浏览器里：那里没有页面的 Cookie，所以不用浏览器绑定，改由
 * `start?native=1` 给一枚一次性的 `nativeState`，记在本机。提供方跳回 core 的
 * 回调，回调把 `state` 与授权码转成 `armadra://oauth?…` 深链交回 App；原生把
 * 深链写进 `#link=` 再重载，入口（`entry.ts`）在挂载前用这里的
 * {@link completeNativeOAuth} 收尾，再把结果写成与浏览器同一种 `#oauth=` 片段，
 * 「安全」那一页照常取走。
 */

const PENDING_KEY = "armadra.oauth.native";
const LINK_PREFIX = "armadra://oauth?";

/** 本机记着的那一条（同时只有一条：再发起一次就盖掉上一次）。 */
export interface PendingNativeOAuth {
  readonly providerId: string;
  readonly state: string;
  readonly nativeState: string;
  readonly expiresAtMs: number;
}

/** 收尾的结果；与浏览器回调片段同义（`api/security.ts::OAuthOutcome`）。 */
export interface NativeOAuthOutcome {
  readonly result: OAuthResult;
  readonly code: string;
  readonly challengeId: string;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function readPendingNativeOAuth(): PendingNativeOAuth | null {
  try {
    const raw = storage()?.getItem(PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingNativeOAuth>;
    if (
      typeof value.providerId !== "string" ||
      typeof value.state !== "string" ||
      typeof value.nativeState !== "string" ||
      typeof value.expiresAtMs !== "number"
    )
      return null;
    return value as PendingNativeOAuth;
  } catch {
    return null;
  }
}

function writePending(value: PendingNativeOAuth | null): void {
  try {
    if (value === null) storage()?.removeItem(PENDING_KEY);
    else storage()?.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    /* 存不下：收尾时认不出，答「流程已失效」，重来一次即可。 */
  }
}

/** `armadra://oauth?state=…&code=…`（或 `error=`）；认不出是 `null`。 */
export function parseNativeOAuthLink(
  link: string,
): { state: string; code?: string; error?: string } | null {
  if (!link.startsWith(LINK_PREFIX) || link.length > 4096) return null;
  const fields = new URLSearchParams(link.slice(LINK_PREFIX.length));
  const state = fields.get("state") ?? "";
  const code = fields.get("code");
  const error = fields.get("error");
  if (state === "" || (code === null && error === null)) return null;
  return {
    state,
    ...(code === null ? {} : { code }),
    ...(error === null ? {} : { error }),
  };
}

export function isNativeOAuthLink(link: string): boolean {
  return link.startsWith(LINK_PREFIX);
}

/**
 * 发起：向 core 要授权地址与 `nativeState`，记下来，交给系统浏览器。插件太旧
 * （没有 `openExternal`）时答 `oauth_browser_required`，与以前一样请人去浏览器。
 */
export async function startNativeOAuth(
  providerId: string,
  mode: "login" | "bind",
  deviceName: string,
  bridge: NativeBridge = nativeBridge(),
): Promise<void> {
  const started = await identityRequest(
    `oauth/${encodeURIComponent(providerId)}/start?native=1`,
    oauthStartSchema,
    {
      method: "POST",
      anonymous: mode === "login",
      body: { mode, deviceName },
    },
  );
  let state: string | null = null;
  try {
    state = new URL(started.authorizeUrl).searchParams.get("state");
  } catch {
    state = null;
  }
  const unsupported = new IdentityRequestError(
    400,
    "oauth_browser_required",
    "",
  );
  if (!started.nativeState || !state) throw unsupported;
  writePending({
    providerId,
    state,
    nativeState: started.nativeState,
    expiresAtMs: started.expiresAtMs,
  });
  if (!(await bridge.openExternal(started.authorizeUrl))) {
    writePending(null);
    throw unsupported;
  }
}

function failed(code: string): NativeOAuthOutcome {
  return { result: "error", code, challengeId: "" };
}

/**
 * 收尾：深链里的 `state` 必须是本机记着的那一条（别处塞来的深链不碰记录，
 * 只答失败）。对上了就取走记录、带着 `nativeState` 去 core；登录成功时会话
 * 照登录类答案的规矩进内存与钥匙串。
 */
export async function completeNativeOAuth(
  link: string,
  now: () => number = Date.now,
): Promise<NativeOAuthOutcome> {
  const parsed = parseNativeOAuthLink(link);
  const pending = readPendingNativeOAuth();
  if (parsed === null || pending === null || pending.state !== parsed.state)
    return failed("oauth_state_invalid");
  writePending(null);
  if (pending.expiresAtMs <= now()) return failed("oauth_state_invalid");
  try {
    const answer = await identityRequest(
      `oauth/${encodeURIComponent(pending.providerId)}/native`,
      oauthNativeOutcomeSchema,
      {
        method: "POST",
        anonymous: true,
        body: {
          state: parsed.state,
          nativeState: pending.nativeState,
          ...(parsed.error === undefined
            ? { code: parsed.code }
            : { error: parsed.error }),
        },
      },
    );
    if (answer.result === "signedIn" || answer.result === "signedUp") {
      adoptIdentitySession(identitySessionSchema.parse(answer.session));
    }
    return {
      result: answer.result,
      code: "",
      challengeId: answer.challengeId ?? "",
    };
  } catch (error) {
    return failed(
      error instanceof IdentityRequestError && error.code.startsWith("oauth_")
        ? error.code
        : "oauth_provider_error",
    );
  }
}

/** 结果写成浏览器回调的那种片段（`#oauth=…`），「安全」页照常取走。 */
export function oauthFragment(outcome: NativeOAuthOutcome): string {
  const fields = new URLSearchParams({ oauth: outcome.result });
  if (outcome.code) fields.set("code", outcome.code);
  if (outcome.challengeId) fields.set("challengeId", outcome.challengeId);
  return `#${fields.toString()}`;
}
