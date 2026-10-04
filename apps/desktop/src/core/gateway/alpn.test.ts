import { X509Certificate, createHash } from "node:crypto";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import {
  type PeerCertificate,
  type SecureVersion,
  connect as tlsConnect,
  createSecureContext,
} from "node:tls";
import { describe, expect, it } from "vitest";

import {
  ACME_TLS_PROTOCOL,
  type AcmeTlsResponder,
  identifierOf,
  interceptAcmeTls,
  parseClientHello,
  recordState,
} from "./alpn";
import {
  ACME_IDENTIFIER_OID,
  acmeChallengeCertificate,
  selfSignedCertificate,
} from "./tls";
import { oid, octetString } from "./der";

/** 一个真客户端发出的第一条记录。 */
async function capturedHello(options: {
  servername?: string;
  ALPNProtocols?: string[];
}): Promise<Buffer> {
  return new Promise((done, failed) => {
    const server = createNetServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const state = recordState(buffered);
        if (state.state === "complete") {
          socket.destroy();
          server.close();
          done(buffered.subarray(0, state.length));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const client = tlsConnect({
        port: (server.address() as AddressInfo).port,
        host: "127.0.0.1",
        rejectUnauthorized: false,
        ...options,
      });
      client.on("error", () => undefined);
    });
    server.on("error", failed);
  });
}

/** CA 那一侧：只报 `acme-tls/1` 的握手，拿回证书与协商结果。 */
function validate(
  port: number,
  servername: string,
  version: SecureVersion = "TLSv1.3",
): Promise<{ protocol: string | false | null; cert: PeerCertificate }> {
  return new Promise((done, failed) => {
    const socket = tlsConnect(
      {
        port,
        host: "127.0.0.1",
        servername,
        ALPNProtocols: [ACME_TLS_PROTOCOL],
        rejectUnauthorized: false,
        minVersion: version,
        maxVersion: version,
      },
      () => {
        const result = {
          protocol: socket.alpnProtocol,
          cert: socket.getPeerCertificate(),
        };
        socket.destroy();
        done(result);
      },
    );
    socket.on("error", failed);
  });
}

/** RFC 8737 §3 的那条扩展：OID、critical、值是 key authorization 的摘要。 */
function acmeExtension(raw: Buffer, keyAuthorization: string): boolean {
  const digest = createHash("sha256").update(keyAuthorization).digest();
  const expected = Buffer.concat([
    oid(ACME_IDENTIFIER_OID),
    Buffer.from([0x01, 0x01, 0xff]),
    octetString(octetString(digest)),
  ]);
  return raw.includes(expected);
}

describe("ClientHello", () => {
  it("取出 SNI 与 ALPN 列表", async () => {
    const record = await capturedHello({
      servername: "Armadra.Example.com",
      ALPNProtocols: ["h2", ACME_TLS_PROTOCOL],
    });
    expect(parseClientHello(record)).toEqual({
      servername: "armadra.example.com",
      protocols: ["h2", ACME_TLS_PROTOCOL],
    });
  });

  it("没带 SNI、没带 ALPN 也认", async () => {
    const record = await capturedHello({});
    expect(parseClientHello(record)).toEqual({
      servername: undefined,
      protocols: [],
    });
  });

  it("截断、不是握手、长度离谱都不当 ClientHello", async () => {
    const record = await capturedHello({ servername: "a.test" });
    expect(recordState(record.subarray(0, 3)).state).toBe("more");
    expect(recordState(record.subarray(0, record.length - 1)).state).toBe(
      "more",
    );
    expect(recordState(Buffer.from("GET / HTTP/1.1\r\n")).state).toBe("notTls");
    expect(recordState(Buffer.from([0x16, 3, 1, 0xff, 0xff])).state).toBe(
      "notTls",
    );
    const broken = Buffer.from(record);
    broken.writeUInt16BE(record.length, 3);
    expect(parseClientHello(broken)).toBeUndefined();
    expect(parseClientHello(Buffer.from([0x17, 3, 3, 0, 0]))).toBeUndefined();
  });

  it("IP 标识的反向解析名换回地址", () => {
    expect(identifierOf("4.3.2.198.in-addr.arpa")).toBe("198.2.3.4");
    expect(
      identifierOf(
        "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
      ),
    ).toBe("2001:db8::1");
    expect(identifierOf("Armadra.Example.com.")).toBe("armadra.example.com");
    expect(identifierOf("999.3.2.1.in-addr.arpa")).toBe(
      "999.3.2.1.in-addr.arpa",
    );
  });
});

describe("挑战证书", () => {
  it("自签名、SAN 只有这一个标识、带关键的 acmeIdentifier", () => {
    const keyAuthorization = "token.thumbprint";
    const { cert } = acmeChallengeCertificate(
      "armadra.example.com",
      keyAuthorization,
      new Date(),
    );
    const parsed = new X509Certificate(cert);
    expect(parsed.subjectAltName).toBe("DNS:armadra.example.com");
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(acmeExtension(parsed.raw, keyAuthorization)).toBe(true);
    expect(acmeExtension(parsed.raw, "other.thumbprint")).toBe(false);

    const ip = new X509Certificate(
      acmeChallengeCertificate(
        "198.51.100.7",
        keyAuthorization,
        new Date(),
      ).cert,
    );
    expect(ip.subjectAltName).toBe("IP Address:198.51.100.7");
  });
});

describe("Gateway 监听上的 tls-alpn-01", () => {
  async function gateway(responder: AcmeTlsResponder) {
    const own = selfSignedCertificate(["gateway.test"], new Date());
    const server = createHttpsServer(own, (_request, response) => {
      response.end("page");
    });
    interceptAcmeTls(server, responder);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return {
      port: (server.address() as AddressInfo).port,
      close: () =>
        new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
    };
  }

  const keyAuthorization = "token-9.thumbprint";
  const challenge = createSecureContext(
    acmeChallengeCertificate("armadra.test", keyAuthorization, new Date()),
  );

  function responder(pending = true): AcmeTlsResponder {
    return {
      pending: () => pending,
      context: (name) => (name === "armadra.test" ? challenge : undefined),
    };
  }

  function page(port: number): Promise<{ body: string; cn: string }> {
    return new Promise((done, failed) => {
      httpsGet(
        {
          host: "127.0.0.1",
          port,
          servername: "armadra.test",
          rejectUnauthorized: false,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            done({
              body: Buffer.concat(chunks).toString("utf8"),
              cn: (
                response.socket as unknown as {
                  getPeerCertificate(): PeerCertificate;
                }
              ).getPeerCertificate().subject.CN,
            }),
          );
        },
      ).on("error", failed);
    });
  }

  for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
    it(`${version}：验证握手拿到挑战证书并协商 acme-tls/1`, async () => {
      const server = await gateway(responder());
      try {
        const answer = await validate(server.port, "armadra.test", version);
        expect(answer.protocol).toBe(ACME_TLS_PROTOCOL);
        expect(answer.cert.subjectaltname).toBe("DNS:armadra.test");
        expect(acmeExtension(answer.cert.raw as Buffer, keyAuthorization)).toBe(
          true,
        );
      } finally {
        await server.close();
      }
    });
  }

  it("挑战挂着时普通请求照常进页面，证书是 Gateway 自己的", async () => {
    const server = await gateway(responder());
    try {
      expect(await page(server.port)).toEqual({
        body: "page",
        cn: "gateway.test",
      });
    } finally {
      await server.close();
    }
  });

  it("不在等的名字：验证握手被断开", async () => {
    const server = await gateway(responder());
    try {
      await expect(validate(server.port, "other.test")).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it("没有挑战挂着：acme-tls/1 直接进 TLS，协商不出来", async () => {
    const server = await gateway(responder(false));
    try {
      // TLS 那一侧只认 http/1.1：握手以 no_application_protocol 告终。
      await expect(validate(server.port, "armadra.test")).rejects.toThrow(
        /no application protocol/,
      );
      expect(await page(server.port)).toMatchObject({ body: "page" });
    } finally {
      await server.close();
    }
  });
});
