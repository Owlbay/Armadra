import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReplayCache } from "@armadra/platform-protocol/assertion";
import {
  FIXED_NOW_MS,
  TEST_KEYS,
  readTextFixture,
} from "@armadra/platform-protocol/fixtures";

import { openFreshDatabase } from "../../db/fresh.fixture";
import type { OpenedDatabase } from "../../db/open";
import { CoreFailure } from "../../http/errors";
import { tempDir } from "../../testing/temp-dir";
import { migrationsDir } from "../../workspaces/fixture";
import { IdentityStore } from "../store";
import { AssertionVerifier } from "./assertion";
import { signAssertion } from "./fake.fixture";
import { JWKS_REFRESH_INTERVAL_MS, JwksCache } from "./jwks";
import { CloudStore, type RegistrationRow } from "./store";

/**
 * 断言验证（平台规格 core 包 §2.7）：协议包的黄金断言全部按预期通过或拒绝；
 * 验签失败、过期、`jti` 重放、受众不符都拒；离线验签；`kid` 未知刷新一次。
 */

const ISSUER = TEST_KEYS.issuer.issuer;
const HOST = TEST_KEYS.source.sourceId;
const OWNER = "a".repeat(32);

let opened: OpenedDatabase;
let cloud: CloudStore;
let now: number;
let fetched: number;
let fetchResult: () => Promise<{ keys: Record<string, unknown>[] }>;
let verifier: AssertionVerifier;

function registration(overrides: Partial<RegistrationRow> = {}) {
  const row: RegistrationRow = {
    issuer: ISSUER,
    sourceKeyRef: "armadra-cloud-source-key",
    jwksJson: JSON.stringify({ keys: [TEST_KEYS.issuer.publicJwk] }),
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    jwksFetchedAtMs: FIXED_NOW_MS,
    trustedOrigins: [],
    relayOrigins: [],
    ownerAccountId: "",
    label: "",
    mode: "personal",
    registeredBy: OWNER,
    registeredAtMs: FIXED_NOW_MS,
    revokedAtMs: 0,
    ...overrides,
  };
  cloud.put(row);
  return row;
}

beforeEach(() => {
  opened = openFreshDatabase(
    join(tempDir("armadra-cloud-assertion-"), "canvas.db"),
    migrationsDir(),
  );
  new IdentityStore(opened.database).transaction((tx) =>
    tx.createOwner({ principalId: OWNER, createdAtMs: 1 }),
  );
  cloud = new CloudStore(opened.database);
  now = FIXED_NOW_MS;
  fetched = 0;
  fetchResult = async () => {
    throw new Error("offline");
  };
  const jwks = new JwksCache(
    cloud,
    async () => {
      fetched += 1;
      return (await fetchResult()) as never;
    },
    () => now,
  );
  verifier = new AssertionVerifier({
    store: cloud,
    jwks,
    hostId: () => HOST,
    now: () => now,
    replay: new ReplayCache(10 * 60 * 1000),
  });
  registration();
});

afterEach(() => opened.close());

async function code(token: string): Promise<string> {
  try {
    await verifier.verify(token);
    return "ok";
  } catch (error) {
    return error instanceof CoreFailure ? error.code : String(error);
  }
}

describe("协议包的黄金断言", () => {
  it("valid / guest / with-link 通过，声明照原样给出", async () => {
    const valid = await verifier.verify(
      readTextFixture("assertion/valid.jwt").trim(),
    );
    expect(valid.claims.sub).toBe("acct_01JAAAAAAAAAAAAAAAAAAAAAAA");
    expect(valid.claims.aud).toBe(HOST);
    expect(valid.registration.issuer).toBe(ISSUER);
    const guest = await verifier.verify(
      readTextFixture("assertion/guest.jwt").trim(),
    );
    expect(guest.claims.link?.invitationId).toBe("inv_01");
    const linked = await verifier.verify(
      readTextFixture("assertion/with-link.jwt").trim(),
    );
    expect(linked.claims.org?.role).toBe("member");
  });

  it("expired / wrong-aud / wrong-alg 一律 cloud_assertion_invalid", async () => {
    for (const name of ["expired", "wrong-aud", "wrong-alg"]) {
      expect(
        await code(readTextFixture(`assertion/${name}.jwt`).trim()),
        name,
      ).toBe("cloud_assertion_invalid");
    }
  });

  it("别的令牌（访问、中继、隧道、源 JWS）不是断言", async () => {
    for (const name of [
      "access-token",
      "relay-token",
      "tunnel-token",
      "source-jws",
    ]) {
      expect(
        await code(readTextFixture(`assertion/${name}.jwt`).trim()),
        name,
      ).toBe("cloud_assertion_invalid");
    }
  });

  it("同一张用第二次：cloud_assertion_replayed", async () => {
    const valid = readTextFixture("assertion/valid.jwt").trim();
    expect(await code(valid)).toBe("ok");
    expect(await code(valid)).toBe("cloud_assertion_replayed");
  });

  it("篡改过的（换了 sub、签名照旧）验签不过", async () => {
    const [head, body, signature] = readTextFixture("assertion/valid.jwt")
      .trim()
      .split(".");
    const claims = JSON.parse(
      Buffer.from(body as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    claims.sub = "acct:someone-else";
    const forged = `${head}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect(await code(forged)).toBe("cloud_assertion_invalid");
    expect(await code("not.a.jws")).toBe("cloud_assertion_invalid");
    expect(await code("")).toBe("cloud_assertion_invalid");
  });

  it("验不过的断言不占重放表：之后同一个 jti 的真断言照样能用", async () => {
    const [head, body] = readTextFixture("assertion/valid.jwt")
      .trim()
      .split(".");
    expect(await code(`${head}.${body}.AAAA`)).toBe("cloud_assertion_invalid");
    expect(await code(readTextFixture("assertion/valid.jwt").trim())).toBe(
      "ok",
    );
  });
});

describe("签发方与时间", () => {
  it("没登记或已撤销的 issuer：cloud_not_registered", async () => {
    expect(
      await code(
        signAssertion({ aud: HOST, nowMs: now, iss: "https://x.test" }),
      ),
    ).toBe("cloud_not_registered");
    cloud.revoke(ISSUER, now);
    expect(
      await code(signAssertion({ aud: HOST, nowMs: now, iss: ISSUER })),
    ).toBe("cloud_not_registered");
  });

  it("受众不是本机：拒", async () => {
    expect(
      await code(
        signAssertion({ aud: "f".repeat(32), nowMs: now, iss: ISSUER }),
      ),
    ).toBe("cloud_assertion_invalid");
  });

  it("时间：5 分钟偏差内通过，过期与未生效拒，寿命超过重放窗口拒", async () => {
    const token = signAssertion({ aud: HOST, nowMs: now, iss: ISSUER });
    now += 300_000 + 299_000;
    expect(await code(token)).toBe("ok");
    const late = signAssertion({ aud: HOST, nowMs: now, iss: ISSUER });
    now += 300_000 + 301_000;
    expect(await code(late)).toBe("cloud_assertion_invalid");
    expect(
      await code(
        signAssertion({ aud: HOST, nowMs: now + 400_000, iss: ISSUER }),
      ),
    ).toBe("cloud_assertion_invalid");
    expect(
      await code(
        signAssertion({ aud: HOST, nowMs: now, iss: ISSUER, ttlS: 3600 }),
      ),
    ).toBe("cloud_assertion_invalid");
  });

  it("typ 不是断言：拒", async () => {
    expect(
      await code(
        signAssertion({
          aud: HOST,
          nowMs: now,
          iss: ISSUER,
          typ: "armadra-access",
        }),
      ),
    ).toBe("cloud_assertion_invalid");
  });
});

describe("JWKS 缓存", () => {
  it("离线：kid 在缓存里就不联网，照样验签通过", async () => {
    expect(
      await code(signAssertion({ aud: HOST, nowMs: now, iss: ISSUER })),
    ).toBe("ok");
    expect(fetched).toBe(0);
  });

  it("kid 未知刷新一次：换了钥的签发方验得过，缓存写回", async () => {
    const rotated = generateKeyPairSync("ed25519");
    const jwk = rotated.publicKey.export({ format: "jwk" }) as { x: string };
    fetchResult = async () => ({
      keys: [
        TEST_KEYS.issuer.publicJwk,
        { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: "k2", alg: "EdDSA" },
      ],
    });
    const token = signAssertion({
      aud: HOST,
      nowMs: now,
      iss: ISSUER,
      kid: "k2",
      key: rotated.privateKey,
    });
    expect(await code(token)).toBe("ok");
    expect(fetched).toBe(1);
    expect(cloud.live(ISSUER)?.jwksJson).toContain('"k2"');
    expect(cloud.live(ISSUER)?.jwksFetchedAtMs).toBe(now);
  });

  it("kid 未知且取不到：拒；10 分钟内不再取", async () => {
    const other = generateKeyPairSync("ed25519");
    const token = () =>
      signAssertion({
        aud: HOST,
        nowMs: now,
        iss: ISSUER,
        kid: "k9",
        key: other.privateKey,
      });
    expect(await code(token())).toBe("cloud_assertion_invalid");
    expect(await code(token())).toBe("cloud_assertion_invalid");
    expect(fetched).toBe(1);
    now += JWKS_REFRESH_INTERVAL_MS;
    expect(await code(token())).toBe("cloud_assertion_invalid");
    expect(fetched).toBe(2);
    // 缓存里原来的钥没被冲掉。
    expect(
      await code(signAssertion({ aud: HOST, nowMs: now, iss: ISSUER })),
    ).toBe("ok");
  });

  it("同一个 kid、别的钥签的：验签不过", async () => {
    const other = generateKeyPairSync("ed25519");
    expect(
      await code(
        signAssertion({
          aud: HOST,
          nowMs: now,
          iss: ISSUER,
          key: other.privateKey,
        }),
      ),
    ).toBe("cloud_assertion_invalid");
  });
});
