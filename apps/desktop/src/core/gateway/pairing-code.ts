import { randomInt } from "node:crypto";
import { IpBuckets } from "../identity/throttle";
import { type ListenMode, loopbackHost, privateAddress } from "./network";
import type { PairingTicket } from "./pairing";

/**
 * 配对短码（契约 §24，设计系统 §5.12）：二维码之外的第三条路——手机上手输
 * 8 位，换出与 `#pair=` 同一张票。
 *
 *   * **字母表** `[A-Z2-9]`：34 个字符，没有 0 / 1，于是不会和 O / I 认错；显示
 *     成 `XXXX-XXXX`，输入时大小写与连字符都不算。8 位 ≈ 1.8 × 10¹² 种。
 *   * **与票同生同灭**：随配对票一起签，过期时刻就是票的过期时刻（两分钟）；
 *     兑一次就没；票先被扫码兑掉了，短码也跟着作废（兑换时由调用方核对）。
 *   * **限流**：按来源地址走登录同一种令牌桶（`identity/throttle.ts`，每分钟
 *     20 次），只有猜错才扣；另有一只全局桶挡分散来源的撒网。
 *   * **档位**：只在私网 / 回环的 Gateway 上开（{@link pairingCodesOpen}）；
 *     公网 `all` 档或配了对外来源时不签、不兑——短码比票短得多，不能放到
 *     任何人都能撒网的地方。
 *
 * 只在内存里：两分钟的东西不落库，core 重启后全部作废正合适。
 */

export const PAIRING_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
/** 同时活着的短码上限；满了最老的让位。 */
export const PAIRING_CODE_LIMIT = 32;
/** 所有来源合计：每分钟最多猜错这么多次。 */
export const PAIRING_CODE_GLOBAL_CAPACITY = 200;

const GLOBAL_KEY = "*";
const CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/** 签一枚：`[A-Z2-9]{8}`，逐位均匀（`randomInt` 不带取模偏差）。 */
export function newPairingCode(): string {
  let code = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/** 人输进来的 → 规范拼法；不是 8 位合法字符是 `undefined`。 */
export function normalizePairingCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return CODE.test(code) ? code : undefined;
}

/** `3F7K9Q2M` → `3F7K-9Q2M`。 */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * 这个 Gateway 开不开短码：配了对外来源（反向代理、ACME）一律不开；否则
 * `loopback` / `private` 档开，`all` 档只在绑定地址本身是回环或私网字面量时
 * 开（服务器壳绑在 `192.168.x.x` 上）。
 */
export function pairingCodesOpen(input: {
  readonly mode: ListenMode;
  readonly host: string;
  readonly publicOrigins: readonly string[];
}): boolean {
  if (input.publicOrigins.length > 0) return false;
  if (input.mode !== "all") return true;
  return loopbackHost(input.host) || privateAddress(input.host);
}

export type ExchangeResult =
  | { readonly ok: true; readonly ticket: PairingTicket }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "rate_limited" | "origin_mismatch";
      readonly retryAfterMs?: number;
      /** `origin_mismatch` 时：票绑定的来源。 */
      readonly origin?: string;
    };

/**
 * 兑换前对票的核对：`dead` 是票已被兑掉或作废（短码随它作废）；
 * `origin_mismatch` 是短码对了、但请求不是从票绑定的那个来源来的——短码
 * 留着，换到对的地址再输一次。
 */
export type TicketCheck = "ok" | "dead" | "origin_mismatch";

export class PairingCodes {
  private readonly codes = new Map<string, PairingTicket>();
  private readonly perIp = new IpBuckets();
  private readonly global = new IpBuckets(PAIRING_CODE_GLOBAL_CAPACITY);

  constructor(
    private readonly now: () => number = Date.now,
    private readonly generate: () => string = newPairingCode,
  ) {}

  /** 给一张刚签出的票配一枚短码。 */
  issue(ticket: PairingTicket): string {
    this.sweep();
    let code = this.generate();
    while (this.codes.has(code)) code = this.generate();
    if (this.codes.size >= PAIRING_CODE_LIMIT) {
      const oldest = this.codes.keys().next().value as string;
      this.codes.delete(oldest);
    }
    this.codes.set(code, ticket);
    return code;
  }

  /**
   * 兑一枚：对了就取走（一次性）；错、过期、用过、票已失效（`check` 答
   * `dead`）都是同一个 `invalid`，并扣来源与全局各一个令牌。
   */
  exchange(
    input: string,
    remoteIp: string,
    check: (ticket: PairingTicket) => TicketCheck = () => "ok",
  ): ExchangeResult {
    const now = this.now();
    for (const bucket of [
      this.perIp.peek(remoteIp, now),
      this.global.peek(GLOBAL_KEY, now),
    ]) {
      if (!bucket.ok) {
        return {
          ok: false,
          reason: "rate_limited",
          retryAfterMs: bucket.retryAfterMs,
        };
      }
    }
    const code = normalizePairingCode(input);
    const ticket = code === undefined ? undefined : this.codes.get(code);
    const verdict =
      ticket === undefined || ticket.expiresAtMs <= now
        ? "dead"
        : check(ticket);
    if (verdict === "origin_mismatch" && ticket !== undefined) {
      return { ok: false, reason: "origin_mismatch", origin: ticket.origin };
    }
    if (code !== undefined && ticket !== undefined) this.codes.delete(code);
    if (ticket === undefined || verdict !== "ok") {
      this.perIp.take(remoteIp, now);
      this.global.take(GLOBAL_KEY, now);
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, ticket };
  }

  /** 关掉 Gateway 或换档时：全部作废。 */
  clear(): void {
    this.codes.clear();
  }

  get size(): number {
    this.sweep();
    return this.codes.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, ticket] of this.codes) {
      if (ticket.expiresAtMs <= now) this.codes.delete(code);
    }
  }
}
