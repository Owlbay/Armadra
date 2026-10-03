import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringToBytes } from "otplib";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../db/open";
import { plainFileBackend } from "../../secrets";
import { tempDir } from "../../testing/temp-dir";
import { identityFailure } from "../errors";
import { IdentityStore } from "../store";
import { newId } from "../tokens";
import { Mfa } from "./index";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
  matchRecoveryCode,
} from "./recovery";
import { totpAt, totpUri, verifyTotp } from "./totp";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../db/migrations");
const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** RFC 6238 附录 B，SHA-1、8 位，密钥是 ASCII "12345678901234567890"。 */
const RFC_SECRET = stringToBytes("12345678901234567890");
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it("RFC 6238 的 SHA-1 向量", () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpAt(RFC_SECRET, seconds * 1000, 8), String(seconds)).toBe(code);
      expect(
        verifyTotp({
          secret: RFC_SECRET,
          token: code,
          nowMs: seconds * 1000,
          digits: 8,
        }).ok,
      ).toBe(true);
    }
  });

  it("前后各容一个时间步，再远就拒", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const now = 1_700_000_015_000;
    const code = totpAt(secret, now);
    expect(verifyTotp({ secret, token: code, nowMs: now + 30_000 }).ok).toBe(
      true,
    );
    expect(verifyTotp({ secret, token: code, nowMs: now - 30_000 }).ok).toBe(
      true,
    );
    expect(verifyTotp({ secret, token: code, nowMs: now + 90_000 }).ok).toBe(
      false,
    );
    expect(verifyTotp({ secret, token: "12ab56", nowMs: now }).ok).toBe(false);
  });

  it("用过的时间步不能再用", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const now = 1_700_000_015_000;
    const first = verifyTotp({
      secret,
      token: totpAt(secret, now),
      nowMs: now,
    });
    expect(first.ok).toBe(true);
    const step = first.ok ? first.timeStep : 0;
    expect(
      verifyTotp({
        secret,
        token: totpAt(secret, now),
        nowMs: now,
        afterTimeStep: step,
      }).ok,
    ).toBe(false);
    expect(
      verifyTotp({
        secret,
        token: totpAt(secret, now + 30_000),
        nowMs: now + 30_000,
        afterTimeStep: step,
      }).ok,
    ).toBe(true);
  });

  it("otpauth URI 带签发方与参数", () => {
    const uri = totpUri("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "同事");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("issuer=Armadra");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });
});

describe("恢复码", () => {
  it("十个、互不相同、只认一次", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const rows = hashRecoveryCodes(codes).map((row) => ({
      ...row,
      usedAtMs: 0,
    }));
    const hit = matchRecoveryCode(
      codes[3]?.toUpperCase().replace("-", " ") ?? "",
      rows,
    );
    expect(hit).toBeDefined();
    const used = rows.map((row) =>
      row.codeHash.equals(hit as Buffer) ? { ...row, usedAtMs: 1 } : row,
    );
    expect(matchRecoveryCode(codes[3] as string, used)).toBeUndefined();
    expect(matchRecoveryCode("aaaaa-aaaaa", rows)).toBeUndefined();
    expect(matchRecoveryCode("short", rows)).toBeUndefined();
  });
});

describe("Mfa：登记、确认、校验、停用", () => {
  function fixture() {
    const directory = tempDir("armadra-mfa-");
    const opened = openDatabase({
      file: join(directory, "canvas.db"),
      migrationsDir,
    });
    closing.push(opened.close);
    const store = new IdentityStore(opened.database);
    const backend = plainFileBackend(join(directory, "secrets"));
    let now = 1_700_000_015_000;
    const principalId = newId();
    store.transaction((tx) =>
      tx.accounts.createPrincipal({
        principalId,
        kind: "member",
        displayName: "同事",
        createdAtMs: now,
        disabledAtMs: 0,
      }),
    );
    const mfa = new Mfa(
      store,
      () => backend,
      () => now,
    );
    return {
      mfa,
      store,
      backend,
      principalId,
      advance: (ms: number) => {
        now += ms;
      },
      now: () => now,
    };
  }

  it("密钥只在 SecretStore；确认后才算登记；同一个码不能用两次", async () => {
    const fix = fixture();
    const { secret, otpauthUri } = await fix.mfa.begin(fix.principalId, "同事");
    expect(otpauthUri).toContain(secret);
    expect(await fix.backend.get(`armadra-totp-${fix.principalId}`)).toBe(
      secret,
    );
    const row = fix.store.transaction((tx) => tx.mfa(fix.principalId));
    expect(row?.totpSecretRef).toBe(`armadra-totp-${fix.principalId}`);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(fix.mfa.status(fix.principalId)).toMatchObject({
      enrolled: false,
      pending: true,
    });

    const code = totpAt(secret, fix.now());
    const recovery = await fix.mfa.confirm(fix.principalId, code);
    expect(recovery).toHaveLength(10);
    expect(fix.mfa.status(fix.principalId)).toMatchObject({
      enrolled: true,
      recoveryCodesRemaining: 10,
    });

    // 确认用掉的那个时间步，登录时不能再用。
    await expect(fix.mfa.verify(fix.principalId, code)).rejects.toMatchObject({
      code: "mfa_invalid_code",
    });
    fix.advance(30_000);
    const next = totpAt(secret, fix.now());
    await expect(fix.mfa.verify(fix.principalId, next)).resolves.toBe("totp");
    await expect(fix.mfa.verify(fix.principalId, next)).rejects.toMatchObject({
      code: "mfa_invalid_code",
    });

    // 恢复码一次性。
    await expect(
      fix.mfa.verify(fix.principalId, recovery[0] as string),
    ).resolves.toBe("recovery");
    await expect(
      fix.mfa.verify(fix.principalId, recovery[0] as string),
    ).rejects.toMatchObject({ code: "mfa_invalid_code" });
    expect(fix.mfa.status(fix.principalId).recoveryCodesRemaining).toBe(9);

    // 已确认的不能直接覆盖。
    await expect(fix.mfa.begin(fix.principalId, "同事")).rejects.toMatchObject({
      code: "mfa_already_enrolled",
    });

    expect(await fix.mfa.disable(fix.principalId)).toBe(true);
    expect(
      await fix.backend.get(`armadra-totp-${fix.principalId}`),
    ).toBeUndefined();
    expect(fix.mfa.status(fix.principalId)).toMatchObject({
      enrolled: false,
      pending: false,
      recoveryCodesRemaining: 0,
    });
  });

  it("登录中间票：来源要对上，错满 5 次作废，过期作废", () => {
    const fix = fixture();
    const ticket = fix.mfa.beginLogin({
      principalId: fix.principalId,
      origin: "https://armadra.test",
      deviceName: "笔记本",
      remoteIp: "",
      userAgent: "",
    });
    expect(() =>
      fix.mfa.loginTicket(ticket.challengeId, "https://other.test"),
    ).toThrow();
    for (let index = 0; index < 5; index += 1) {
      fix.mfa.loginTicket(ticket.challengeId, "https://armadra.test");
      fix.mfa.failLogin(ticket.challengeId);
    }
    let caught: unknown;
    try {
      fix.mfa.loginTicket(ticket.challengeId, "https://armadra.test");
    } catch (error) {
      caught = error;
    }
    expect(identityFailure(caught)).toMatchObject({
      status: 401,
      code: "mfa_challenge_expired",
    });
    const second = fix.mfa.beginLogin({
      principalId: fix.principalId,
      origin: "https://armadra.test",
      deviceName: "笔记本",
      remoteIp: "",
      userAgent: "",
    });
    fix.advance(5 * 60 * 1000);
    expect(() =>
      fix.mfa.loginTicket(second.challengeId, "https://armadra.test"),
    ).toThrow();
  });
});
