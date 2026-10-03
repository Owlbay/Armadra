import { describe, expect, it } from "vitest";
import {
  gatewayConfigPatchSchema,
  gatewayPairingPayloadSchema,
  gatewayStatusSchema,
  gatewayWsTicketSchema,
} from "../src/index.js";

describe("gateway api (contract §17)", () => {
  it("parses a running status and a stopped one", () => {
    const running = gatewayStatusSchema.parse({
      enabled: true,
      running: true,
      managedBy: "settings",
      listen: "private",
      port: 8443,
      publicOrigin: "",
      address: { host: "0.0.0.0", port: 8443 },
      origin: "https://192.168.1.20:8443",
      origins: ["https://192.168.1.20:8443", "https://127.0.0.1:8443"],
      tls: {
        source: "localCa",
        certFile: "",
        keyFile: "",
        acmeEmail: "",
        fingerprint: "ab".repeat(32),
        subject: "CN=192.168.1.20",
        names: ["192.168.1.20"],
        notAfter: "2027-11-04T00:00:00.000Z",
        caAvailable: true,
      },
      error: null,
    });
    expect(running.tls.source).toBe("localCa");
    const stopped = gatewayStatusSchema.parse({
      ...running,
      running: false,
      managedBy: "shell",
      address: null,
      origin: null,
      origins: [],
      tls: {
        ...running.tls,
        source: "selfSigned",
        fingerprint: null,
        subject: null,
        names: [],
        notAfter: null,
        caAvailable: false,
      },
      error: { code: "port_in_use", message: "x" },
    });
    expect(stopped.error?.code).toBe("port_in_use");
  });

  it("a config patch is a strict subset of gateway.*", () => {
    expect(gatewayConfigPatchSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(
      gatewayConfigPatchSchema.safeParse({ listen: "public" }).success,
    ).toBe(false);
    expect(gatewayConfigPatchSchema.safeParse({ other: 1 }).success).toBe(
      false,
    );
    expect(
      gatewayConfigPatchSchema.safeParse({ tls: { source: "acme" } }).success,
    ).toBe(true);
  });

  it("pairing payload and ws ticket", () => {
    expect(
      gatewayPairingPayloadSchema.safeParse({
        origin: "https://127.0.0.1:8443",
        ticket: "t",
        fingerprint: "ab".repeat(32),
        expiresAt: "2026-10-03T00:02:00.000Z",
        webUrl: `https://127.0.0.1:8443/#pair=t&fp=${"ab".repeat(32)}`,
        deepLink: "armadra://pair?host=127.0.0.1%3A8443&ticket=t&fp=ab",
      }).success,
    ).toBe(true);
    expect(
      gatewayWsTicketSchema.parse({
        ticket: "x",
        expiresAt: "2026-10-03T00:00:30.000Z",
      }).ticket,
    ).toBe("x");
  });
});
