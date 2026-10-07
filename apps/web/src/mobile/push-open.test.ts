import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_SOURCE_ID } from "../api/source";
import { activeConnectionId } from "./connections";
import {
  type PushRouteContext,
  parseDeepLink,
  pushRouteOf,
  switchConnectionFor,
  takePushFragment,
} from "./push-open";

afterEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
});

const native = (over: Partial<PushRouteContext> = {}): PushRouteContext => ({
  native: true,
  activeId: "host-a",
  connections: ["host-a", "host-b"],
  mounted: () => false,
  ...over,
});

describe("通知的深链", () => {
  it("认节点与只到工作空间两种", () => {
    expect(parseDeepLink("armadra://w/ws-1/n/node%201")).toEqual({
      workspaceId: "ws-1",
      nodeId: "node 1",
      sourceId: null,
    });
    expect(parseDeepLink("armadra://w/ws-1")).toEqual({
      workspaceId: "ws-1",
      nodeId: null,
      sourceId: null,
    });
    expect(parseDeepLink("armadra://pair?host=x")).toBeNull();
    expect(parseDeepLink("https://w/ws/n/x")).toBeNull();
    expect(parseDeepLink("armadra://w/a/n/b/extra")).toBeNull();
  });

  it("带签发它的源（`?s=`），别的查询串不认", () => {
    expect(parseDeepLink("armadra://w/ws/n/nd?s=host%3A1")).toEqual({
      workspaceId: "ws",
      nodeId: "nd",
      sourceId: "host:1",
    });
    expect(parseDeepLink("armadra://w/ws?s=h")).toEqual({
      workspaceId: "ws",
      nodeId: null,
      sourceId: "h",
    });
    expect(parseDeepLink("armadra://w/ws?x=h")).toBeNull();
    expect(parseDeepLink("armadra://w/ws?s=h&x=1")).toBeNull();
    expect(parseDeepLink("armadra://w/ws?s=")).toBeNull();
  });
});

describe("通知该在哪个连接里打开", () => {
  const here = { kind: "here", sourceId: LOCAL_SOURCE_ID };

  it("旧格式（没有源）与当前连接签发的：就在这一页", () => {
    expect(pushRouteOf(null, native())).toEqual(here);
    expect(pushRouteOf("host-a", native())).toEqual(here);
  });

  it("签发它的主机已经一起挂着且连上了：切当前源，不重载", () => {
    expect(
      pushRouteOf("host-b", native({ mounted: (id) => id === "host-b" })),
    ).toEqual({ kind: "here", sourceId: "host-b" });
  });

  it("连接表里有、没挂上：切到那个连接", () => {
    expect(pushRouteOf("host-b", native())).toEqual({
      kind: "switch",
      sourceId: "host-b",
    });
  });

  it("连接表里没有：提示，不乱开", () => {
    expect(pushRouteOf("host-x", native())).toEqual({ kind: "unknown" });
  });

  it("网页与没有连接表的旧配对：通知来自给这一页供数的那台", () => {
    expect(
      pushRouteOf("host-x", {
        native: false,
        activeId: null,
        connections: [],
        mounted: () => false,
      }),
    ).toEqual(here);
    expect(
      pushRouteOf("host-x", native({ activeId: null, connections: [] })),
    ).toEqual(here);
  });

  it("切连接：记为当前，深链留在 `#push=` 里再重载", () => {
    const reload = vi.fn();
    const link = "armadra://w/ws/n/nd?s=host-b";
    switchConnectionFor(link, "host-b", reload);
    expect(activeConnectionId()).toBe("host-b");
    expect(reload).toHaveBeenCalledOnce();
    expect(takePushFragment()).toBe(link);
  });

  it("`#push=` 读一次就从地址栏抹掉", () => {
    history.replaceState(
      null,
      "",
      `/#push=${encodeURIComponent("armadra://w/a/n/b")}`,
    );
    const replace = vi.spyOn(history, "replaceState");
    expect(takePushFragment()).toBe("armadra://w/a/n/b");
    expect(replace).toHaveBeenCalled();
    expect(location.hash).toBe("");
    expect(takePushFragment()).toBeNull();
  });
});
