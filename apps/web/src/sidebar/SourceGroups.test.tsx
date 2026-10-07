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
const desktop = vi.hoisted(() => ({ on: false }));
vi.mock("../platform", async (original) => ({
  ...(await original<typeof import("../platform")>()),
  isDesktop: () => desktop.on,
}));
const reorder = vi.hoisted(() => vi.fn(async (_ids: readonly string[]) => {}));
vi.mock("../api/remote-services", () => ({ reorderSources: reorder }));

import { usePreferencesStore } from "../app/preferences-store";
import {
  dropUnscopedQueries,
  useSourceSwitchCacheReset,
} from "../app/use-sources-bootstrap";
import type { SourceConnection } from "../sources/connection";
import { SourcesProvider } from "../sources/context";
import { createSourceRegistry, type SourceRegistry } from "../sources/registry";
import type { SourceDescriptor, SourceStatus } from "../sources/types";
import { SourceGroups, applyOrder } from "./SourceGroups";

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
  reorder.mockClear();
  desktop.on = false;
});

function mount(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SourcesProvider registry={registry}>{children}</SourcesProvider>
    </QueryClientProvider>,
  );
}

const order = () =>
  [...document.querySelectorAll("[data-source-group]")].map((one) =>
    one.getAttribute("data-source-group"),
  );

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

describe("拖动排序", () => {
  it("applyOrder：认得的按拖出的顺序，其余按原顺序跟在后面", async () => {
    await act(async () => {
      await registry.hydrate(async () => [
        descriptor("a", 1),
        descriptor("b", 2),
        descriptor("c", 3),
      ]);
    });
    const remotes = registry
      .list()
      .filter((one) => one.descriptor.kind !== "local");
    const ids = (list: readonly SourceConnection[]) =>
      list.map((one) => one.descriptor.sourceId);
    expect(ids(applyOrder(remotes, null))).toEqual(["a", "b", "c"]);
    expect(ids(applyOrder(remotes, ["c", "a"]))).toEqual(["c", "a", "b"]);
    expect(ids(applyOrder(remotes, ["gone", "b"]))).toEqual(["b", "a", "c"]);
  });

  it("浏览器页面（源表不在本机 core）：组头不可拖", async () => {
    await act(async () => {
      await registry.hydrate(async () => [
        descriptor("a", 1),
        descriptor("b", 2),
      ]);
    });
    mount(<SourceGroups />);
    expect(
      screen.queryByRole("button", { name: /Drag to reorder/ }),
    ).toBeNull();
  });

  it("桌面壳：组头用键盘拖到下一位，侧栏先按新顺序画，按位置写回 orderIndex", async () => {
    desktop.on = true;
    await act(async () => {
      await registry.hydrate(async () => [
        descriptor("a", 1),
        descriptor("b", 2),
      ]);
    });
    mount(<SourceGroups />);
    expect(order()).toEqual(["a", "b"]);
    const handle = screen.getByRole("button", {
      name: "Drag to reorder a-label",
    });
    // jsdom 没有布局：给两组各一个不重叠的位置，键盘传感器才找得到下一位。
    for (const [index, group] of document
      .querySelectorAll<HTMLElement>("[data-source-group]")
      .entries()) {
      group.getBoundingClientRect = () =>
        ({
          x: 0,
          y: index * 40,
          top: index * 40,
          left: 0,
          bottom: index * 40 + 28,
          right: 200,
          width: 200,
          height: 28,
          toJSON: () => ({}),
        }) as DOMRect;
    }
    handle.focus();
    await act(async () => {
      fireEvent.keyDown(handle, { key: " ", code: "Space" });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: "ArrowDown", code: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(handle, { key: " ", code: "Space" });
    });
    expect(order()).toEqual(["b", "a"]);
    expect(reorder).toHaveBeenCalledWith(["b", "a"]);
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
