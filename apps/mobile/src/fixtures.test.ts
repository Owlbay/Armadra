import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type PushEnvelope,
  openPayload,
} from "../../desktop/src/core/push/crypto";

/**
 * `fixtures/` 是 iOS（`ios/ArmadraNativeKit` 的 XCTest）与 Android
 * （`android/armadra-native-core` 的 JUnit）共用的样本。这里守住它们与 core 的
 * 实现是同一回事：信封用 core 的解法解得开，证书指纹是 core 的拼法。
 */
const dir = join(import.meta.dirname, "../fixtures");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const fingerprint = (pem: string) =>
  createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");

describe("shared native fixtures", () => {
  it("push-envelope.json is what the core seals for that device key", () => {
    const fixture = JSON.parse(read("push-envelope.json")) as {
      privateKey: string;
      publicKey: string;
      plaintext: string;
      envelope: PushEnvelope;
    };
    const privateKey = createPrivateKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        d: fixture.privateKey,
        x: fixture.publicKey,
      },
      format: "jwk",
    });
    expect(openPayload(fixture.envelope, privateKey).toString("utf8")).toBe(
      fixture.plaintext,
    );
  });

  it("the leaf chains to ca.pem only and covers the loopback address", () => {
    const ca = new X509Certificate(read("ca.pem"));
    const other = new X509Certificate(read("other-ca.pem"));
    const leaf = new X509Certificate(read("leaf.pem"));
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.verify(other.publicKey)).toBe(false);
    expect(leaf.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(fingerprint(read("ca.pem"))).toBe(
      "82e388ac1ef80d0ab28831f8bf9e0d0cde8d6b376d100c773d899e31f3ba23ca",
    );
  });
});
