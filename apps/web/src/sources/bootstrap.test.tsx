import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../app/preferences-store";
import {
  applySourceTable,
  hydrateSourcesAtStartup,
  reloadIntoSettings,
  takeSettingsReopen,
} from "./bootstrap";
import type { SourceConnection } from "./connection";
import { createSourceRegistry } from "./registry";
import type { SourceDescriptor, SourceStatus } from "./types";

/**
 * 启动：零配置不读源表；挂过源才在启动时读；为放行新来源重载后回到设置。
 */

function connection(
  descriptor: SourceDescriptor,
  state: SourceStatus["state"],
): SourceConnection {
  const listeners = new Set<() => void>();
  let status: SourceStatus = {
    state: "idle",
    via: null,
    since: 0,
    lastError: null,
  };
  return {
    descriptor,
    get status() {
      return status;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    source: {} as SourceConnection["source"],
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    async connect() {
      status = { state, via: null, since: 1, lastError: null };
      for (const listener of listeners) listener();
    },
    disconnect() {},
    renew: async () => undefined,
  } as unknown as SourceConnection;
}

const row = (sourceId: string, kind: "local" | "direct" | "relayed") => ({
  sourceId,
  kind,
  label: `${sourceId}-label`,
  baseUrl: kind === "direct" ? `https://${sourceId}.test` : "",
  relayOrigin: kind === "relayed" ? "https://relay.test" : "",
  fingerprint: "",
  cloudIssuer: "",
  principalHint: "owner",
  addedAtMs: 1,
  lastOkAtMs: 1,
  orderIndex: 1,
  hasCredentials: true,
});

let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  fetch = vi.fn(async () => new Response(JSON.stringify({ sources: [] })));
  vi.stubGlobal("fetch", fetch);
  usePreferencesStore.setState({ locale: "en" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { armadra?: unknown }).armadra;
});

describe("启动", () => {
  it("零配置：不读源表、不发请求", () => {
    (window as { armadra?: unknown }).armadra = {};
    const registry = vi.fn(() => createSourceRegistry());
    expect(hydrateSourcesAtStartup(registry)).toBe(false);
    expect(registry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("设置页见过挂载的源之后：下次启动读一次源表；全删了又回到零配置", async () => {
    (window as { armadra?: unknown }).armadra = {};
    const registry = createSourceRegistry({
      connect: (d) => connection(d, "ready"),
    });
    await applySourceTable(
      [row("local", "local"), row("peer", "direct")] as never,
      registry,
    );
    expect(registry.list().map((one) => one.descriptor.sourceId)).toEqual([
      expect.any(String),
      "peer",
    ]);
    const hydrate = vi.spyOn(registry, "hydrate");
    expect(hydrateSourcesAtStartup(() => registry)).toBe(true);
    expect(hydrate).toHaveBeenCalledTimes(1);

    await applySourceTable([row("local", "local")] as never, registry);
    expect(hydrateSourcesAtStartup(() => registry)).toBe(false);
    registry.dispose();
  });

  it("浏览器（非桌面、非服务器壳）不读", async () => {
    await applySourceTable(
      [row("peer", "direct")] as never,
      createSourceRegistry({
        connect: (d) => connection(d, "ready"),
      }),
    );
    expect(hydrateSourcesAtStartup()).toBe(false);
  });

  it("为放行新来源重载：记下回到哪一页，只取一次", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    reloadIntoSettings("remote");
    expect(reload).toHaveBeenCalled();
    expect(takeSettingsReopen()).toBe("remote");
    expect(takeSettingsReopen()).toBeNull();
  });
});
