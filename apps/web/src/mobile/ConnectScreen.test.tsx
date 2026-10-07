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

describe("连接页 · 多连接（添加连接）", () => {
  const FP = "9b3e7c1a04d85f62e1a7b90c3d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4";
  const outcomes = () => {
    const relay = {
      begin: vi.fn(),
      join: vi.fn(),
      trust: vi.fn(),
      mount: vi.fn(),
      reset: vi.fn(),
    };
    return relay;
  };
  const base = {
    mode: "native" as const,
    canScan: true,
    onConnect: vi.fn(async () => null),
    onScan: vi.fn(async () => null),
  };

  it("没有连接时直接是三种方式；SaaS 没有入口也没有预告", () => {
    render(<ConnectScreen {...base} relay={outcomes()} />);
    expect(screen.getByRole("button", { name: "扫码" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "配对链接" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "个人中转" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SaaS|即将|预留|敬请/);
  });

  it("「配对链接」有不依赖文案的标记，点了才出输入框（真机插桩用例按它走）", () => {
    render(<ConnectScreen {...base} relay={outcomes()} />);
    expect(
      document.querySelector('[data-slot="mobile-connect"] input'),
    ).toBeNull();
    const link = document.querySelector<HTMLButtonElement>(
      '[data-slot="mobile-connect"] [data-connect-method="link"]',
    );
    expect(link?.textContent).toBe("配对链接");
    fireEvent.click(link as HTMLButtonElement);
    expect(
      document.querySelector('[data-slot="mobile-connect"] input'),
    ).not.toBeNull();
  });

  it("个人中转：地址、账号、口令 → 核对指纹 → 选择主机 → 挂载", async () => {
    const relay = outcomes();
    relay.begin.mockResolvedValue({ kind: "fingerprint", fingerprint: FP });
    relay.trust.mockResolvedValue({
      kind: "sources",
      sources: [
        { sourceId: "s1", name: "MacBook", online: true },
        { sourceId: "s2", name: "Studio", online: false },
      ],
    });
    relay.mount.mockResolvedValue({ kind: "done" });
    render(<ConnectScreen {...base} relay={relay} />);
    fireEvent.click(screen.getByRole("button", { name: "个人中转" }));
    const signIn = screen.getByRole("button", { name: "登录" });
    expect((signIn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText("口令"), {
      target: { value: "pw" },
    });
    fireEvent.click(signIn);
    await waitFor(() => expect(screen.getByText("核对指纹")).toBeTruthy());
    expect(relay.begin).toHaveBeenCalledWith({
      issuer: "relay.example.com",
      account: "owner",
      password: "pw",
    });
    // 主机与指纹分组显示，便于逐段比对。
    expect(screen.getByText("relay.example.com")).toBeTruthy();
    expect(screen.getByText("9b3e7c1a 04d85f62")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "信任并继续" }));
    await waitFor(() => expect(screen.getByText("选择主机")).toBeTruthy());
    // 在线的默认选中，离线的不能选。
    const online = screen.getByRole("checkbox", { name: "MacBook" });
    expect(online.getAttribute("aria-checked")).toBe("true");
    const offline = screen.getByRole("checkbox", { name: /Studio/ });
    expect((offline as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(relay.mount).toHaveBeenCalledWith(["s1"]));
  });

  it("口令错：错误在口令框下面，改字即清掉", async () => {
    const relay = outcomes();
    relay.begin.mockResolvedValue({ kind: "failure", failure: "credentials" });
    render(<ConnectScreen {...base} relay={relay} initialView="relay" />);
    fireEvent.change(screen.getByLabelText("地址"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "o" } });
    const password = screen.getByLabelText("口令");
    fireEvent.change(password, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(screen.getByText("账号或口令不对")).toBeTruthy(),
    );
    expect(password.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(password, { target: { value: "bad2" } });
    expect(screen.queryByText("账号或口令不对")).toBeNull();
  });

  it("取消核对指纹：回到添加连接，并让中转那一步作废", async () => {
    const relay = outcomes();
    render(
      <ConnectScreen
        {...base}
        relay={relay}
        initialView="fingerprint"
        initialFingerprint={FP}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(relay.reset).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "个人中转" })).toBeTruthy();
  });

  it("贴进链接框的分享链接与扫到的二维码都走挂载；别的仍是配对", async () => {
    const relay = outcomes();
    relay.join.mockResolvedValue({ kind: "done" });
    const share = `https://relay.example.com/j/${"0".repeat(32)}#${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;
    const onScan = vi.fn(async () => share);
    const onConnect = vi.fn(async () => null);
    render(
      <ConnectScreen
        {...base}
        relay={relay}
        onScan={onScan}
        onConnect={onConnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "扫码" }));
    await waitFor(() => expect(relay.join).toHaveBeenCalledWith(share));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("收到分享深链：一打开就挂载一次", async () => {
    const relay = outcomes();
    relay.join.mockResolvedValue({ kind: "done" });
    const link = `armadra://join?link=${"0".repeat(32)}&issuer=${encodeURIComponent("https://relay.example.com")}&s=${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;
    render(
      <ConnectScreen {...base} relay={relay} initialLink={link} autoJoin />,
    );
    await waitFor(() => expect(relay.join).toHaveBeenCalledWith(link));
    expect(relay.join).toHaveBeenCalledTimes(1);
  });

  it("连接列表：点一行进入；移除要先确认", async () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        connections={[
          {
            sourceId: "s1",
            label: "MacBook",
            host: "relay.example.com",
            direct: false,
            relayed: true,
          },
          {
            sourceId: "s2",
            label: "",
            host: "192.168.1.8:8443",
            direct: true,
            relayed: false,
          },
        ]}
        activeId="s1"
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    expect(screen.getByText("当前")).toBeTruthy();
    fireEvent.click(screen.getByText("MacBook"));
    expect(onOpen).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "移除 MacBook" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移除连接" }));
    expect(onRemove).toHaveBeenCalledWith("s1");
    // 添加连接在列表下面。
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    expect(screen.getByRole("button", { name: "个人中转" })).toBeTruthy();
  });

  it("选中的连接连不上：原因显示在列表上方，一动手就清掉", () => {
    render(
      <ConnectScreen
        {...base}
        relay={outcomes()}
        initialFailure="offline"
        connections={[
          {
            sourceId: "s1",
            label: "MacBook",
            host: "relay.example.com",
            direct: false,
            relayed: true,
          },
        ]}
        activeId="s1"
      />,
    );
    expect(screen.getByText("这台主机不在线")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加连接" }));
    expect(screen.queryByText("这台主机不在线")).toBeNull();
  });
});
