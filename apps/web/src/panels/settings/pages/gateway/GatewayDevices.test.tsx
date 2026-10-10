import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { GatewayDevices, type GatewayDevice } from "./GatewayDevices";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

function device(patch: Partial<GatewayDevice>): GatewayDevice {
  return {
    deviceId: "d".repeat(32),
    principalId: "p".repeat(32),
    name: "手机",
    role: "member",
    epoch: 1,
    createdAtMs: Date.UTC(2026, 9, 1),
    revokedAtMs: 0,
    ...patch,
  };
}

describe("GatewayDevices", () => {
  it("平台与最近访问两列；没有会话的设备两格是「—」", () => {
    render(
      <GatewayDevices
        devices={[
          device({
            deviceId: "a".repeat(32),
            name: "iPhone",
            platform: "ios",
            lastSeenAtMs: Date.UTC(2026, 9, 3, 8, 30),
          }),
          device({ deviceId: "b".repeat(32), name: "旧平板" }),
        ]}
        revoking={null}
        onRevoke={vi.fn()}
      />,
    );
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers.slice(0, 5)).toEqual([
      "名称",
      "平台",
      "添加时间",
      "最近访问",
      "权限",
    ]);
    const [, first, second] = screen.getAllByRole("row");
    const cells = within(first!).getAllByRole("cell");
    expect(cells[1]?.textContent).toBe("iOS");
    expect(cells[3]?.textContent).toMatch(/2026/);
    const empty = within(second!).getAllByRole("cell");
    expect(empty[1]?.textContent).toBe("—");
    expect(empty[3]?.textContent).toBe("—");
  });

  it("英文下平台名照样翻译", () => {
    usePreferencesStore.setState({ locale: "en" });
    render(
      <GatewayDevices
        devices={[device({ platform: "web", lastSeenAtMs: 1 })]}
        revoking={null}
        onRevoke={vi.fn()}
      />,
    );
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Last seen")).toBeTruthy();
    expect(screen.getByText("Web")).toBeTruthy();
  });

  it("有中转来源时按来源分组，组头可折叠", () => {
    const origins: Record<string, string> = {
      ["a".repeat(32)]: "LAN 中转",
      ["b".repeat(32)]: "本机",
    };
    render(
      <GatewayDevices
        devices={[
          device({
            deviceId: "1".repeat(32),
            principalId: "a".repeat(32),
            name: "手机A",
          }),
          device({
            deviceId: "2".repeat(32),
            principalId: "a".repeat(32),
            name: "手机B",
          }),
          device({
            deviceId: "3".repeat(32),
            principalId: "b".repeat(32),
            name: "笔记本",
          }),
        ]}
        revoking={null}
        onRevoke={vi.fn()}
        originOf={(id) => origins[id] ?? null}
      />,
    );
    const head = screen.getByRole("button", { name: "LAN 中转 · 2" });
    expect(screen.getByRole("button", { name: "本机 · 1" })).toBeTruthy();
    expect(screen.getByText("手机A")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.queryByText("手机A")).toBeNull();
    expect(screen.getByText("笔记本")).toBeTruthy();
    fireEvent.click(head);
    expect(screen.getByText("手机B")).toBeTruthy();
  });

  it("没有中转来源时不分组", () => {
    render(
      <GatewayDevices
        devices={[device({ name: "手机" })]}
        revoking={null}
        onRevoke={vi.fn()}
        originOf={() => null}
      />,
    );
    expect(screen.queryByRole("button", { name: /·/ })).toBeNull();
  });
});
