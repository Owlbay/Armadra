/**
 * 远程服务的前置判断（契约 §62.1、§63.1）：要不要挑战、报没报能力。都只看
 * `platform.info`，不发口令。
 */

import { fail } from "../http/errors";
import type { PlatformInfo } from "./remote-client";

/** 远程服务报这个能力才有改口令（cloud-api §18）。 */
export const PASSWORD_CHANGE_CAPABILITY = "auth.password-change";

/**
 * `procedure` 在 `platform.info.challenge.scope` 里而没带令牌：不发口令，答
 * `challenge_required`，`details` 是 `{ provider, siteKey }`，页面据此渲染挑战组件。
 * 答去掉首尾空白的令牌（没带是空串）。
 */
export function challengeTokenFor(
  info: PlatformInfo,
  procedure: string,
  token: string | undefined,
): string {
  const value = token?.trim() ?? "";
  const challenge = info.challenge;
  if (challenge?.scope.includes(procedure) && value === "") {
    throw fail("challenge_required", "远程服务要求先完成人机验证", {
      provider: challenge.provider,
      siteKey: challenge.siteKey,
    });
  }
  return value;
}
