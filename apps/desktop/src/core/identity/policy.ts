/// <reference path="./raw-text.d.ts" />
import commonPasswordsText from "./common-passwords.txt?raw";
import { IdentityRefusal } from "./errors";
import { MAX_PASSWORD_BYTES } from "./passwords";

/**
 * 口令策略（契约 §18.1，架构 §8.3）。
 *
 * 三条规则，按这个顺序报第一条不过的：
 *
 *   1. 长度 ≥ `identity.passwordMinLength`（缺省 12，可配 10–64，按 Unicode 码点
 *      数），字节数不超过 {@link MAX_PASSWORD_BYTES}；
 *   2. 不得含账号名（显示名、principal 标识，不分大小写；三个字符以下的名字不算，
 *      否则「a」这种名字会拒掉几乎所有口令）；
 *   3. 不得在随包的常见口令表里（小写精确比对）。
 *
 * 泄露检查（HIBP k-匿名）是第四条，调用点在 {@link checkBreach}，G3-8 填实现；
 * 它是异步的、可能走网络，所以和这三条纯函数分开。
 */

export const PASSWORD_MIN_LENGTH_DEFAULT = 12;
export const PASSWORD_MIN_LENGTH_FLOOR = 10;
export const PASSWORD_MIN_LENGTH_CEILING = 64;

/** 名字短于这个码点数时不参与「含账号名」判定。 */
const MIN_NAME_LENGTH = 3;

export type PasswordRule =
  | "password_too_short"
  | "password_too_long"
  | "password_contains_name"
  | "password_too_common";

let common: ReadonlySet<string> | undefined;

/** 随包的常见口令表，第一次用到时解析一次。 */
export function commonPasswords(): ReadonlySet<string> {
  if (common === undefined) {
    const entries = new Set<string>();
    for (const line of commonPasswordsText.split(/\r?\n/)) {
      const value = line.trim();
      if (value === "" || value.startsWith("#")) continue;
      entries.add(value.toLowerCase());
    }
    common = entries;
  }
  return common;
}

/** 设置值落到 10–64；不是整数时取缺省。 */
export function effectiveMinLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return PASSWORD_MIN_LENGTH_DEFAULT;
  }
  return Math.min(
    PASSWORD_MIN_LENGTH_CEILING,
    Math.max(PASSWORD_MIN_LENGTH_FLOOR, value),
  );
}

/** 第一条不过的规则；全过时 `undefined`。纯函数。 */
export function passwordViolation(
  password: string,
  options: { readonly minLength?: number; readonly names?: readonly string[] },
): PasswordRule | undefined {
  const minLength = effectiveMinLength(options.minLength);
  if ([...password].length < minLength) return "password_too_short";
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return "password_too_long";
  }
  const lowered = password.toLowerCase();
  for (const name of options.names ?? []) {
    const value = name.trim().toLowerCase();
    if ([...value].length < MIN_NAME_LENGTH) continue;
    if (lowered.includes(value)) return "password_contains_name";
  }
  if (commonPasswords().has(lowered)) return "password_too_common";
  return undefined;
}

const MESSAGES: Record<PasswordRule, string> = {
  password_too_short: "Password is shorter than the configured minimum",
  password_too_long: "Password is too long",
  password_contains_name: "Password must not contain the account name",
  password_too_common: "Password is on the list of common passwords",
};

/** 不过就抛 400，`code` 是那条规则名。 */
export function enforcePasswordPolicy(
  password: string,
  options: { readonly minLength?: number; readonly names?: readonly string[] },
): void {
  const rule = passwordViolation(password, options);
  if (rule !== undefined) {
    throw new IdentityRefusal("invalid", 400, rule, MESSAGES[rule]);
  }
}

/**
 * 泄露检查的结果。`skipped` = 没开或还没实现；`unknown` = 查了但网络失败（不阻止
 * 设口令，只记审计）。
 */
export type BreachVerdict = "skipped" | "clean" | "breached" | "unknown";

/**
 * 泄露检查的调用点（`identity.breachCheck`，外部服务 §7.4）。G3-8 填实现：HIBP
 * 范围接口只发 SHA-1 前 5 位、带 `Add-Padding`。现在恒为 `skipped`。
 */
export async function checkBreach(_password: string): Promise<BreachVerdict> {
  return "skipped";
}
