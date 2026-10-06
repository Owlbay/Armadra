import { describe, expect, it } from "vitest";

import { resolveTls } from "../core/gateway/tls";
import { tempDir } from "../core/testing/temp-dir";
import { contentSecurityPolicy, sourceConnectGrants } from "./csp";
import {
  EMPTY_TRUST,
  pinnedChainTrusted,
  addsOrigins,
  trustFromSourceTable,
} from "./remote-trust";

/**
 * 壳的远程信任只看 core 的源表：放行的来源、按指纹钉扎的证书链。
 */

const FP_RELAY = "a".repeat(64);
const FP_GATEWAY = "b".repeat(64);

const table = {
  sources: [
    { sourceId: "local", kind: "local", baseUrl: "", relayOrigin: "" },
    {
      sourceId: "peer",
      kind: "direct",
      baseUrl: "https://192.168.1.20:8443",
      relayOrigin: "",
      fingerprint: FP_GATEWAY,
    },
    {
      sourceId: "far",
      kind: "relayed",
      baseUrl: "",
      relayOrigin: "https://relay.test:8102",
      fingerprint: "",
    },
    { sourceId: "bad", kind: "direct", baseUrl: "javascript:alert(1)" },
  ],
  remotes: [
    {
      serviceId: "s1",
      kind: "personal",
      issuer: "https://relay.test:8102",
      fingerprint: FP_RELAY,
    },
    { serviceId: "s2", kind: "personal", issuer: "http://example.com" },
  ],
};

describe("源表 → 放行与钉扎", () => {
  it("远程服务与源的 https 来源都放行；中继沿用远程服务的指纹", () => {
    const trust = trustFromSourceTable(table);
    expect(trust.origins).toEqual([
      "https://192.168.1.20:8443",
      "https://relay.test:8102",
    ]);
    expect(trust.pins).toEqual([
      { host: "192.168.1.20", fingerprint: FP_GATEWAY },
      { host: "relay.test", fingerprint: FP_RELAY },
    ]);
  });

  it("零配置或认不出的答案：什么也不放行", () => {
    expect(trustFromSourceTable({ sources: [{ kind: "local" }] })).toEqual(
      EMPTY_TRUST,
    );
    expect(trustFromSourceTable(null)).toEqual(EMPTY_TRUST);
    expect(addsOrigins(trustFromSourceTable(undefined), EMPTY_TRUST)).toBe(
      false,
    );
    // 多了来源才要重载；少了不必。
    const full = trustFromSourceTable(table);
    expect(addsOrigins(full, EMPTY_TRUST)).toBe(true);
    expect(addsOrigins(EMPTY_TRUST, full)).toBe(false);
  });

  it("connect-src 追加 https 与 wss；不是来源形状的值丢掉", () => {
    const grants = sourceConnectGrants([
      "https://relay.test:8102",
      "https://relay.test:8102/path",
      "http://evil.test",
      "not a url",
    ]);
    expect(grants).toEqual([
      "https://relay.test:8102",
      "wss://relay.test:8102",
    ]);
    const policy = contentSecurityPolicy({
      connect: [...grants, "https://x.test; script-src *", "https://*.test"],
    });
    const connect = policy
      .split("; ")
      .find((entry) => entry.startsWith("connect-src "));
    expect(connect).toContain("https://relay.test:8102 wss://relay.test:8102");
    expect(policy).not.toContain("x.test");
    expect(policy).not.toContain("*.test");
    expect(
      policy.split("; ").filter((one) => one.startsWith("script-src")),
    ).toHaveLength(0);
    // 不给就是原来那一份。
    expect(contentSecurityPolicy({ connect: [] })).toBe(
      contentSecurityPolicy(),
    );
  });
});

describe("按指纹钉扎的证书链", () => {
  const tls = resolveTls({
    dataDir: tempDir("armadra-trust-"),
    hosts: ["127.0.0.1", "localhost"],
    generated: "localCa",
  });
  const chain = [tls.cert, tls.anchor ?? ""];
  const pins = [{ host: "127.0.0.1", fingerprint: tls.fingerprint }];

  it("链里有登记的信任锚、逐级验签、名字对：可信", () => {
    expect(pinnedChainTrusted("127.0.0.1", chain, pins)).toBe(true);
    expect(
      pinnedChainTrusted("localhost", chain, [
        { host: "localhost", fingerprint: tls.fingerprint },
      ]),
    ).toBe(true);
  });

  it("别的主机、别的指纹、名字不对、过期、链断：一律不可信", () => {
    expect(pinnedChainTrusted("10.0.0.1", chain, pins)).toBe(false);
    expect(
      pinnedChainTrusted("127.0.0.1", chain, [
        { host: "127.0.0.1", fingerprint: "c".repeat(64) },
      ]),
    ).toBe(false);
    // 叶证书的名字里没有这个主机。
    expect(
      pinnedChainTrusted("other.test", chain, [
        { host: "other.test", fingerprint: tls.fingerprint },
      ]),
    ).toBe(false);
    expect(
      pinnedChainTrusted("127.0.0.1", chain, pins, Date.parse("2200-01-01")),
    ).toBe(false);
    // 另一套 CA 的叶证书配这一张信任锚：验签不过。
    const other = resolveTls({
      dataDir: tempDir("armadra-trust-other-"),
      hosts: ["127.0.0.1"],
      generated: "localCa",
    });
    expect(
      pinnedChainTrusted("127.0.0.1", [other.cert, tls.anchor ?? ""], pins),
    ).toBe(false);
    expect(pinnedChainTrusted("127.0.0.1", ["garbage"], pins)).toBe(false);
    expect(pinnedChainTrusted("127.0.0.1", [], pins)).toBe(false);
  });
});
