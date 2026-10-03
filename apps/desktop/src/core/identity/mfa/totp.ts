import { generateSecret, generateSync, generateURI, verifySync } from "otplib";

/**
 * TOTP（RFC 6238）：`otplib` 精确版本，不手写 HMAC。
 *
 * 参数是认证器 App 的公约数：SHA-1、6 位、30 秒。校验容忍前后各一个时间步的
 * 时钟漂移；重放防护靠调用方存下的「最后用过的时间步」——同一个码（同一个时间
 * 步）第二次一律拒，见 `store.ts` 的 `advanceTimeStep`。
 *
 * 密钥是 base32（20 字节随机），存 SecretStore，条目名 {@link totpSecretRef}；
 * 库里只有条目名。
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 前后各容忍一个时间步。 */
export const TOTP_TOLERANCE_SECONDS = 30;
export const TOTP_ISSUER = "Armadra";

/** SecretStore 里那条 TOTP 密钥的名字。 */
export function totpSecretRef(principalId: string): string {
  return `armadra-totp-${principalId}`;
}

export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/** 给认证器 App 扫的 `otpauth://totp/…`。 */
export function totpUri(secret: string, label: string): string {
  return generateURI({
    issuer: TOTP_ISSUER,
    label: label === "" ? TOTP_ISSUER : label,
    secret,
    period: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
  });
}

/** 某一时刻的码。测试与「确认登记」之外不该有人需要它。 */
export function totpAt(
  secret: string | Uint8Array,
  nowMs: number,
  digits: 6 | 7 | 8 = TOTP_DIGITS,
): string {
  return generateSync({
    secret,
    epoch: Math.floor(nowMs / 1000),
    period: TOTP_PERIOD_SECONDS,
    digits,
  });
}

export type TotpVerdict =
  | { readonly ok: true; readonly timeStep: number }
  | { readonly ok: false };

/**
 * 校验一个码。`afterTimeStep` 是这个人最后用过的时间步（0 = 没用过）：小于等于
 * 它的时间步即使码对也拒。格式不对、库抛错都是「不对」，不是 500。
 */
export function verifyTotp(input: {
  readonly secret: string | Uint8Array;
  readonly token: string;
  readonly nowMs: number;
  readonly afterTimeStep?: number;
  readonly digits?: 6 | 7 | 8;
}): TotpVerdict {
  const digits = input.digits ?? TOTP_DIGITS;
  const token = input.token.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(token)) return { ok: false };
  const after = input.afterTimeStep ?? 0;
  try {
    const result = verifySync({
      secret: input.secret,
      token,
      epoch: Math.floor(input.nowMs / 1000),
      period: TOTP_PERIOD_SECONDS,
      digits,
      epochTolerance: TOTP_TOLERANCE_SECONDS,
      ...(after > 0 ? { afterTimeStep: after } : {}),
    });
    if (!result.valid || !("timeStep" in result)) return { ok: false };
    return { ok: true, timeStep: result.timeStep };
  } catch {
    return { ok: false };
  }
}
