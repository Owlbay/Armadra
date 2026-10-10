import { describe, expect, it } from "vitest";
import { identityFailure } from "./errors";
import {
  PASSKEY_CHALLENGE_TTL_MS,
  Passkeys,
  commonHostSuffix,
  resolveRelyingParty,
} from "./passkey";
import { SoftAuthenticator } from "./soft-authenticator.fixture";
import type { PasskeyRow } from "./store";

const ORIGIN = "https://localhost:8443";
const PRINCIPAL = "0123456789abcdef0123456789abcdef";

function refusal(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return identityFailure(error);
  }
  return undefined;
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return identityFailure(error);
  }
  return undefined;
}

describe("RP ID", () => {
  it("IP 主机答 passkey_unavailable_on_ip_host", () => {
    for (const origin of [
      "http://127.0.0.1:1420",
      "https://192.168.1.20:8443",
      "https://[::1]:8443",
    ]) {
      expect(
        refusal(() => resolveRelyingParty({ requestOrigin: origin })),
      ).toMatchObject({ status: 400, code: "passkey_unavailable_on_ip_host" });
    }
  });

  it("没配置时取请求来源的主机；identity.rpId 覆盖", () => {
    expect(resolveRelyingParty({ requestOrigin: ORIGIN }).rpId).toBe(
      "localhost",
    );
    expect(
      resolveRelyingParty({
        requestOrigin: "https://box.armadra.home.arpa",
        override: "armadra.home.arpa",
      }).rpId,
    ).toBe("armadra.home.arpa");
    expect(
      refusal(() =>
        resolveRelyingParty({
          requestOrigin: "https://elsewhere.test",
          override: "armadra.home.arpa",
        }),
      ),
    ).toMatchObject({ code: "passkey_rp_id_mismatch" });
  });

  it("多个公网来源取公共后缀；取不到退回第一个并如实报", () => {
    expect(commonHostSuffix(["a.example.com", "b.example.com"])).toBe(
      "example.com",
    );
    const shared = resolveRelyingParty({
      requestOrigin: "https://b.example.com",
      publicOrigins: ["https://a.example.com", "https://b.example.com:8443"],
    });
    expect(shared).toMatchObject({ rpId: "example.com", fallback: false });
    const split = resolveRelyingParty({
      requestOrigin: "https://one.test",
      publicOrigins: ["https://one.test", "https://two.example"],
    });
    expect(split).toMatchObject({ rpId: "one.test", fallback: true });
    // 只有一段的公共后缀（「com」）不算。
    expect(
      resolveRelyingParty({
        requestOrigin: "https://a.com",
        publicOrigins: ["https://a.com", "https://b.com"],
      }),
    ).toMatchObject({ rpId: "a.com", fallback: true });
  });
});

describe("软件认证器：注册 → 断言", () => {
  async function registered() {
    const passkeys = new Passkeys();
    const authenticator = new SoftAuthenticator();
    const rp = resolveRelyingParty({ requestOrigin: ORIGIN });
    const begun = await passkeys.registrationOptions({
      rp,
      principalId: PRINCIPAL,
      userName: "同事",
      existing: [],
      label: "笔记本",
    });
    expect(begun.options.rp.id).toBe("localhost");
    expect(begun.options.attestation).toBe("none");
    // 算法集写死，不随运行时是否支持后量子算法变（Node 24 起库缺省把 ML-DSA-44
    // 排第一，公钥超过 public_key 的 1024 字节上限）。
    expect(begun.options.pubKeyCredParams.map((param) => param.alg)).toEqual([
      -8, -7, -257,
    ]);
    const response = authenticator.create(begun.options, ORIGIN);
    const created = await passkeys.verifyRegistration({
      challengeId: begun.challengeId,
      principalId: PRINCIPAL,
      origin: ORIGIN,
      response,
    });
    const row: PasskeyRow = {
      credentialId: "c".repeat(32),
      principalId: PRINCIPAL,
      webauthnId: created.webauthnId,
      publicKey: created.publicKey,
      signCount: created.signCount,
      aaguid: created.aaguid,
      transports: created.transports,
      label: created.label,
      createdAtMs: 1,
      revokedAtMs: 0,
    };
    return { passkeys, authenticator, rp, row, created };
  }

  it("注册存下公钥与计数器，断言过了并答新计数器", async () => {
    const { passkeys, authenticator, rp, row, created } = await registered();
    expect(created.label).toBe("笔记本");
    expect(created.transports).toEqual(["internal"]);
    expect(created.signCount).toBe(0);
    const login = await passkeys.authenticationOptions(rp);
    expect(login.options.allowCredentials ?? []).toEqual([]);
    const assertion = authenticator.get(login.options, ORIGIN);
    const verified = await passkeys.verifyAuthentication({
      challengeId: login.challengeId,
      origin: ORIGIN,
      response: assertion,
      lookup: (id) => (id === row.webauthnId ? row : undefined),
    });
    expect(verified.row.principalId).toBe(PRINCIPAL);
    expect(verified.newCounter).toBe(1);
  });

  it("挑战一次性：同一个应答交两次，第二次拒", async () => {
    const { passkeys, authenticator, rp, row } = await registered();
    const login = await passkeys.authenticationOptions(rp);
    const assertion = authenticator.get(login.options, ORIGIN);
    const lookup = (id: string) => (id === row.webauthnId ? row : undefined);
    await passkeys.verifyAuthentication({
      challengeId: login.challengeId,
      origin: ORIGIN,
      response: assertion,
      lookup,
    });
    expect(
      await rejection(
        passkeys.verifyAuthentication({
          challengeId: login.challengeId,
          origin: ORIGIN,
          response: assertion,
          lookup,
        }),
      ),
    ).toMatchObject({ code: "passkey_challenge_expired" });
  });

  it("challenge 不对即拒", async () => {
    const { passkeys, authenticator, rp, row } = await registered();
    const login = await passkeys.authenticationOptions(rp);
    const assertion = authenticator.get(login.options, ORIGIN, {
      challenge: Buffer.from("not the challenge").toString("base64url"),
    });
    expect(
      await rejection(
        passkeys.verifyAuthentication({
          challengeId: login.challengeId,
          origin: ORIGIN,
          response: assertion,
          lookup: () => row,
        }),
      ),
    ).toMatchObject({ status: 401 });
  });

  it("origin 不对即拒（注册与断言两头）", async () => {
    const passkeys = new Passkeys();
    const authenticator = new SoftAuthenticator();
    const rp = resolveRelyingParty({ requestOrigin: ORIGIN });
    const begun = await passkeys.registrationOptions({
      rp,
      principalId: PRINCIPAL,
      userName: "同事",
      existing: [],
    });
    const forged = authenticator.create(
      begun.options,
      "https://evil.localhost:8443",
    );
    expect(
      await rejection(
        passkeys.verifyRegistration({
          challengeId: begun.challengeId,
          principalId: PRINCIPAL,
          origin: ORIGIN,
          response: forged,
        }),
      ),
    ).toMatchObject({ status: 400, code: "passkey_verification_failed" });

    const {
      passkeys: other,
      authenticator: key,
      rp: party,
      row,
    } = await registered();
    const login = await other.authenticationOptions(party);
    const assertion = key.get(login.options, "https://evil.localhost:8443");
    expect(
      await rejection(
        other.verifyAuthentication({
          challengeId: login.challengeId,
          origin: ORIGIN,
          response: assertion,
          lookup: () => row,
        }),
      ),
    ).toMatchObject({ status: 401 });
  });

  it("RP ID 不对即拒", async () => {
    const { passkeys, authenticator, rp, row } = await registered();
    const login = await passkeys.authenticationOptions(rp);
    const assertion = authenticator.get(login.options, ORIGIN, {
      rpId: "example.com",
    });
    expect(
      await rejection(
        passkeys.verifyAuthentication({
          challengeId: login.challengeId,
          origin: ORIGIN,
          response: assertion,
          lookup: () => row,
        }),
      ),
    ).toMatchObject({ status: 401 });
  });

  it("计数器回退（克隆的认证器）按库的判定拒", async () => {
    const { passkeys, authenticator, rp, row } = await registered();
    const stored = { ...row, signCount: 7 };
    const login = await passkeys.authenticationOptions(rp);
    const assertion = authenticator.get(login.options, ORIGIN, {
      signCount: 3,
    });
    expect(
      await rejection(
        passkeys.verifyAuthentication({
          challengeId: login.challengeId,
          origin: ORIGIN,
          response: assertion,
          lookup: () => stored,
        }),
      ),
    ).toMatchObject({ status: 401 });
  });

  it("别人要的注册挑战不能拿来登记到自己名下", async () => {
    const passkeys = new Passkeys();
    const authenticator = new SoftAuthenticator();
    const rp = resolveRelyingParty({ requestOrigin: ORIGIN });
    const begun = await passkeys.registrationOptions({
      rp,
      principalId: PRINCIPAL,
      userName: "同事",
      existing: [],
    });
    expect(
      await rejection(
        passkeys.verifyRegistration({
          challengeId: begun.challengeId,
          principalId: "f".repeat(32),
          origin: ORIGIN,
          response: authenticator.create(begun.options, ORIGIN),
        }),
      ),
    ).toMatchObject({ code: "passkey_verification_failed" });
  });

  it("挑战 2 分钟过期", async () => {
    let now = 1_000_000;
    const passkeys = new Passkeys(() => now);
    const rp = resolveRelyingParty({ requestOrigin: ORIGIN });
    const login = await passkeys.authenticationOptions(rp);
    now += PASSKEY_CHALLENGE_TTL_MS;
    expect(
      await rejection(
        passkeys.verifyAuthentication({
          challengeId: login.challengeId,
          origin: ORIGIN,
          response: {},
          lookup: () => undefined,
        }),
      ),
    ).toMatchObject({ code: "passkey_challenge_expired" });
  });
});
