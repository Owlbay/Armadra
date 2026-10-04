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

describe("连接页 · 配对码", () => {
  // `input-otp` 聚焦时探一下密码管理器的徽标位置；jsdom 没有这个方法。
  beforeEach(() => {
    document.elementFromPoint = () => null;
  });

  function typeCode(value: string) {
    const input = screen.getByLabelText("配对码");
    fireEvent.change(input, { target: { value } });
  }

  it("手机浏览器手输地址打开：一上来就是 8 位配对码，输满自动兑换", async () => {
    const onCode = vi.fn(async () => null);
    const onSignIn = vi.fn();
    render(
      <ConnectScreen
        mode="web"
        origin="https://192.168.1.8:8443"
        codeFirst
        onCode={onCode}
        onSignIn={onSignIn}
        onConnect={vi.fn()}
      />,
    );
    expect(
      document.querySelectorAll("[data-slot=input-otp-slot]"),
    ).toHaveLength(8);
    expect(
      document.querySelectorAll("[data-slot=input-otp-group]"),
    ).toHaveLength(2);
    // 没有「改用配对链接」：这一页没有票。
    expect(screen.queryByRole("button", { name: "改用配对链接" })).toBeNull();
    typeCode("3f7k9q2m");
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("3F7K9Q2M"));
    fireEvent.click(screen.getByRole("button", { name: "账号登录" }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it("兑换失败：错误在下面，输入清空", async () => {
    const onCode = vi.fn(async () => "codeInvalid" as const);
    render(
      <ConnectScreen
        mode="web"
        origin="https://192.168.1.8:8443"
        codeFirst
        onCode={onCode}
        onConnect={vi.fn()}
      />,
    );
    typeCode("3F7K9Q2M");
    await waitFor(() =>
      expect(screen.getByText("配对码不对或已过期")).toBeTruthy(),
    );
    expect((screen.getByLabelText("配对码") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("原生 App：第三个入口「输入配对码」，可以切回链接", async () => {
    const onCode = vi.fn(async () => null);
    render(
      <ConnectScreen
        mode="native"
        origin="https://10.0.0.2:8443"
        canScan
        onScan={vi.fn()}
        onCode={onCode}
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "扫码" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "输入配对码" }));
    expect(screen.queryByLabelText("配对链接")).toBeNull();
    typeCode("ABCD2345");
    await waitFor(() => expect(onCode).toHaveBeenCalledWith("ABCD2345"));
    fireEvent.click(screen.getByRole("button", { name: "改用配对链接" }));
    expect(screen.getByLabelText("配对链接")).toBeTruthy();
  });

  it("没给 onCode 就没有这个入口", () => {
    render(<ConnectScreen mode="native" onConnect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "输入配对码" })).toBeNull();
  });
});
