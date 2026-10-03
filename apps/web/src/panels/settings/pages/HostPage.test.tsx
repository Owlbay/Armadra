import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { GatewayStatus } from "@armadra/shared";

const probe = vi.fn();
vi.mock("../../../host/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../host/connection")>()),
  probeHost: (...args: unknown[]) => probe(...args),
}));
let member = false;
vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member, can: () => !member, session: undefined }),
}));
vi.mock("./HostIdentityPanel", () => ({
  HostIdentityPanel: () => null,
}));

import { HostPage } from "./HostPage";
import { usePreferencesStore } from "../../../app/preferences-store";
import {
  IdentityRequestError,
  IdentityTransportError,
  type IdentityHello,
} from "../../../api/identity";
import { SETTINGS_SECTIONS } from "../nav";
import { TestProviders } from "../../../app/test-harness";
import { parsePairingQr } from "../../../host/qr";

function render(element: ReactElement) {
  return renderBare(<TestProviders>{element}</TestProviders>);
}

/* ------------------------- 对外服务：假的 core 一份 ------------------------- */

const FP = "ab".repeat(32);
const TICKET = "0123456789abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function gatewayStatus(overrides: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    enabled: false,
    running: false,
    managedBy: "settings",
    listen: "private",
    port: 0,
    publicOrigin: "",
    address: null,
    origin: null,
    origins: [],
    tls: {
      source: "localCa",
      certFile: "",
      keyFile: "",
      acmeEmail: "",
      fingerprint: null,
      subject: null,
      names: [],
      notAfter: null,
      caAvailable: false,
    },
    error: null,
    ...overrides,
  };
}

function runningStatus(): GatewayStatus {
  const base = gatewayStatus();
  return {
    ...base,
    enabled: true,
    running: true,
    port: 8443,
    address: { host: "0.0.0.0", port: 8443 },
    origin: "https://192.168.1.20:8443",
    origins: ["https://192.168.1.20:8443", "https://127.0.0.1:8443"],
    tls: { ...base.tls, fingerprint: FP, caAvailable: true },
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** 一个按路径答的 fetch：记下每次调用，`/api/gateway` 的状态随 PUT 改。 */
function fakeCore(options: {
  status?: GatewayStatus | number;
  devices?: { deviceId: string; name: string; role: string }[] | number;
}) {
  let status = options.status ?? gatewayStatus();
  const calls: Call[] = [];
  const answer = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/api/gateway") {
        if (typeof status === "number")
          return answer(status, { code: "forbidden", message: "" });
        if (method === "PUT") {
          const patch = body as Partial<GatewayStatus>;
          status =
            patch.enabled === true
              ? runningStatus()
              : { ...status, ...patch, running: false, origins: [] };
        }
        return answer(200, status);
      }
      if (url.pathname === "/api/gateway/pairing") {
        const origin =
          (body as { origin?: string }).origin ?? "https://192.168.1.20:8443";
        return answer(200, {
          origin,
          ticket: TICKET,
          fingerprint: FP,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          webUrl: `${origin}/#pair=${TICKET}&fp=${FP}`,
          deepLink: `armadra://pair?host=${encodeURIComponent(new URL(origin).host)}&ticket=${TICKET}&fp=${FP}`,
        });
      }
      if (url.pathname === "/api/identity/devices") {
        const devices = options.devices ?? 401;
        if (typeof devices === "number")
          return answer(devices, { code: "UNAUTHENTICATED", message: "" });
        return answer(200, {
          devices: devices.map((device) => ({
            ...device,
            principalId: "p",
            epoch: 1,
            createdAtMs: Date.UTC(2026, 9, 1),
            revokedAtMs: 0,
          })),
          nextId: "",
          hasMore: false,
        });
      }
      return answer(404, { code: "not_found", message: "" });
    }),
  );
  return calls;
}

const hello: IdentityHello = {
  hostId: "host-confirmed",
  hostInstanceId: "process-confirmed",
  maxFrameBytes: 1_048_576,
  capabilities: ["identity.native-session.v1"],
  protocol: { major: 1, minor: 1 },
};

beforeEach(() => {
  member = false;
  probe.mockReset();
  usePreferencesStore.setState({ locale: "zh-CN" });
  // 缺省是成员：`/api/gateway` 403，对外服务这一块不出现。
  fakeCore({ status: 403 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostPage", () => {
  it("is a connection settings entry and remains idle until explicitly checked", () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === "host");
    expect(section?.groupKey).toBe("settings.group.connection");
    render(<HostPage />);
    expect(screen.getByRole("status").textContent).toBe("尚未检查连接");
    expect(
      screen.getByText(/不会切换当前正在运行的工作空间或终端/),
    ).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
  });

  it("opened from a pairing link it checks once by itself, so the ticket can be used", async () => {
    // 服务器壳的配对链接 `…/#pair=<票>`：票要等身份面「可用」才会被取走，而
    // 可用要先检查一次连接。不自己检查，链接打开后什么都不会发生。
    probe.mockResolvedValue(hello);
    const original = window.location.hash;
    window.history.replaceState(null, "", "#pair=abc.def");
    try {
      render(<HostPage />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      window.history.replaceState(
        null,
        "",
        original || window.location.pathname,
      );
    }
  });

  it("keeps a confirmed identity in expandable details", async () => {
    probe.mockResolvedValue(hello);
    render(<HostPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toBe("已确认服务响应");
    const details = screen.getByText("连接详情").closest("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(screen.getByText("host-confirmed")).toBeTruthy();
    expect(screen.getByText("process-confirmed")).toBeTruthy();
    // 能力名原样列出：这一页说的是 core 报了什么，不是页面猜它支持什么。
    expect(screen.getByText("identity.native-session.v1")).toBeTruthy();
  });

  /**
   * 远端返回的文字不进界面：一句可以本地化的话说明该去看哪一边，
   * 原样打印一段服务端消息既翻译不了，也可能带出不该出现在屏幕上的东西。
   */
  it("localizes a refusal without printing remote text", async () => {
    probe.mockRejectedValue(
      new IdentityRequestError(403, "PERMISSION_DENIED", "raw remote detail"),
    );
    render(<HostPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("拒绝访问");
    expect(status.textContent).not.toContain("raw remote detail");
  });

  it("allows cancellation while checking and ignores the old result", async () => {
    let resolve!: (value: IdentityHello) => void;
    probe.mockReturnValue(
      new Promise<IdentityHello>((done) => {
        resolve = done;
      }),
    );
    render(<HostPage />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toBe("正在检查连接…");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(screen.getByRole("status").textContent).toBe("已取消检查");
    await act(async () => {
      resolve(hello);
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("已取消检查");
  });

  it("updates status translations without repeating a request", async () => {
    probe.mockRejectedValue(new IdentityTransportError());
    render(<HostPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    });
    expect(screen.getByRole("status").textContent).toContain("无法连接");
    act(() => usePreferencesStore.setState({ locale: "en" }));
    expect(screen.getByRole("status").textContent).toContain("Cannot connect");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("HostPage · 对外服务", () => {
  it("is absent for anyone the core refuses /api/gateway to", async () => {
    const calls = fakeCore({ status: 403 });
    render(<HostPage />);
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/api/gateway")).toBe(true),
    );
    expect(screen.queryByRole("switch", { name: "对外服务" })).toBeNull();
  });

  it("a member on the server shell does not even ask", async () => {
    member = true;
    const calls = fakeCore({ status: runningStatus() });
    render(<HostPage />);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(
      calls.filter((call) => call.path.startsWith("/api/gateway")),
    ).toEqual([]);
    expect(screen.queryByRole("switch", { name: "对外服务" })).toBeNull();
  });

  it("off shows only the switch; turning it on PUTs /api/gateway and shows a pairing QR", async () => {
    const calls = fakeCore({});
    render(<HostPage />);
    const toggle = await screen.findByRole("switch", { name: "对外服务" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "监听地址" })).toBeNull();
    expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull();

    fireEvent.click(toggle);
    const qr = await screen.findByRole("img", { name: "配对二维码" });
    const put = calls.find((call) => call.method === "PUT");
    expect(put).toEqual({
      method: "PUT",
      path: "/api/gateway",
      body: { enabled: true },
    });
    expect(
      calls.find((call) => call.path === "/api/gateway/pairing")?.method,
    ).toBe("POST");
    // 二维码里是网页配对链接：同一个来源、票与指纹都在片段里。
    expect(parsePairingQr(qr.getAttribute("data-qr-text") ?? "")).toEqual({
      origin: "https://192.168.1.20:8443",
      ticket: TICKET,
      fingerprint: FP,
    });
    expect(screen.getByRole("combobox", { name: "监听地址" })).toBeTruthy();
    expect(screen.getByText(/2:00|1:59/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "下载 CA" }).getAttribute("href"),
    ).toBe("https://192.168.1.20:8443/ca.crt");
  });

  it("keeps the paired devices listed after the switch is turned off", async () => {
    const calls = fakeCore({
      status: runningStatus(),
      devices: [{ deviceId: "d-phone", name: "iPhone", role: "owner" }],
    });
    render(<HostPage />);
    await screen.findByRole("img", { name: "配对二维码" });
    expect(await screen.findByText("iPhone")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "对外服务" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "配对二维码" })).toBeNull(),
    );
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({
      enabled: false,
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("iPhone")).toBeTruthy();
    expect(
      within(table).getByRole("button", { name: "撤销 iPhone" }),
    ).toBeTruthy();
  });

  it("names why it could not start instead of printing the core's message", async () => {
    fakeCore({
      status: gatewayStatus({
        enabled: true,
        error: { code: "port_in_use", message: "raw EADDRINUSE detail" },
      }),
    });
    render(<HostPage />);
    expect((await screen.findByRole("alert")).textContent).toBe("端口已被占用");
    expect(document.body.textContent).not.toContain("raw EADDRINUSE");
  });

  it("a shell-managed gateway is read-only but still pairs", async () => {
    fakeCore({ status: { ...runningStatus(), managedBy: "shell" } });
    render(<HostPage />);
    await screen.findByRole("img", { name: "配对二维码" });
    expect(
      (screen.getByRole("switch", { name: "对外服务" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
