import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { usePreferencesStore } from "../app/preferences-store";
import { ConnectScreen } from "./ConnectScreen";

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("连接页 · 原生 App", () => {
  it("贴链接连接，失败时错误在输入框下面", async () => {
    const onConnect = vi.fn(async () => "expired" as const);
    render(<ConnectScreen mode="native" onConnect={onConnect} />);
    const connect = screen.getByRole("button", { name: "连接" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText("配对链接");
    fireEvent.change(input, { target: { value: " https://h:1/#pair=x " } });
    fireEvent.click(connect);
    await waitFor(() =>
      expect(screen.getByText("配对链接已失效，请重新扫码")).toBeTruthy(),
    );
    expect(onConnect).toHaveBeenCalledWith(" https://h:1/#pair=x ");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // 改字即清掉错误。
    fireEvent.change(input, { target: { value: "x" } });
    expect(screen.queryByText("配对链接已失效，请重新扫码")).toBeNull();
  });

  it("能扫码时多一个扫码钮，扫到即连", async () => {
    const onConnect = vi.fn(async () => null);
    const onScan = vi.fn(async () => "armadra://pair?host=h:1&ticket=t&fp=0");
    render(
      <ConnectScreen
        mode="native"
        canScan
        onScan={onScan}
        onConnect={onConnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "扫码" }));
    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith(
        "armadra://pair?host=h:1&ticket=t&fp=0",
      ),
    );
  });

  it("不能扫码时没有扫码钮", () => {
    render(<ConnectScreen mode="native" onConnect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "扫码" })).toBeNull();
  });

  it("连不上时说出是哪台", async () => {
    render(
      <ConnectScreen
        mode="native"
        origin="https://10.0.0.2:8443"
        failure="unreachable"
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByText("连不上 10.0.0.2:8443")).toBeTruthy();
  });
});

describe("连接页 · 手机浏览器", () => {
  it("只有地址、一个「连接」与 CA 引导，失败是一条 Alert", async () => {
    const onConnect = vi.fn(async () => "failed" as const);
    render(
      <ConnectScreen
        mode="web"
        origin="https://192.168.1.8:8443"
        caGuide={<div data-testid="ca" />}
        onConnect={onConnect}
      />,
    );
    expect(screen.getByText("192.168.1.8:8443")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("ca")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("配对没有成功")).toBeTruthy();
  });

  it("英文界面同样完整", () => {
    usePreferencesStore.setState({ locale: "en" });
    render(<ConnectScreen mode="native" canScan onConnect={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Connect to Armadra" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan QR code" })).toBeTruthy();
  });
});
