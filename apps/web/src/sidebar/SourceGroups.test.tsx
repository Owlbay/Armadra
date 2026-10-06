import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => vi.fn());
const listed = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock("../app/workspace-actions", () => ({ useOpenWorkspace: () => open }));
vi.mock("../app/workspaces-query", () => ({
  useWorkspaces: () => ({ data: listed.data }),
}));

import { usePreferencesStore } from "../app/preferences-store";
import {
  dropUnscopedQueries,
  useSourceSwitchCacheReset,
} from "../app/use-sources-bootstrap";
import type { SourceConnection } from "../sources/connection";
import { SourcesProvider } from "../sources/context";
import { createSourceRegistry, type SourceRegistry } from "../sources/registry";
import type { SourceDescriptor, SourceStatus } from "../sources/types";
import { SourceGroups } from "./SourceGroups";

/**
 * 侧栏按源分组：只有本机什么也不画；别的源各一组（状态点、离线灰显），就绪
 * 的源列出工作空间，点一行先切当前源再打开；切源清掉不带源前缀的查询。
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
    source: { sourceId: descriptor.sourceId } as SourceConnection["source"],
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

const descriptor = (
  sourceId: string,
  orderIndex: number,
): SourceDescriptor => ({
  sourceId,
  kind: "direct",
  label: `${sourceId}-label`,
  baseUrl: `https://${sourceId}.test`,
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex,
});

let registry: SourceRegistry;
beforeEach(async () => {
  usePreferencesStore.setState({ locale: "en" });
  const states: Record<string, SourceStatus["state"]> = {
    a: "ready",
    b: "offline",
  };
  registry = createSourceRegistry({
    connect: (d) => connection(d, states[d.sourceId] ?? "idle"),
  });
  listed.data = [];
});
afterEach(() => {
  cleanup();
  registry.dispose();
  open.mockReset();
});

function mount(children: ReactNode) {
  return render(
    <SourcesProvider registry={registry}>{children}</SourcesProvider>,
  );
}

describe("侧栏按源分组", () => {
  it("只有本机：什么也不画", () => {
    mount(<SourceGroups />);
    expect(document.querySelector("[data-source-group]")).toBeNull();
  });

  it("挂载的源各一组：在线正常，离线灰显，状态有读屏文字", async () => {
    await act(async () => {
      await registry.hydrate(async () => [
        descriptor("a", 1),
        descriptor("b", 2),
      ]);
    });
    mount(<SourceGroups />);
    const groups = [...document.querySelectorAll("[data-source-group]")];
    expect(groups.map((one) => one.getAttribute("data-source-group"))).toEqual([
      "a",
      "b",
    ]);
    expect(groups[0]!.className).not.toContain("opacity-60");
    expect(groups[1]!.className).toContain("opacity-60");
    expect(screen.getByRole("region", { name: "b-label" })).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
  });

  it("就绪的源列出工作空间；点一行先切当前源再打开，本机成为一组", async () => {
    await act(async () => {
      await registry.hydrate(async () => [descriptor("a", 1)]);
    });
    listed.data = [
      { sourceId: "a", workspace: { id: "w-remote", name: "Remote project" } },
      {
        sourceId: registry.local().descriptor.sourceId,
        workspace: { id: "w-local", name: "Local" },
      },
    ];
    mount(<SourceGroups />);
    // 当前源（本机）的工作空间在树里，不在分组里。
    expect(screen.queryByText("Local")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remote project" }));
    expect(registry.current().descriptor.sourceId).toBe("a");
    expect(open).toHaveBeenCalledWith(
      { id: "w-remote", name: "Remote project" },
      "a",
    );
    // 切过去之后，本机成为一组。
    expect(await screen.findByText("Local")).toBeTruthy();
    expect(screen.getByRole("region", { name: "This machine" })).toBeTruthy();
  });
});

describe("切源清缓存", () => {
  it('换当前源：不带源前缀的查询清掉，["src", …] 留着', async () => {
    const client = new QueryClient();
    client.setQueryData(["settings"], { a: 1 });
    client.setQueryData(["src", "local", "workspaces"], []);
    await act(async () => {
      await registry.hydrate(async () => [descriptor("a", 1)]);
    });
    renderHook(() => useSourceSwitchCacheReset(() => registry), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() => registry.setCurrent(registry.local().descriptor.sourceId));
    expect(client.getQueryData(["settings"])).toEqual({ a: 1 });
    act(() => registry.setCurrent("a"));
    expect(client.getQueryData(["settings"])).toBeUndefined();
    expect(client.getQueryData(["src", "local", "workspaces"])).toEqual([]);
    dropUnscopedQueries(client);
  });
});
