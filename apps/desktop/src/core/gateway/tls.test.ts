import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
/**
 * 服务器壳只装在 Linux / macOS 上（systemd / launchd）。NTFS 没有 POSIX 权限位，
 * Windows 也不按 shebang 执行脚本，这几条断言在那里没有对应的事实——CI 的
 * windows-x86_64 会跑这份用例，所以显式跳过，而不是让它们报一个没有意义的红。
 */
const posixOnly = it.skipIf(process.platform === "win32");

import { oid, tlv } from "./der";
import {
  LOCAL_CA_CERT,
  LOCAL_CA_KEY,
  LOCAL_LEAF_KEY,
  SELF_SIGNED_CERT,
  SELF_SIGNED_DIR,
  SELF_SIGNED_KEY,
  fingerprintOf,
  pemBlocks,
  resolveTls,
  selfSignedCertificate,
} from "./tls";
import { tempDir } from "../testing/temp-dir";

function temporary(): string {
  return tempDir("armadra-tls-");
}

describe("DER 写入器", () => {
  it("长度按 DER 的定长规则编码", () => {
    expect(tlv(0x04, Buffer.alloc(3)).subarray(0, 2)).toEqual(
      Buffer.from([0x04, 0x03]),
    );
    expect(tlv(0x04, Buffer.alloc(200)).subarray(0, 3)).toEqual(
      Buffer.from([0x04, 0x81, 0xc8]),
    );
    expect(tlv(0x04, Buffer.alloc(300)).subarray(0, 4)).toEqual(
      Buffer.from([0x04, 0x82, 0x01, 0x2c]),
    );
  });

  it("OID 的前两段合并，其余是 base-128", () => {
    // 1.2.840.113549 —— RSA 的那个前缀，每个 ASN.1 教材的第一个例子。
    expect(oid("1.2.840.113549")).toEqual(
      Buffer.from([0x06, 0x06, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]),
    );
    expect(() => oid("1")).toThrow();
  });
});

describe("自签名证书", () => {
  it("生成的字节 node:crypto 自己解得回来", () => {
    const now = new Date("2026-09-20T00:00:00Z");
    const { cert, key } = selfSignedCertificate(
      ["armadra.example", "127.0.0.1", "::1"],
      now,
    );
    const parsed = new X509Certificate(cert);
    expect(parsed.subject).toContain("armadra.example");
    expect(parsed.subject).toBe(parsed.issuer);
    expect(parsed.subjectAltName).toContain("DNS:armadra.example");
    expect(parsed.subjectAltName).toContain("127.0.0.1");
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(parsed.validFrom).getTime()).toBeLessThan(now.getTime());
    // 自己签的：用自己的公钥验得过。
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true);
  });

  posixOnly("没给证书就在数据目录里生成一张，私钥 0600，并标注自签名", () => {
    const dataDir = temporary();
    const material = resolveTls({
      dataDir,
      hosts: ["127.0.0.1"],
    });
    expect(material.selfSigned).toBe(true);
    expect(material.certFile).toBe(
      join(dataDir, SELF_SIGNED_DIR, SELF_SIGNED_CERT),
    );
    expect(statSync(material.keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, SELF_SIGNED_DIR)).mode & 0o777).toBe(0o700);

    // 第二次启动复用同一张，不是每次换一张。
    const again = resolveTls({ dataDir, hosts: ["127.0.0.1"] });
    expect(again.cert).toBe(material.cert);
    // 但多一个名字就得重签——对不上主机名的证书等于没有证书。
    const widened = resolveTls({
      dataDir,
      hosts: ["127.0.0.1", "armadra.example"],
    });
    expect(widened.cert).not.toBe(material.cert);
  });

  it("运维给的证书原样用，缺一半是错误", () => {
    const dataDir = temporary();
    const generated = resolveTls({ dataDir, hosts: ["127.0.0.1"] });
    const reused = resolveTls({
      dataDir: temporary(),
      hosts: ["127.0.0.1"],
      certFile: generated.certFile,
      keyFile: generated.keyFile,
    });
    expect(reused.selfSigned).toBe(false);
    expect(reused.cert).toBe(readFileSync(generated.certFile, "utf8"));
    expect(() =>
      resolveTls({
        dataDir,
        hosts: ["127.0.0.1"],
        certFile: generated.certFile,
      }),
    ).toThrow(/成对/);
    expect(generated.keyFile).toBe(
      join(dataDir, SELF_SIGNED_DIR, SELF_SIGNED_KEY),
    );
  });
});

describe("本地 CA 与叶证书", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  const local = (dataDir: string, hosts: string[], at = now) =>
    resolveTls({ dataDir, hosts, generated: "localCa", now: () => at });

  it("叶证书由 CA 签发，链在 node:crypto 那里验得过", () => {
    const dataDir = temporary();
    const material = local(dataDir, ["armadra-mac.local", "192.168.1.20"]);
    expect(material.source).toBe("localCa");
    expect(material.selfSigned).toBe(false);
    const ca = new X509Certificate(material.anchor as string);
    const leaf = new X509Certificate(material.cert);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.issuer).toBe(ca.subject);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toContain("DNS:armadra-mac.local");
    expect(leaf.subjectAltName).toContain("IP Address:192.168.1.20");
    expect(leaf.keyUsage ?? []).toContain("1.3.6.1.5.5.7.3.1");
    expect(leaf.checkPrivateKey(createPrivateKey(material.key))).toBe(true);
    // 信任锚是 CA：原生 App 钉的是它，叶证书重签不影响配对。
    expect(material.fingerprint).toBe(fingerprintOf(ca));
    expect(material.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(material.names).toEqual(["armadra-mac.local", "192.168.1.20"]);
  });

  posixOnly("CA 与叶证书的私钥都是 0600，目录 0700", () => {
    const dataDir = temporary();
    local(dataDir, ["127.0.0.1"]);
    const directory = join(dataDir, SELF_SIGNED_DIR);
    expect(statSync(join(directory, LOCAL_CA_KEY)).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, LOCAL_LEAF_KEY)).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("CA 稳定：重启与地址变化都不换 CA", () => {
    const dataDir = temporary();
    const first = local(dataDir, ["127.0.0.1", "192.168.1.20"]);
    const again = local(dataDir, ["127.0.0.1", "192.168.1.20"]);
    // 同样的名字：叶证书也原样复用。
    expect(again.cert).toBe(first.cert);
    const moved = local(dataDir, ["127.0.0.1", "10.0.0.7"]);
    expect(moved.anchor).toBe(first.anchor);
    expect(moved.fingerprint).toBe(first.fingerprint);
    expect(
      readFileSync(join(dataDir, SELF_SIGNED_DIR, LOCAL_CA_CERT), "utf8"),
    ).toBe(first.anchor);
  });

  it("叶证书随地址重签：多出一个地址就换，少一个不必换", () => {
    const dataDir = temporary();
    const first = local(dataDir, ["127.0.0.1", "192.168.1.20"]);
    const narrower = local(dataDir, ["127.0.0.1"]);
    expect(narrower.cert).toBe(first.cert);
    const moved = local(dataDir, ["127.0.0.1", "10.0.0.7"]);
    expect(moved.cert).not.toBe(first.cert);
    expect(moved.names).toContain("10.0.0.7");
    expect(
      new X509Certificate(moved.cert).verify(
        new X509Certificate(first.anchor as string).publicKey,
      ),
    ).toBe(true);
  });

  it("快到期的叶证书提前重签，CA 仍是那一张", () => {
    const dataDir = temporary();
    const first = local(dataDir, ["127.0.0.1"]);
    const later = new Date(now.getTime() + 380 * 24 * 60 * 60 * 1000);
    const renewed = local(dataDir, ["127.0.0.1"], later);
    expect(renewed.cert).not.toBe(first.cert);
    expect(renewed.fingerprint).toBe(first.fingerprint);
  });

  it("CA 的证书与私钥对不上时拒绝，不悄悄换一张", () => {
    const dataDir = temporary();
    local(dataDir, ["127.0.0.1"]);
    const other = selfSignedCertificate(["x.example"], now);
    writeFileSync(join(dataDir, SELF_SIGNED_DIR, LOCAL_CA_KEY), other.key);
    expect(() => local(dataDir, ["127.0.0.1"])).toThrow(/对不上/);
  });

  it("指定文件：指纹是叶证书的，链里的最后一张是信任锚", () => {
    const dataDir = temporary();
    const issued = local(dataDir, ["127.0.0.1"]);
    const chainFile = join(dataDir, "chain.pem");
    writeFileSync(chainFile, `${issued.cert}${issued.anchor as string}`);
    const fromFile = resolveTls({
      dataDir: temporary(),
      hosts: ["127.0.0.1"],
      certFile: chainFile,
      keyFile: issued.keyFile,
    });
    expect(fromFile.source).toBe("file");
    expect(fromFile.fingerprint).toBe(fingerprintOf(issued.cert));
    expect(fromFile.anchor).toBe(issued.anchor);
    expect(pemBlocks(fromFile.cert)).toHaveLength(2);
    // 只有一张叶证书时没有可以发出去的根。
    const leafOnly = join(dataDir, "leaf-only.pem");
    writeFileSync(leafOnly, issued.cert);
    expect(
      resolveTls({
        dataDir,
        hosts: [],
        certFile: leafOnly,
        keyFile: issued.keyFile,
      }).anchor,
    ).toBeUndefined();
  });
});
