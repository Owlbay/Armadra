import { IdentityRequestError, IdentityTransportError } from "../api/identity";
import { localizedFailure } from "../api/request";

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/** 有没有这条文案：缺键时 `t` 退回键名。 */
function known(t: Translate, key: string): string | undefined {
  const text = t(key);
  return text === key ? undefined : text;
}

/**
 * 安全页与登录的失败一行字（契约 §18 的具名 `code` 优先，其次通用错误码）。
 */
export function securityFailure(error: unknown, t: Translate): string {
  if (error instanceof IdentityRequestError) {
    return (
      known(t, `security.error.${error.code}`) ??
      known(t, `auth.error.${error.code}`) ??
      localizedFailure(error.code, t("security.failed"))
    );
  }
  if (error instanceof IdentityTransportError) return t("auth.offline");
  return t("security.failed");
}

/** 锁定或限流还要等几分钟（向上取整，至少 1）；不是这两种时 `null`。 */
export function lockoutMinutes(error: unknown): number | null {
  if (
    !(error instanceof IdentityRequestError) ||
    error.status !== 429 ||
    (error.code !== "account_locked" && error.code !== "rate_limited")
  ) {
    return null;
  }
  return Math.max(1, Math.ceil((error.retryAfterSeconds || 60) / 60));
}
