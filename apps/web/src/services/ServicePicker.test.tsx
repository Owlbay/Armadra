import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { localSource, type Source } from "../api/source";
import { usePreferencesStore } from "../app/preferences-store";
import { followInitialSource } from "../app/use-sources-bootstrap";
import type { SourceConnection } from "../sources/connection";
import { SourcesProvider } from "../sources/context";
import { type SourceRegistry, createSourceRegistry } from "../sources/registry";
import type { SourceDescriptor, SourceState } from "../sources/types";
import { memoryStorage } from "../mobile/testing";
import {
  forgetRecent,
  recentIds,
  recordRecent,
  setEnterIntent,
  takeEnterIntent,
} from "./recent";
import { layoutServices, serviceRowOf, type ServiceRow } from "./rows";
import { ServicePicker } from "./ServicePicker";
import { SwitchServiceDialog } from "./SwitchServiceDialog";
import { initialSourceParam, useServiceSwitcher } from "./switcher";

const ISSUER = "https://relay.example.com";

function descriptor(
  sourceId: string,
  patch: Partial<SourceDescriptor> = {},
): SourceDescriptor {
  return {
    sourceId,
    kind: "direct",
    label: sourceId,
    baseUrl: "",
    relayOrigin: "",
    cloudIssuer: "",
    fingerprint: "",
    orderIndex: 0,
    ...patch,
  };
}

const viaRelay = (id: string, label = id) =>
  descriptor(id, {
    kind: "relayed",
    label,
    relayOrigin: ISSUER,
    cloudIssuer: ISSUER,
  });
const viaLan = (id: string, label = id) =>
  descriptor(id, { label, baseUrl: `https://${id}.lan:8443` });

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("行模型与排版", () => {
  it("两条路的主机只一行：首选直连，组按首选路分，第二行列出全部到达方式", () => {
    const both = descriptor("mac", {
      kind: "relayed",
      label: "MacBook",
      baseUrl: "https://mac.lan:8443",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
    });
    const row = serviceRowOf(both, { serviceName: () => "家里" });
    expect(row.routes.map((route) => route.via)).toEqual(["direct", "relayed"]);
    const layout = layoutServices([row, serviceRowOf(viaRelay("nas"))]);
    expect(layout.groups.map((group) => group.key)).toEqual([
      `relay:${ISSUER}`,
      "direct",
    ]);
    expect(layout.groups[1]!.rows).toEqual([row]);
  });

  it("名字缺省是主机名；远程服务名缺省是签发方主机", () => {
    expect(serviceRowOf(viaLan("box", "")).name).toBe("box.lan:8443");
    expect(serviceRowOf(viaRelay("box")).routes[0]!.serviceName).toBe(
      "relay.example.com",
    );
  });

  it("行数超过 3 才单列最近使用", () => {
    const rows = ["a", "b", "c"].map((id) => serviceRowOf(viaLan(id)));
    expect(layoutServices(rows, ["b"]).recent).toEqual([]);
    const four = [...rows, serviceRowOf(viaLan("d"))];
    expect(
      layoutServices(four, ["d", "a"]).recent.map((row) => row.sourceId),
    ).toEqual(["d", "a"]);
  });
});

describe("最近使用与进入意图", () => {
  it("前插去重，最多 3 个；移除连接时一并去掉", () => {
    for (const id of ["a", "b", "c", "d", "b"]) recordRecent(id);
    expect(recentIds()).toEqual(["b", "d", "c"]);
    forgetRecent("d");
    expect(recentIds()).toEqual(["b", "c", "a"]);
  });

  it("意图只取一次", () => {
    setEnterIntent("a");
    expect(takeEnterIntent()).toBe("a");
    expect(takeEnterIntent()).toBeNull();
  });
});

describe("选择服务 · 整页", () => {
  const rows: ServiceRow[] = [
    ...["a", "b", "c"].map((id) => serviceRowOf(viaRelay(id, `relay-${id}`))),
    serviceRowOf(viaLan("d", "Studio")),
  ];

  it("最近使用在前，组头分中转与直连，状态胶囊与「当前」在行上", () => {
    render(
      <ServicePicker
        variant="page"
        rows={rows}
        recent={["d"]}
        currentId="a"
        statuses={{ a: "online", d: "offline" }}
        onEnter={vi.fn()}
      />,
    );
    const recent = screen.getByText("最近使用").closest("section")!;
    expect(within(recent as HTMLElement).getByText("Studio")).toBeTruthy();
    expect(screen.getByText("全部")).toBeTruthy();
    expect(screen.getByText("中转 · relay.example.com")).toBeTruthy();
    expect(screen.getByText("直连", { selector: "h3" })).toBeTruthy();
    expect(screen.getByText("当前")).toBeTruthy();
    expect(screen.getAllByText("离线")).toHaveLength(2);
    // 未知只呼吸、文字只给读屏。
    expect(screen.getAllByText("未知")[0]!.className).toContain("sr-only");
  });

  it("点行进入；行尾移除要先确认", () => {
    const onEnter = vi.fn();
    const onRemove = vi.fn();
    render(
      <ServicePicker
        variant="page"
        rows={rows.slice(3)}
        onEnter={onEnter}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除 Studio" }));
    fireEvent.click(screen.getByRole("button", { name: "移除连接" }));
    expect(onRemove).toHaveBeenCalledWith("d");
    fireEvent.click(screen.getByText("Studio"));
    expect(onEnter).toHaveBeenCalledWith("d");
  });

  it("失败挂在那一行下面，带动作；登录失效的组头给「登录」", () => {
    const run = vi.fn();
    const onSignIn = vi.fn();
    render(
      <ServicePicker
        variant="page"
        rows={rows}
        signedOut={[ISSUER]}
        failure={{
          sourceId: "b",
          message: "这台主机不在线",
          action: { label: "重试", run },
        }}
        onEnter={vi.fn()}
        onSignIn={onSignIn}
      />,
    );
    const failure = document.querySelector('[data-service-failure="b"]')!;
    expect(failure.textContent).toContain("这台主机不在线");
    fireEvent.click(within(failure as HTMLElement).getByText("重试"));
    expect(run).toHaveBeenCalled();
    expect(screen.getByText("已登出")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(onSignIn).toHaveBeenCalledWith(ISSUER);
  });

  it("空表：还没有连接", () => {
    render(<ServicePicker variant="page" rows={[]} onEnter={vi.fn()} />);
    expect(screen.getByText("还没有连接")).toBeTruthy();
  });
});

/* ------------------------------ 桌面对话框 ------------------------------ */

function fakeConnection(
  d: SourceDescriptor,
  state: SourceState = "ready",
): SourceConnection {
  const source: Source = {
    ...localSource,
    sourceId: d.sourceId,
    httpBase: d.baseUrl,
    wsBase: d.baseUrl.replace(/^https/, "wss"),
  };
  return {
    descriptor: d,
    status: { state, via: "direct", since: 0, lastError: null },
    subscribe: () => () => undefined,
    source,
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    disconnect: () => undefined,
    renew: async () => undefined,
    revoke: () => undefined,
  };
}

describe("桌面「切换服务」对话框", () => {
  let registry: SourceRegistry | null = null;
  afterEach(() => {
    registry?.dispose();
    registry = null;
    useServiceSwitcher.setState({ open: false });
  });

  const mount = () => {
    const states: Record<string, SourceState> = {
      lan: "ready",
      far: "offline",
    };
    registry = createSourceRegistry({
      connect: (d) => fakeConnection(d, states[d.sourceId]),
    });
    registry.add(viaLan("lan", "Studio"));
    registry.add(viaRelay("far", "Workstation"));
    useServiceSwitcher.setState({ open: true });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SourcesProvider registry={registry}>
          <SwitchServiceDialog />
        </SourcesProvider>
      </QueryClientProvider>,
    );
    return registry;
  };

  it("本机、中转、直连三组；本机是当前，在线状态取各源的连接", () => {
    mount();
    const dialog = screen.getByTestId("switch-service-dialog");
    expect(within(dialog).getByText("本机", { selector: "h3" })).toBeTruthy();
    expect(within(dialog).getByText("当前")).toBeTruthy();
    expect(within(dialog).getByText("在线")).toBeTruthy();
    expect(within(dialog).getByText("离线")).toBeTruthy();
    // 本机行没有「切换」，另外两行各一个。
    expect(
      within(dialog).getAllByRole("button", { name: "切换" }),
    ).toHaveLength(2);
  });

  it("「切换」换当前源并关掉对话框；没有桌面壳时不给「在新窗口打开」", () => {
    const table = mount();
    expect(screen.queryByRole("button", { name: "在新窗口打开" })).toBeNull();
    const row = document.querySelector('[data-service-row="far"]')!;
    act(() => {
      fireEvent.click(within(row as HTMLElement).getByText("切换"));
    });
    expect(table.current().descriptor.sourceId).toBe("far");
    expect(useServiceSwitcher.getState().open).toBe(false);
  });

  it("桌面壳在：「在新窗口打开」交给壳，带着源标识", () => {
    const openSource = vi.fn(async () => ({ opened: true }));
    vi.stubGlobal("armadra", { windows: { openSource } });
    Object.assign(window, { armadra: { windows: { openSource } } });
    try {
      mount();
      const row = document.querySelector('[data-service-row="lan"]')!;
      fireEvent.click(
        within(row as HTMLElement).getByRole("button", {
          name: "在新窗口打开",
        }),
      );
      expect(openSource).toHaveBeenCalledWith({ sourceId: "lan" });
    } finally {
      delete (window as { armadra?: unknown }).armadra;
    }
  });
});

describe("新窗口的初始当前源（?source=）", () => {
  it("只认像样的标识", () => {
    expect(initialSourceParam("?source=abc123")).toBe("abc123");
    expect(initialSourceParam("?source=../x")).toBeNull();
    expect(initialSourceParam("")).toBeNull();
  });

  it("那个源挂上之后设为当前，只设一次", () => {
    const registry = createSourceRegistry({
      connect: (d) => fakeConnection(d),
    });
    const stop = followInitialSource(registry, "lan");
    expect(registry.current().descriptor.sourceId).toBe("local");
    registry.add(viaLan("lan"));
    expect(registry.current().descriptor.sourceId).toBe("lan");
    registry.setCurrent("local");
    registry.add(viaLan("other"));
    expect(registry.current().descriptor.sourceId).toBe("local");
    stop();
    registry.dispose();
  });
});
