/**
 * 源访问断言的验证（平台规格 core 包 §2.4 的 1–3 步，契约 §31）。
 *
 * 顺序有讲究：先拆（格式、`alg` 只认 EdDSA、`typ` 只认断言）、按 `iss` 找登记、
 * 按 `kid` 找钥、验签；签名对了才看声明（`aud` = 本机 `hostId`、时间带 5 分钟
 * 偏差、寿命不超过重放窗口），最后才记 `jti`——一张验不过的断言不该占掉重放表
 * 里的位置，也不该让人借它探出「这个 `jti` 用过没有」。
 *
 * 拒绝只有三种码：`cloud_not_registered`（签发方没登记或已撤销）、
 * `cloud_assertion_replayed`（同一张用第二次）、其余一律 `cloud_assertion_invalid`。
 * 断言原文不进日志与错误详情。
 */

import { verify } from "node:crypto";

import {
  type AssertionClaims,
  ReplayCache,
  TOKEN_TYPES,
  assertionClaimsSchema,
  checkAudience,
  checkTimes,
  splitCompactJws,
} from "@armadra/platform-protocol/assertion";
import { ASSERTION } from "@armadra/platform-protocol/identity-vectors";

import { fail } from "../../http/errors";
import type { JwksCache } from "./jwks";
import type { CloudStore, RegistrationRow } from "./store";

export interface VerifiedAssertion {
  readonly claims: AssertionClaims;
  readonly registration: RegistrationRow;
}

export interface AssertionVerifierOptions {
  readonly store: CloudStore;
  readonly jwks: JwksCache;
  /** 本机 `hostId`：断言的 `aud` 必须是它。 */
  readonly hostId: () => string;
  readonly now?: () => number;
  /** 测试换一张小的表。 */
  readonly replay?: ReplayCache;
}

function invalid(message: string): never {
  throw fail("cloud_assertion_invalid", message);
}

export class AssertionVerifier {
  private readonly now: () => number;
  private readonly replay: ReplayCache;

  constructor(private readonly options: AssertionVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.replay =
      options.replay ?? new ReplayCache(ASSERTION.replayWindowMs, 100_000);
  }

  async verify(token: string): Promise<VerifiedAssertion> {
    let parts: ReturnType<typeof splitCompactJws>;
    try {
      parts = splitCompactJws(token);
    } catch {
      return invalid("断言格式不对或签名算法不是 EdDSA");
    }
    if (parts.header.typ !== TOKEN_TYPES.assertion) {
      return invalid("这不是一张源访问断言");
    }
    const issuer = parts.payload.iss;
    const registration =
      typeof issuer === "string" ? this.options.store.live(issuer) : undefined;
    if (registration === undefined) {
      throw fail(
        "cloud_not_registered",
        "这台机器没有登记到签发这张断言的远程服务",
      );
    }
    const key = await this.options.jwks.key(registration, parts.header.kid);
    if (key === undefined) return invalid("不认识签这张断言的钥");
    let signed = false;
    try {
      signed = verify(null, parts.signingInput, key, parts.signature);
    } catch {
      signed = false;
    }
    if (!signed) return invalid("断言的签名不对");

    const parsed = assertionClaimsSchema.safeParse(parts.payload);
    if (!parsed.success) return invalid("断言的声明不完整");
    const claims = parsed.data;
    const nowMs = this.now();
    const check = {
      nowMs,
      skewMs: ASSERTION.skewMs,
      expectedAud: this.options.hostId(),
      expectedIss: registration.issuer,
    };
    if (checkAudience(claims, check) !== null) {
      return invalid("断言不是签给这台机器的");
    }
    if (checkTimes(claims, check) !== null) {
      return invalid("断言已过期或还没生效");
    }
    // 寿命超过重放窗口的断言，过了窗口就能再用一次：签发方不该签这样的。
    if ((claims.exp - claims.iat) * 1000 > ASSERTION.replayWindowMs) {
      return invalid("断言的有效期过长");
    }
    if (
      this.replay.seen(
        `${registration.issuer}\u0000${claims.jti}`,
        claims.exp * 1000,
        nowMs,
      )
    ) {
      throw fail("cloud_assertion_replayed", "这张断言已经用过");
    }
    return { claims, registration };
  }
}
