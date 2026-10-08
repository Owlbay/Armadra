import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const getUsage = vi.fn();
const refreshUsage = vi.fn();
const copilotAuth = vi.fn();
const copilotLogin = vi.fn();
const copilotPoll = vi.fn();
const copilotLogout = vi.fn();
const modelCatalog = vi.fn();
const refreshModelCatalog = vi.fn();
vi.mock("../../../api/client", () => ({
  runtimeApi: {
    settings: () => getSettings(),
    updateSettings: (patch: unknown) => updateSettings(patch),
    usage: () => getUsage(),
    refreshUsage: () => refreshUsage(),
    copilotAuth: () => copilotAuth(),
    copilotLogin: () => copilotLogin(),
    copilotPoll: () => copilotPoll(),
    copilotLogout: () => copilotLogout(),
    modelCatalog: () => modelCatalog(),
    refreshModelCatalog: () => refreshModelCatalog(),
    /** 设置页经归属网关路由：探不到归属，整个域就是只读的。 */
  },
}));

/** 六个域都由 Runtime 写、都已落定；设置页只看 `settings` 那一行。 */

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { UsagePage } from "./UsagePage";

installDomPolyfills();
afterEach(cleanup);

const emptyUsage = {
  providers: [
    { id: "claude", status: "unavailable", windows: [], fetchedAt: null },
  ],
};

/** 还没取到过目录：来源就是内置表，更新时间是「尚未取到」（F10）。 */
const builtInCatalog = {
  source: "builtIn" as const,
  url: "https://models.dev/api.json",
  pricedModels: 18,
  models: [],
};

describe("UsagePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ locale: "zh-CN" });
    getSettings.mockResolvedValue({ usage: { enabled: false } });
    getUsage.mockResolvedValue(emptyUsage);
    refreshUsage.mockResolvedValue(emptyUsage);
    copilotAuth.mockResolvedValue({ signedIn: false, backend: "keychain" });
    modelCatalog.mockResolvedValue(builtInCatalog);
  });

  /** 总开关：其余开关都有各自的 `aria-label`，只有它叫「获取用量」。 */
  const fetchSwitch = () => screen.getByRole("switch", { name: "获取用量" });

  it("暂停查询时不会把空快照显示成凭据丢失", async () => {
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    await screen.findByText("已暂停用量查询");
    expect(screen.queryByText("未找到可用的登录凭据")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("开关保存期间禁用，启用成功后才请求刷新", async () => {
    let finish: (value: unknown) => void = () => {};
    updateSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    await screen.findByText("已暂停用量查询");
    const toggle = fetchSwitch();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(true),
    );
    expect(refreshUsage).not.toHaveBeenCalled();
    finish({ usage: { enabled: true } });
    await waitFor(() => expect(refreshUsage).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ usage: { enabled: true } });
    expect(screen.queryByText("已暂停用量查询")).toBeNull();
  });
  it("单个 provider 关掉后立刻重新取用量，只发那一个键", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    updateSettings.mockResolvedValue({
      usage: { enabled: true, providers: { codex: false } },
    });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    const codex = await screen.findByRole("switch", { name: "Codex" });
    // 设置还没到之前每个控件都是禁用的，先等它可用再点。
    await waitFor(() =>
      expect((codex as HTMLButtonElement).disabled).toBe(false),
    );
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("非官方端点")).toBeTruthy();
    // 归一化后 Runtime 会补齐四个键，但补丁只带用户动过的那一个。
    fireEvent.click(codex);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        usage: { providers: { codex: false } },
      }),
    );
    await waitFor(() => expect(refreshUsage).toHaveBeenCalledTimes(1));
  });

  it("Claude / Copilot 默认关并写明条款风险，打开时两个键一起开", async () => {
    getSettings.mockResolvedValue({
      usage: {
        enabled: true,
        providers: { claude: true, codex: true, copilot: true },
        claudeUsage: false,
        copilotUsage: false,
      },
    });
    updateSettings.mockResolvedValue({ usage: { claudeUsage: true } });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    const claude = await screen.findByRole("switch", { name: "Claude" });
    await waitFor(() =>
      expect((claude as HTMLButtonElement).disabled).toBe(false),
    );
    expect(claude.getAttribute("aria-checked")).toBe("false");
    expect(
      screen
        .getByRole("switch", { name: "Copilot" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText(/可能违反 Anthropic 条款/)).toBeTruthy();
    expect(screen.getByText(/可能违反 Copilot 条款/)).toBeTruthy();
    // Copilot 登录在「凭据与密钥」，这一页不再有。
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
    fireEvent.click(claude);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        usage: { providers: { claude: true }, claudeUsage: true },
      }),
    );
  });

  it("关掉 Claude 时两个键一起关", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, claudeUsage: true },
    });
    updateSettings.mockResolvedValue({ usage: { claudeUsage: false } });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    const claude = await screen.findByRole("switch", { name: "Claude" });
    await waitFor(() =>
      expect(claude.getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(claude);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        usage: { providers: { claude: false }, claudeUsage: false },
      }),
    );
  });

  it("状态徽标写 statusBadges，模型目录自动更新写 models.catalog", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, statusPage: true, statusBadges: true },
      models: { catalog: { autoRefresh: true } },
    });
    updateSettings.mockResolvedValue({});
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    const badges = await screen.findByRole("switch", { name: "服务状态徽标" });
    await waitFor(() =>
      expect((badges as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(badges);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        usage: { statusBadges: false },
      }),
    );
    const catalog = screen.getByRole("switch", { name: "自动更新模型目录" });
    await waitFor(() =>
      expect((catalog as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(catalog);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        models: { catalog: { autoRefresh: false } },
      }),
    );
  });

  it("Claude 本地额度估算缺省开，关掉只写 usage.claudeLocalWindow", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    updateSettings.mockResolvedValue({});
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    const toggle = await screen.findByRole("switch", {
      name: "Claude 本地额度估算",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        usage: { claudeLocalWindow: false },
      }),
    );
  });

  it("成本扫描关着时本地估算开关不可用，并照实显示存着的值", async () => {
    getSettings.mockResolvedValue({
      usage: {
        enabled: true,
        claudeLocalWindow: false,
        cost: { enabled: false },
      },
    });
    usePreferencesStore.setState({ locale: "en" });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    const toggle = await screen.findByRole("switch", {
      name: "Claude local window estimate",
    });
    await screen.findByRole("switch", { name: "Local cost tracking" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it("政策关着的那家在卡片上说怎么打开，而不是说凭据丢了", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    getUsage.mockResolvedValue({
      providers: [
        {
          id: "claude",
          status: "unavailable",
          reason: "policy_off",
          windows: [],
          fetchedAt: null,
        },
        {
          id: "codex",
          status: "unavailable",
          reason: "unsupported",
          windows: [],
          fetchedAt: null,
        },
      ],
    });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    await screen.findByText(
      "额度读取已默认关闭，可在「设置 → 账号与用量」开启",
    );
    expect(
      screen.getByText("用量接口返回了网页而不是数据，暂不支持"),
    ).toBeTruthy();
    expect(screen.queryByText("未找到可用的登录凭据")).toBeNull();
  });

  it("刷新节奏选「手动」时保存 0 分钟", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, refreshMinutes: 5 },
    });
    updateSettings.mockResolvedValue({ usage: { refreshMinutes: 0 } });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    // Radix Select 在 jsdom 里不好驱动，所以直接断言它读到的当前值，
    // 保存路径与其他开关是同一条 `save.mutate`。
    await screen.findByText("每 5 分钟");
    expect(screen.getByText("刷新节奏")).toBeTruthy();
  });

  it("价格来源写明是谁的价格，更新失败也不换掉正在用的那份", async () => {
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    modelCatalog.mockResolvedValue({
      source: "cache",
      url: "https://models.dev/api.json",
      fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      ageHours: 3,
      pricedModels: 42,
      models: [],
    });
    render(
      <TestProviders>
        <UsagePage />
      </TestProviders>,
    );
    await screen.findByText("models.dev（本地缓存）");
    expect(screen.getByText(/3 小时前 · 42 个模型有报价/)).toBeTruthy();

    // 取不到时 Runtime 仍回 200：来源不变，另加一行说明没更新成。
    refreshModelCatalog.mockResolvedValue({
      source: "cache",
      url: "https://models.dev/api.json",
      fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      ageHours: 3,
      pricedModels: 42,
      refreshError: "models.dev answered 503",
      models: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "更新目录" }));
    await screen.findByText("更新失败，仍在用现有目录。");
    expect(screen.getByText("models.dev（本地缓存）")).toBeTruthy();
  });
});
