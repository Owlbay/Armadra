import { describe, expect, it, vi } from "vitest";

import type { SourceConnection } from "./connection";
import { mountSiblingSources } from "./mounts";
import { createSourceRegistry } from "./registry";
import type { CredentialProvider, SourceDescriptor } from "./types";

const row = (
  sourceId: string,
  over: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "relayed",
  label: sourceId.toUpperCase(),
  baseUrl: "",
  relayOrigin: "https://relay.example",
  cloudIssuer: "https://relay.example",
  fingerprint: "",
  orderIndex: 0,
  ...over,
});

const provider: CredentialProvider = {
  getAccess: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
};

function fake(descriptor: SourceDescriptor): SourceConnection {
  return {
    descriptor,
    status: { state: "idle", via: null, since: 0, lastError: null },
    subscribe: () => () => undefined,
    connect: async () => undefined,
    disconnect: () => undefined,
  } as unknown as SourceConnection;
}

describe("mountSiblingSources", () => {
  it("跳过选中的那台与本机行；本机源带选中那台的名字；按给的顺序挂", () => {
    const attach = vi.fn(() => () => undefined);
    const mount = mountSiblingSources({
      primary: row("a"),
      siblings: [row("c"), row("a"), row("local", { kind: "local" }), row("b")],
      provider,
      cloudAuth: { access: vi.fn(), invalidate: vi.fn() },
      install: (options) => createSourceRegistry({ ...options, connect: fake }),
      attach,
    })!;
    expect(mount.registry.list().map((c) => c.descriptor.sourceId)).toEqual([
      "local",
      "c",
      "b",
    ]);
    expect(mount.registry.local().descriptor.label).toBe("A");
    expect(attach).toHaveBeenCalledTimes(1);
    mount.dispose();
    expect(mount.registry.list()).toHaveLength(1);
  });

  it("只有选中的那台：不换源表，答 null", () => {
    const install = vi.fn();
    expect(
      mountSiblingSources({
        primary: row("a"),
        siblings: [row("a")],
        provider,
        install,
      }),
    ).toBeNull();
    expect(install).not.toHaveBeenCalled();
  });
});
