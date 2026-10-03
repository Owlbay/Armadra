import { describe, expect, it } from "vitest";
import {
  acceptsConnection,
  bindHost,
  certificateHosts,
  gatewayHosts,
  interfaceAddresses,
  machineHostname,
  originsFor,
  privateAddress,
  privateAddresses,
} from "./network";

const INTERFACES = {
  lo0: [
    { address: "127.0.0.1", internal: true },
    { address: "::1", internal: true },
  ],
  en0: [
    { address: "192.168.1.20", internal: false },
    { address: "fe80::1", internal: false },
    { address: "fd12::5", internal: false },
  ],
  en1: [
    { address: "169.254.3.3", internal: false },
    { address: "203.0.113.9", internal: false },
  ],
  utun3: [{ address: "100.101.102.103", internal: false }],
} as unknown as Parameters<typeof privateAddresses>[0];

describe("Gateway 的地址", () => {
  it("私网：RFC 1918、CGNAT、ULA；公网、回环、链路本地都不算", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "100.64.0.1",
      "fd00::1",
      "::ffff:192.168.1.2",
    ]) {
      expect(privateAddress(address), address).toBe(true);
    }
    for (const address of [
      "172.32.0.1",
      "8.8.8.8",
      "127.0.0.1",
      "169.254.1.1",
      "fe80::1",
      "2001:db8::1",
    ]) {
      expect(privateAddress(address), address).toBe(false);
    }
  });

  it("网卡枚举：私网一档与全部一档", () => {
    expect(privateAddresses(INTERFACES)).toEqual([
      "100.101.102.103",
      "192.168.1.20",
      "fd12::5",
    ]);
    expect(interfaceAddresses(INTERFACES)).toEqual([
      "100.101.102.103",
      "192.168.1.20",
      "203.0.113.9",
      "fd12::5",
    ]);
  });

  it("绑定与按本地地址筛连接", () => {
    expect(bindHost("loopback")).toBe("127.0.0.1");
    expect(bindHost("private")).toBe("0.0.0.0");
    expect(bindHost("all")).toBe("0.0.0.0");
    const privates = ["192.168.1.20"];
    expect(acceptsConnection("private", "192.168.1.20", privates)).toBe(true);
    expect(acceptsConnection("private", "::ffff:192.168.1.20", privates)).toBe(
      true,
    );
    expect(acceptsConnection("private", "127.0.0.1", privates)).toBe(true);
    expect(acceptsConnection("private", "203.0.113.9", privates)).toBe(false);
    expect(acceptsConnection("private", undefined, privates)).toBe(false);
    expect(acceptsConnection("all", "203.0.113.9", privates)).toBe(true);
  });

  it("自己的主机：私网在前、主机名其次、回环最后；localhost 永远不在", () => {
    const addresses = {
      privates: ["192.168.1.20"],
      all: ["192.168.1.20", "203.0.113.9"],
    };
    expect(gatewayHosts("loopback", addresses, "mac.local")).toEqual([
      "127.0.0.1",
    ]);
    expect(gatewayHosts("private", addresses, "mac.local")).toEqual([
      "192.168.1.20",
      "mac.local",
      "127.0.0.1",
    ]);
    expect(gatewayHosts("all", addresses, "")).toEqual([
      "192.168.1.20",
      "203.0.113.9",
      "127.0.0.1",
    ]);
    expect(machineHostname("localhost")).toBeUndefined();
    expect(machineHostname("Yo-MacBook.local")).toBe("yo-macbook.local");
    expect(machineHostname("bad host")).toBeUndefined();
  });

  it("来源与证书名字", () => {
    expect(
      originsFor(["192.168.1.20", "fd12::5"], 8443, [
        "https://armadra.example",
      ]),
    ).toEqual([
      "https://armadra.example",
      "https://192.168.1.20:8443",
      "https://[fd12::5]:8443",
    ]);
    expect(
      certificateHosts(["0.0.0.0", "127.0.0.1"], ["https://[::1]:9443"]),
    ).toEqual(["::1", "127.0.0.1"]);
  });
});
