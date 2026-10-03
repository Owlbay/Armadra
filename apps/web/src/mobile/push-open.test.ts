import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDeepLink, takePushFragment } from "./push-open";

afterEach(() => {
  history.replaceState(null, "", "/");
});

describe("通知的深链", () => {
  it("认节点与只到工作空间两种", () => {
    expect(parseDeepLink("armadra://w/ws-1/n/node%201")).toEqual({
      workspaceId: "ws-1",
      nodeId: "node 1",
    });
    expect(parseDeepLink("armadra://w/ws-1")).toEqual({
      workspaceId: "ws-1",
      nodeId: null,
    });
    expect(parseDeepLink("armadra://pair?host=x")).toBeNull();
    expect(parseDeepLink("https://w/ws/n/x")).toBeNull();
    expect(parseDeepLink("armadra://w/a/n/b/extra")).toBeNull();
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
