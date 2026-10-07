/// <reference path="./raw-text.d.ts" />
import { createHash } from "node:crypto";
import commonPasswordsText from "./common-passwords.txt?raw";
import { IdentityRefusal } from "./errors";
import { MAX_PASSWORD_BYTES } from "./passwords";
import { OUTBOUND } from "../net/outbound";

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
 * 泄露检查（HIBP k-匿名）是第四条，在 {@link checkBreach}；它是异步的、可能走
 * 网络，所以和这三条纯函数分开。
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
 * 泄露检查的结果。`skipped` = 没开；`unknown` = 查了但网络失败或答案不对（不阻止
 * 设口令，只记审计）。
 */
export type BreachVerdict = "skipped" | "clean" | "breached" | "unknown";

/** `identity.breachCheck` 落地之后的三档（`auto` 由装配方按壳与 Gateway 解析）。 */
export type BreachMode = "off" | "warn" | "block";

/** 一次范围查询最多等多久；超时按 `unknown`，不拖住设口令。 */
export const BREACH_TIMEOUT_MS = 4000;
/** 答案的上限：真服务带填充约 30 KiB，留足余量，超过即当答案不对。 */
const BREACH_MAX_BYTES = 512 * 1024;

export interface BreachCheckOptions {
  readonly mode: BreachMode;
  /** 范围接口的根（`<base>/range/<前缀>`）；缺省 {@link OUTBOUND} 的 HIBP。 */
  readonly base?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** `auto` → 服务器壳或开了 Gateway 的桌面按 `warn`，其余 `off`（架构 §8.3）。 */
export function resolveBreachMode(
  setting: string,
  exposed: boolean,
): BreachMode {
  if (setting === "off" || setting === "warn" || setting === "block") {
    return setting;
  }
  return exposed ? "warn" : "off";
}

/**
 * 泄露检查（`identity.breachCheck`，外部服务 §7.4）：HIBP Pwned Passwords 的
 * k-匿名范围接口。只发 SHA-1 的前 5 位十六进制，收回同前缀的全部后缀在本地比；
 * 带 `Add-Padding: true`，填充行的次数是 0，不算命中。口令本身与完整哈希都不
 * 离开进程。网络失败、超时、非 200、答案过大一律 `unknown`，由调用方记审计后
 * 照常放行。
 */
export async function checkBreach(
  password: string,
  options: BreachCheckOptions = { mode: "off" },
): Promise<BreachVerdict> {
  if (options.mode === "off") return "skipped";
  const hash = createHash("sha1")
    .update(password, "utf8")
    .digest("hex")
    .toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const base = (options.base ?? OUTBOUND.hibpRange.url).replace(/\/+$/, "");
  const fetcher = options.fetch ?? fetch;
  try {
    const response = await fetcher(`${base}/range/${prefix}`, {
      method: "GET",
      headers: {
        "add-padding": "true",
        accept: "text/plain",
        "user-agent": "Armadra-password-check",
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? BREACH_TIMEOUT_MS),
    });
    if (response.status !== 200) return "unknown";
    const body = await response.text();
    if (body.length > BREACH_MAX_BYTES) return "unknown";
    let lines = 0;
    for (const line of body.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator !== 35) continue;
      lines += 1;
      if (line.slice(0, 35).toUpperCase() !== suffix) continue;
      const count = Number(line.slice(36).trim());
      return Number.isFinite(count) && count > 0 ? "breached" : "clean";
    }
    // 一行都认不出的答案不是「干净」，是答案不对。
    return lines === 0 ? "unknown" : "clean";
  } catch {
    return "unknown";
  }
}
