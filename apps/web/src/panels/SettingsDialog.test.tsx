import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

const fetchAgents = vi.fn();
const fetchSettings = vi.fn();
const fetchHealth = vi.fn();
const fetchUsage = vi.fn();
const fetchDataInfo = vi.fn();
const patchSettings = vi.fn();
const agentIntegration = vi.fn();
const repairAgentIntegration = vi.fn();
const installAgentIntegration = vi.fn();
const uninstallAgentIntegration = vi.fn();
const testSshHost = vi.fn();

vi.mock("../api/client", () => ({
  runtimeApi: {
    agents: () => fetchAgents(),
    settings: () => fetchSettings(),
    health: () => fetchHealth(),
    usage: () => fetchUsage(),
    refreshUsage: () => fetchUsage(),
    dataInfo: () => fetchDataInfo(),
    backupData: () => Promise.resolve({ path: "/tmp/x", bytes: 1 }),
    refreshConversations: () =>
      Promise.resolve({ scanned: 0, indexed: 0, removed: 0, total: 0 }),
    updateSettings: (patch: unknown) => patchSettings(patch),
    agentIntegration: (id: string) => agentIntegration(id),
    repairAgentIntegration: (id: string) => repairAgentIntegration(id),
    installAgentIntegration: (id: string) => installAgentIntegration(id),
    uninstallAgentIntegration: (id: string) => uninstallAgentIntegration(id),
    testSshHost: (id: string) => testSshHost(id),
    /** 设置页经归属网关路由：探不到归属，整个域就是只读的。 */
  },
}));

/** 六个域都由 Runtime 写、都已落定；设置页只看 `settings` 那一行。 */

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import { translate } from "../i18n";
import { SETTINGS_SHEET_CLASS, SettingsDialog } from "./SettingsDialog";
import { visibleSettingsSections } from "./settings/nav";

installDomPolyfills();
afterEach(cleanup);

const claude: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  color: "#d97757",
  launchCmd: "claude",
  promptMode: "argv",
  args: [],
  capabilities: ["hooks"],
  resolvedPath: "/usr/local/bin/claude",
  installed: true,
  clientRevision: 3,
};

const host = {
  id: "box",
  name: "构建机",
  host: "build.example.com",
  user: "ada",
  port: 2222,
};

function settingsDocument(overrides: Record<string, unknown> = {}) {
  return {
    terminal: { backend: "auto", detachedGraceMinutes: 1440 },
    ssh: { hosts: [host] },
    ...overrides,
  };
}

function zh(key: string) {
  return translate("zh-CN", key);
}

function nav() {
  return screen.getByRole("navigation");
}

function navItem(label: string) {
  return within(nav()).getByRole("button", { name: label });
}

function page() {
  return screen.getByTestId("settings-page");
}

/** 一张设置卡片：小标题旁边那个 `settings-group` 容器。 */
function settingsGroup(title: string | HTMLElement) {
  const heading = typeof title === "string" ? screen.getByText(title) : title;
  const group = heading.parentElement?.querySelector(".settings-group");
  if (!group) throw new Error("no settings group for the given title");
  return group as HTMLElement;
}

function open() {
  return render(
    <TestProviders>
      <SettingsDialog />
    </TestProviders>,
  );
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    fetchAgents.mockReset().mockResolvedValue([claude]);
    fetchSettings.mockReset().mockResolvedValue(settingsDocument());
    fetchHealth
      .mockReset()
      .mockResolvedValue({ status: "ok", version: "0.1.0" });
    fetchUsage.mockReset().mockResolvedValue({ providers: [] });
    fetchDataInfo.mockReset().mockResolvedValue({
      dataDir: "/tmp/armadra",
      dbBytes: 2048,
      conversations: 12,
      boardLogRetentionDays: 30,
    });
    patchSettings
      .mockReset()
      .mockImplementation((patch: Record<string, unknown>) =>
        Promise.resolve(settingsDocument(patch)),
      );
    agentIntegration.mockReset().mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 3 },
      skill: { installed: false },
      legacy: {
        found: [
          {
            kind: "hook_entry",
            path: "~/.claude/settings.json",
            detail: "hooks.SessionStart[0]",
          },
        ],
      },
      revision: 3,
    });
    repairAgentIntegration.mockReset().mockResolvedValue({
      agentId: "claude",
      found: [
        {
          kind: "hook_entry",
          path: "~/.claude/settings.json",
          detail: "hooks.SessionStart[0]",
        },
      ],
      removed: ["~/.claude/settings.json → hooks.SessionStart[0]"],
      kept: [],
      backup: "~/.claude/settings.json.armadra-backup-20260913",
    });
    installAgentIntegration.mockReset().mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 4 },
      legacy: { found: [] },
      revision: 4,
    });
    uninstallAgentIntegration.mockReset().mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: false },
      skill: { installed: false },
      legacy: { found: [] },
      revision: 4,
    });
    testSshHost.mockReset();
    usePreferencesStore.setState({
      lastSettingsSection: null,
      settingsSubpage: null,
      agentModes: {},
      launchOverrides: {},
    });
    useCanvasStore.setState({
      panels: {
        sidebar: "open",
        explorer: "closed",
        scm: "closed",
        resources: "closed",
        automation: "closed",
        handoff: "closed",
        workflow: "closed",
        dispatch: "closed",
        usage: "closed",
        github: "closed",
        problems: "closed",
        references: "closed",
        settings: true,
        palette: false,
        quickOpen: false,
      },
    });
  });

  it("弹窗按视口比例取尺寸，导航按比例夹在 176–240，正文列不封顶（设计系统 §2.7）", async () => {
    open();
    await screen.findByText(zh("settings.theme"));
    const dialog = screen.getByTestId("settings-dialog");
    expect(dialog.className).toContain("w-[var(--settings-dialog-w)]");
    expect(dialog.className).toContain("h-[var(--settings-dialog-h)]");
    expect(dialog.className).toContain(
      "max-h-[calc(100dvh-48px-var(--safe-top)-var(--safe-bottom))]",
    );
    expect(dialog.className).toContain("max-lg:w-[calc(100vw-32px)]");
    expect(dialog.className).not.toContain("w-[920px]");
    const column = screen
      .getByTestId("settings-page")
      .querySelector('[data-slot="settings-column"]') as HTMLElement;
    expect(column.className).not.toContain("max-w-[960px]");
    expect(column.className).toContain("w-full");
    expect(nav().className).toContain("w-[clamp(176px,16%,240px)]");
  });

  it("页头右端是这一页的作用范围徽标", async () => {
    open();
    await screen.findByText(zh("settings.theme"));
    const scope = () =>
      screen
        .getByTestId("settings-heading")
        .parentElement?.querySelector("[data-settings-scope]")?.textContent;
    expect(scope()).toBe(zh("settings.scope.device"));
    fireEvent.click(navItem(zh("settings.section.about")));
    expect(scope()).toBe(zh("settings.scope.host"));
    fireEvent.click(navItem(zh("settings.section.security")));
    expect(scope()).toBe(zh("settings.scope.account"));
    fireEvent.click(navItem(zh("settings.section.remoteAccess")));
    expect(scope()).toBe(zh("settings.scope.local"));
  });

  it("手机底部 Sheet 取整高，压过 Sheet 自己的 h-auto", () => {
    expect(SETTINGS_SHEET_CLASS).toBe(
      "data-[side=bottom]:h-[calc(100dvh-48px-var(--safe-top))]",
    );
  });

  it("导航列出注册表里的每个分区，且没有搜索框", async () => {
    open();
    await screen.findByText(zh("settings.theme"));
    // 壳不在时「浏览器」那一行不该出现：它上面每一项都只对 `<webview>`
    // 有意义（复查 §5.2）。
    const sections = visibleSettingsSections();
    expect(sections.some((section) => section.id === "browser")).toBe(false);
    for (const section of sections) {
      expect(navItem(zh(section.labelKey)), section.id).toBeTruthy();
    }
    expect(within(nav()).getAllByRole("button")).toHaveLength(sections.length);
    expect(screen.queryByPlaceholderText(/搜索/)).toBeNull();
    expect(screen.queryByText(zh("settings.nodeColorStyle"))).toBeNull();
  });

  /**
   * ChatGPT 模式的核心：一次只渲染一页，切分区整页替换——上一页的控件必须
   * 从 DOM 里消失，而不是继续挂在下面等人滚过去。
   *
   * 这条用例把每一页都渲染一遍，所以它的耗时随设置项数量增长；终端页新增
   * 渲染名额与会话休眠两个 Select 之后，在 jsdom 里已经贴着默认的 5 秒。
   * 放宽的是这一条的上限，断言一条没动。
   */
  it("每个分区各自是一页，切换时整页替换", { timeout: 20_000 }, async () => {
    open();
    await screen.findByText(zh("settings.theme"));

    for (const section of visibleSettingsSections()) {
      fireEvent.click(navItem(zh(section.labelKey)));
      await waitFor(() => expect(page().dataset.section).toBe(section.id));
      // 页头标题就是这一页的名字，导航高亮跟着走。
      expect(screen.getByTestId("settings-heading").textContent).toBe(
        zh(section.labelKey),
      );
      expect(navItem(zh(section.labelKey)).dataset.active).toBe("true");
      expect(usePreferencesStore.getState().lastSettingsSection).toBe(
        section.id,
      );
    }

    // 主题在「通用」页上；停在「关于」页时它不该还在 DOM 里。
    expect(screen.queryByText(zh("settings.theme"))).toBeNull();
  });

  it("重开设置回到上次那一页", async () => {
    usePreferencesStore.setState({ lastSettingsSection: "keybindings" });
    open();
    await waitFor(() => expect(page().dataset.section).toBe("keybindings"));
    expect(navItem(zh("settings.section.keybindings")).dataset.active).toBe(
      "true",
    );
  });

  it("上次停在旧版的分区 id：落到内容所在的新页（§2.2）", async () => {
    usePreferencesStore.setState({ lastSettingsSection: "terminal" });
    open();
    await waitFor(() => expect(page().dataset.section).toBe("terminalLook"));
    expect(navItem(zh("settings.section.terminalLook")).dataset.active).toBe(
      "true",
    );
  });

  it("SSH 主机在同一右栏里推入子页，← 返回列表", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.machines")));
    const row = await screen.findByRole("button", { name: /构建机/ });

    fireEvent.click(row);
    // 子页：页头换成「编辑主机」，多了一个返回按钮，表单字段就位。
    expect(screen.getByTestId("settings-heading").textContent).toBe(
      zh("ssh.dialog.edit"),
    );
    expect(
      (screen.getByLabelText(zh("ssh.field.host")) as HTMLInputElement).value,
    ).toBe("build.example.com");
    expect(usePreferencesStore.getState().settingsSubpage).toBe("ssh:box");
    // 子页是推入右栏，不是叠一层对话框。
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: zh("settings.back") }));
    expect(screen.getByTestId("settings-heading").textContent).toBe(
      zh("settings.section.machines"),
    );
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
    expect(screen.getByRole("button", { name: /构建机/ })).toBeTruthy();
  });

  it("子页保存后写回整份主机表并弹回列表", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.machines")));
    fireEvent.click(await screen.findByRole("button", { name: /构建机/ }));
    fireEvent.change(screen.getByLabelText(zh("ssh.field.name")), {
      target: { value: "生产机" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: zh("ssh.dialog.save") }),
    );

    await waitFor(() => expect(patchSettings).toHaveBeenCalled());
    const patch = patchSettings.mock.calls[0]?.[0] as {
      ssh: { hosts: Array<Record<string, unknown>> };
    };
    expect(patch.ssh.hosts).toHaveLength(1);
    expect(patch.ssh.hosts[0]).toMatchObject({ id: "box", name: "生产机" });
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
  });

  it("换分区会丢掉子页", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.machines")));
    fireEvent.click(await screen.findByRole("button", { name: /构建机/ }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe("ssh:box");

    fireEvent.click(navItem(zh("settings.section.about")));
    expect(usePreferencesStore.getState().settingsSubpage).toBeNull();
    expect(page().dataset.section).toBe("about");
  });

  it("Agent CLI 一家一行，三态写进偏好", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.agents")));
    const trigger = await screen.findByRole("combobox", {
      name: `Claude Code ${zh("agents.row.mode")}`,
    });
    const choose = (option: string) => {
      fireEvent.pointerDown(
        screen.getByRole("combobox", {
          name: `Claude Code ${zh("agents.row.mode")}`,
        }),
        { button: 0, ctrlKey: false, pointerType: "mouse" },
      );
      fireEvent.click(screen.getByRole("option", { name: option }));
    };
    expect(trigger).toBeTruthy();
    choose(zh("settings.agentMode.disabled"));
    expect(usePreferencesStore.getState().agentModes.claude).toBe("disabled");
    // 禁用时行上一枚「已禁用」，动作仍是三态，好改回来。
    expect(await screen.findByText(zh("agents.state.disabled"))).toBeTruthy();

    // 回到「默认」不落键：将来改默认策略时老配置跟着走。
    choose(zh("settings.agentMode.default"));
    expect(usePreferencesStore.getState().agentModes.claude).toBeUndefined();
  });

  /**
   * Agent CLI 子页（§2.5）：画布注入一行说清哪一半没生成；本产品旧版本的残留
   * 收在「清理旧版 N」里，看过清单再清。没有「安装 / 卸载」，只有「重新生成」。
   */
  it("Agent CLI 子页：注入缺哪一半、旧残留与重新生成", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.agents")));
    // 技能没生成：主表这一行是「需更新」，动作是「更新」。
    expect(
      await screen.findByText(
        zh("agents.state.updateNeeded"),
        {},
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(screen.getByTestId("settings-heading").textContent).toBe(
      "Claude Code",
    );
    expect(usePreferencesStore.getState().settingsSubpage).toBe("cli:claude");
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.action.repair").replace("{count}", "1"),
      }),
    );
    expect(await screen.findByText(/hooks\.SessionStart\[0\]/)).toBeTruthy();
    expect(screen.getByText(zh("integration.state.skillMissing"))).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.regenerate") }),
    );
    await waitFor(() =>
      expect(installAgentIntegration).toHaveBeenCalledWith("claude"),
    );
    expect(uninstallAgentIntegration).not.toHaveBeenCalled();
  });

  it("主表的「更新」就是重新生成注入产物", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.agents")));
    // 集成状态读回来才知道要更新：慢机器上这一步可能超过默认的 1 秒。
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: zh("agents.action.update") },
        { timeout: 5_000 },
      ),
    );
    await waitFor(() =>
      expect(installAgentIntegration).toHaveBeenCalledWith("claude"),
    );
  });

  it("「清理」按 found / removed / kept / backup 报结果", async () => {
    usePreferencesStore.setState({ settingsSubpage: null });
    open();
    fireEvent.click(navItem(zh("settings.section.agents")));
    fireEvent.click(await screen.findByRole("button", { name: /Claude Code/ }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.action.repair").replace("{count}", "1"),
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: zh("integration.repair") }),
    );
    await waitFor(() =>
      expect(repairAgentIntegration).toHaveBeenCalledWith("claude"),
    );
  });

  it("本机服务页带着数据目录与大小，会话页带着条数", async () => {
    open();
    fireEvent.click(navItem(zh("settings.section.service")));
    expect(await screen.findByText("/tmp/armadra")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    fireEvent.click(navItem(zh("settings.section.sessions")));
    expect(
      await screen.findByText(
        zh("settings.conversationCount").replace("{value}", "12"),
      ),
    ).toBeTruthy();
  });
});
