import { type SecretBackend, SecretStore } from "../../secrets";
import { IdentityError, IdentityRefusal } from "../errors";
import type { IdentityStore } from "../store";
import { newId } from "../tokens";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCodes,
  matchRecoveryCode,
} from "./recovery";
import { newTotpSecret, totpSecretRef, totpUri, verifyTotp } from "./totp";

/**
 * 第二因素：TOTP 登记、确认、校验、停用，恢复码，以及两步登录的中间票
 * （契约 §18.3，架构 §8.3）。
 *
 * 状态在三处：
 *
 *   * `identity_mfa` 一行：密钥在 SecretStore 的条目名、登记时刻、确认时刻
 *     （0 = 还没用一个码确认过，登录时不要求它）、最后用过的时间步；
 *   * SecretStore 里那条 base32 密钥（`armadra-totp-<principalId>`）——不进库、
 *     不进日志、只在登记那一次的响应里出现；
 *   * 内存里的登录票：口令对了、第二因素还没过的那几分钟。重启丢光无妨，用户
 *     重新输口令即可。
 */

export const MFA_LOGIN_TTL_MS = 5 * 60 * 1000;
/** 一张登录票最多试几次第二因素；之后作废，回到口令那一步。 */
export const MFA_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_TICKETS = 4096;

export type SecondFactor = "totp" | "recovery";

export interface MfaStatus {
  /** 有一份已确认的 TOTP：登录时要第二因素。 */
  readonly enrolled: boolean;
  /** 登记了还没确认。 */
  readonly pending: boolean;
  readonly enrolledAtMs: number;
  readonly verifiedAtMs: number;
  readonly recoveryCodesRemaining: number;
}

export interface MfaLoginTicket {
  readonly principalId: string;
  readonly origin: string;
  readonly deviceName: string;
  readonly remoteIp: string;
  readonly userAgent: string;
  readonly expiresAtMs: number;
  attempts: number;
}

export function invalidCode(): IdentityRefusal {
  return new IdentityRefusal(
    "unauthenticated",
    401,
    "mfa_invalid_code",
    "The verification code is not valid",
  );
}

function secretUnavailable(): IdentityRefusal {
  return new IdentityRefusal(
    "invalid",
    503,
    "mfa_secret_unavailable",
    "The second-factor secret cannot be read from the secret store",
  );
}

export class Mfa {
  private readonly tickets = new Map<string, MfaLoginTicket>();

  constructor(
    private readonly store: IdentityStore,
    private readonly backend: () => SecretBackend,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private secret(principalId: string): SecretStore {
    return new SecretStore(this.backend(), totpSecretRef(principalId));
  }

  status(principalId: string): MfaStatus {
    return this.store.transaction((tx) => {
      const row = tx.mfa(principalId);
      const remaining = tx
        .recoveryCodes(principalId)
        .filter((code) => code.usedAtMs === 0).length;
      return {
        enrolled: row !== undefined && row.verifiedAtMs > 0,
        pending: row !== undefined && row.verifiedAtMs === 0,
        enrolledAtMs: row?.enrolledAtMs ?? 0,
        verifiedAtMs: row?.verifiedAtMs ?? 0,
        recoveryCodesRemaining: row === undefined ? 0 : remaining,
      };
    });
  }

  /**
   * 开始登记：生成密钥、存进 SecretStore、写一行未确认的记录。已经确认过的不能
   * 直接覆盖（先停用），否则一个偷到会话的人能把第二因素换成自己的。
   */
  async begin(
    principalId: string,
    label: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    if (this.status(principalId).enrolled) {
      throw new IdentityRefusal(
        "conflict",
        409,
        "mfa_already_enrolled",
        "A verified authenticator is already enrolled; disable it first",
      );
    }
    const secret = newTotpSecret();
    try {
      await this.secret(principalId).write(secret);
    } catch {
      throw secretUnavailable();
    }
    const now = this.clock();
    this.store.transaction((tx) =>
      tx.putMfa({
        principalId,
        totpSecretRef: totpSecretRef(principalId),
        enrolledAtMs: now,
        verifiedAtMs: 0,
        lastTimeStep: 0,
      }),
    );
    return { secret, otpauthUri: totpUri(secret, label) };
  }

  /** 用一个码确认登记，同时发第一批恢复码（明文只在这一次）。 */
  async confirm(principalId: string, code: string): Promise<string[]> {
    const row = this.store.transaction((tx) => tx.mfa(principalId));
    if (row === undefined) throw new IdentityError("notFound");
    if (row.verifiedAtMs > 0) {
      throw new IdentityRefusal(
        "conflict",
        409,
        "mfa_already_enrolled",
        "The authenticator is already verified",
      );
    }
    const secret = await this.secret(principalId).read();
    if (secret === undefined) throw secretUnavailable();
    const now = this.clock();
    const verdict = verifyTotp({
      secret,
      token: code,
      nowMs: now,
      afterTimeStep: row.lastTimeStep,
    });
    if (!verdict.ok) throw invalidCode();
    const codes = generateRecoveryCodes();
    const hashed = hashRecoveryCodes(codes);
    this.store.transaction((tx) => {
      if (!tx.advanceTimeStep(principalId, verdict.timeStep, now)) {
        throw invalidCode();
      }
      tx.replaceRecoveryCodes(
        principalId,
        hashed.map((value) => ({
          principalId,
          codeHash: value.codeHash,
          salt: value.salt,
          createdAtMs: now,
          usedAtMs: 0,
        })),
      );
    });
    return codes;
  }

  /**
   * 校验第二因素。六位数字按 TOTP 判（时间步必须比上次用过的新），其余按恢复码
   * 判（用掉即作废）。不对抛 `mfa_invalid_code`。
   */
  async verify(principalId: string, code: string): Promise<SecondFactor> {
    const row = this.store.transaction((tx) => tx.mfa(principalId));
    if (row === undefined || row.verifiedAtMs === 0) throw invalidCode();
    const now = this.clock();
    const compact = code.replace(/\s+/g, "");
    if (/^\d{6}$/.test(compact)) {
      const secret = await this.secret(principalId).read();
      if (secret === undefined) throw secretUnavailable();
      const verdict = verifyTotp({
        secret,
        token: compact,
        nowMs: now,
        afterTimeStep: row.lastTimeStep,
      });
      if (!verdict.ok) throw invalidCode();
      const fresh = this.store.transaction((tx) =>
        tx.advanceTimeStep(principalId, verdict.timeStep),
      );
      if (!fresh) throw invalidCode();
      return "totp";
    }
    const used = this.store.transaction((tx) => {
      const hash = matchRecoveryCode(code, tx.recoveryCodes(principalId));
      return hash !== undefined && tx.useRecoveryCode(principalId, hash, now);
    });
    if (!used) throw invalidCode();
    return "recovery";
  }

  /** 换一批恢复码；旧的全部作废。只有已确认的登记才有恢复码。 */
  regenerateRecoveryCodes(principalId: string): string[] {
    const codes = generateRecoveryCodes();
    const hashed = hashRecoveryCodes(codes);
    const now = this.clock();
    this.store.transaction((tx) => {
      const row = tx.mfa(principalId);
      if (row === undefined || row.verifiedAtMs === 0) {
        throw new IdentityError("notFound");
      }
      tx.replaceRecoveryCodes(
        principalId,
        hashed.map((value) => ({
          principalId,
          codeHash: value.codeHash,
          salt: value.salt,
          createdAtMs: now,
          usedAtMs: 0,
        })),
      );
    });
    return codes;
  }

  /** 停用：删行、删恢复码、删 SecretStore 条目。返回原来有没有登记。 */
  async disable(principalId: string): Promise<boolean> {
    const existed = this.store.transaction((tx) => {
      const row = tx.mfa(principalId);
      tx.deleteMfa(principalId);
      return row !== undefined;
    });
    // 删密钥失败不回滚：行已经没了，登录不再要它；残留的条目下次登记时覆盖。
    await this.secret(principalId)
      .clear()
      .catch(() => undefined);
    return existed;
  }

  /* ------------------------------ 登录中间票 ------------------------------ */

  beginLogin(value: Omit<MfaLoginTicket, "expiresAtMs" | "attempts">): {
    challengeId: string;
    expiresAtMs: number;
  } {
    const now = this.clock();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) this.tickets.delete(id);
    }
    if (this.tickets.size >= MAX_LOGIN_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest !== undefined) this.tickets.delete(oldest);
    }
    const challengeId = newId();
    const expiresAtMs = now + MFA_LOGIN_TTL_MS;
    this.tickets.set(challengeId, { ...value, expiresAtMs, attempts: 0 });
    return { challengeId, expiresAtMs };
  }

  /** 拿票（不消耗）；不存在、过期、来源不对都是 `mfa_challenge_expired`。 */
  loginTicket(challengeId: string, origin: string): MfaLoginTicket {
    const ticket = this.tickets.get(challengeId);
    if (
      ticket === undefined ||
      ticket.expiresAtMs <= this.clock() ||
      ticket.origin !== origin
    ) {
      if (ticket !== undefined && ticket.expiresAtMs <= this.clock()) {
        this.tickets.delete(challengeId);
      }
      throw new IdentityRefusal(
        "unauthenticated",
        401,
        "mfa_challenge_expired",
        "The sign-in step expired; enter the password again",
      );
    }
    return ticket;
  }

  /** 第二因素不对：计一次，满了作废这张票。 */
  failLogin(challengeId: string): void {
    const ticket = this.tickets.get(challengeId);
    if (ticket === undefined) return;
    ticket.attempts += 1;
    if (ticket.attempts >= MFA_LOGIN_ATTEMPTS) this.tickets.delete(challengeId);
  }

  finishLogin(challengeId: string): void {
    this.tickets.delete(challengeId);
  }
}

export { RECOVERY_CODE_COUNT };
