import { IdentityRefusal } from "./errors";
import { digest, newId, newSecret, parseToken } from "./tokens";

/**
 * 口令重置链接（契约 §25，迁移 0036）的原语。
 *
 * 邮箱是可选的，所以没有「输入邮箱自助重置」：owner（或组 admin 对本组成员）
 * 替某人签发一枚令牌，链接 `…/#reset=<令牌>` 由签发人亲手交给对方。判定与
 * 事务在 `accounts.ts`（签发要和组管理员同一套判定），路由在 `accounts-http.ts`。
 *
 * 令牌与邀请同形（`<32 位十六进制>.<43 位 base64url>`），库里只存
 * `digest("reset", 令牌)`——用途 `reset` 是域分隔，一枚重置令牌换不出别的东西。
 */

/** 有效期 24 小时。 */
export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;

/** 签发的答案：明文只在这一次出现。 */
export interface IssuedPasswordReset {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** 打开链接看到的那个人。HTTP 只答 `displayName` 与 `expiresAtMs`。 */
export interface PasswordResetTarget {
  readonly principalId: string;
  readonly displayName: string;
  readonly expiresAtMs: number;
}

export function newResetToken(): string {
  return `${newId()}.${newSecret()}`;
}

/** 库里找行用的哈希；形状不对的令牌答 `undefined`，不必去查库。 */
export function resetTokenHash(token: string): Buffer | undefined {
  return parseToken(token) === undefined ? undefined : digest("reset", token);
}

/**
 * 认不出的令牌：不存在、用过、作废、过期、那个人停用了，一律这一个 404。令牌
 * 本身就是凭据，多分一种情况就是多给猜的人一条线索。
 */
export function resetRefusal(): IdentityRefusal {
  return new IdentityRefusal(
    "notFound",
    404,
    "password_reset_invalid",
    "Password reset link is invalid or expired",
  );
}
