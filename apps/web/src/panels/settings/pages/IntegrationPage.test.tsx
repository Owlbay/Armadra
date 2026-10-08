import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { AgentInfo } from "@armadra/shared";

const mock = vi.hoisted(() => ({
  agents: vi.fn(),
  integration: vi.fn(),
  installIntegration: vi.fn(),
  uninstallIntegration: vi.fn(),
  repair: vi.fn(),
  resync: vi.fn(),
  installStatus: vi.fn(),
}));

vi.mock("@/api/client", async () => {
  const request = await import("@/api/request");
  return {
    ...request,
    runtimeApi: {
      agents: () => mock.agents(),
      agentIntegration: (id: string) => mock.integration(id),
      installAgentIntegration: (id: string) => mock.installIntegration(id),
      uninstallAgentIntegration: (id: string) => mock.uninstallIntegration(id),
      repairAgentIntegration: (id: string) => mock.repair(id),
      resyncExecutionHost: (id: string) => mock.resync(id),
      acpAdapterInstall: (id: string, target: string) =>
        mock.installStatus(id, target),
      installAcpAdapter: vi.fn(),
    },
  };
});

import { installDomPolyfills, TestProviders } from "@/app/test-harness";
import { usePreferencesStore } from "@/app/preferences-store";
import { translate } from "@/i18n";
import { IntegrationPage } from "./IntegrationPage";

installDomPolyfills();
afterEach(cleanup);

const zh = (key: string) => translate("zh-CN", key);

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

function view() {
  return render(
    <TestProviders>
      <IntegrationPage />
    </TestProviders>,
  );
}

describe("IntegrationPage", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ locale: "zh-CN" });
    mock.agents.mockReset().mockResolvedValue([claude]);
    mock.integration.mockReset();
    mock.installIntegration.mockReset();
    mock.uninstallIntegration.mockReset();
    mock.repair.mockReset();
    mock.resync.mockReset();
    mock.installStatus
      .mockReset()
      .mockImplementation(async (agentId: string, target: string) => ({
        agentId,
        target,
        state: "idle",
        package: "pkg",
        output: [],
      }));
    window.localStorage.clear();
  });

  const healthy = {
    agentId: "claude",
    mode: "canvas",
    hook: { installed: true, revision: 4 },
    skill: { installed: true, revision: 12 },
    legacy: { found: [] },
    revision: 412,
    canvasAgents: { terminal: "available", acp: "available", reasons: [] },
  };

  /** 一家一张分组，标题是 CLI 名；没有问题的行只有值，没有任何徽标。 */
  it("draws one group per CLI with fixed rows and no badges when healthy", async () => {
    mock.agents.mockReset().mockResolvedValue([
      {
        ...claude,
        probe: {
          agentId: "claude",
          launchCmd: "claude",
          version: "2.1.0",
          status: "ok",
          probedAt: "2026-10-07T00:00:00Z",
        },
        acp: {
          support: "official",
          program: "claude-agent-acp",
          installed: true,
          resume: "load",
        },
        history: {
          index: "available",
          cost: "unsupported",
          transcript: "not-found",
        },
      },
    ]);
    mock.integration.mockResolvedValue(healthy);
    const { container } = view();
    expect(
      await screen.findByRole("heading", { name: "Claude Code" }),
    ).toBeTruthy();
    for (const row of [
      "integration.row.cli",
      "integration.row.acp",
      "integration.row.injection",
      "integration.row.canvasAgents",
      "integration.row.history",
    ]) {
      expect(await screen.findByText(zh(row))).toBeTruthy();
    }
    expect(
      screen.getByText(
        zh("integration.state.installedVersion").replace("{version}", "2.1.0"),
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(zh("integration.canvasAgents.both")),
    ).toBeTruthy();
    // 本地历史：可用的列出来，没找到的带后缀，不支持的不列。
    expect(
      screen.getByText(
        `${zh("integration.history.index")} · ${zh(
          "integration.history.notFound",
        ).replace("{part}", zh("integration.history.transcript"))}`,
      ),
    ).toBeTruthy();
    expect(container.querySelector("[data-slot=badge]")).toBeNull();
    expect(screen.queryByText(zh("integration.state.stale"))).toBeNull();
  });

  /** 「清理旧版 N」点开是清单，看过再按清单底下的「清理」。 */
  it("lists every leftover entry before offering the repair", async () => {
    mock.integration.mockResolvedValue({
      ...healthy,
      hook: { installed: false },
      skill: { installed: false },
      legacy: {
        found: [
          {
            kind: "hook_entry",
            path: "~/.claude/settings.json",
            detail: "target/debug/aicc-hook",
          },
          {
            kind: "skill_dir",
            path: "~/.claude/skills/aicc-canvas",
            detail: "aicc-canvas",
          },
        ],
      },
    });
    mock.repair.mockResolvedValue({
      agentId: "claude",
      found: [
        { kind: "hook_entry", path: "a", detail: "a" },
        { kind: "skill_dir", path: "b", detail: "b" },
      ],
      removed: ["a"],
      kept: ["b"],
      backup: "~/.claude/settings.json.armadra-backup-20260913",
    });
    view();
    expect(
      await screen.findByText(zh("integration.state.notGenerated")),
    ).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.action.repair").replace("{count}", "2"),
      }),
    );
    expect(await screen.findByText(/aicc-hook/)).toBeTruthy();
    expect(screen.getAllByText(/aicc-canvas/).length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.repair") }),
    );
    await waitFor(() => expect(mock.repair).toHaveBeenCalledWith("claude"));
  });

  /**
   * 同一条命令在每个 Hook 事件下各挂一次：清单按文件分组、相同的只列一次并标
   * 次数，主目录写成 `~`。整段命令拼进脚注曾把这一行撑到几屏高。
   */
  it("groups repeated leftovers by file with a count", async () => {
    const command = "/Users/dev/Applications/Old Build/aicc-hook claude";
    mock.integration.mockResolvedValue({
      ...healthy,
      legacy: {
        found: Array.from({ length: 11 }, () => ({
          kind: "hook_entry",
          path: "/Users/dev/.claude/settings.json",
          detail: command,
        })),
      },
    });
    view();
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText(/aicc-hook claude/)).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.action.repair").replace("{count}", "11"),
      }),
    );
    expect(await screen.findByText("~/.claude/settings.json")).toBeTruthy();
    const entries = screen.getAllByText(/aicc-hook claude/);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.textContent).toContain("~/Applications/Old Build");
    expect(screen.getByText("×11")).toBeTruthy();
  });

  /**
   * 画布内注入：没有「安装 / 卸载」，只有「重新生成」，正常时是 ghost。旧 core
   * 答的 globalWrites 不画；升级时清掉的旧全局安装是一条只出现一次的提示。
   */
  it("only regenerates, and tells about the migration once", async () => {
    mock.integration.mockResolvedValue({
      ...healthy,
      globalWrites: ["/Users/dev/.codex/config.toml"],
      migration: {
        migratedAt: "2026-09-26T00:00:00Z",
        removed: ["/Users/dev/.codex/hooks.json: armadra-hook"],
        backups: ["/Users/dev/.codex/hooks.json.armadra-backup-20260926"],
      },
    });
    mock.installIntegration.mockResolvedValue({});
    view();
    await waitFor(() =>
      expect(
        window.localStorage.getItem("armadra.integration.migrated.claude"),
      ).not.toBeNull(),
    );
    const regenerate = screen.getByRole("button", {
      name: zh("integration.regenerate"),
    });
    expect(regenerate.getAttribute("data-variant")).toBe("ghost");
    expect(screen.queryByText(/config\.toml/)).toBeNull();
    expect(screen.queryByText(zh("integration.state.limited"))).toBeNull();
    fireEvent.click(regenerate);
    await waitFor(() =>
      expect(mock.installIntegration).toHaveBeenCalledWith("claude"),
    );
    expect(mock.uninstallIntegration).not.toHaveBeenCalled();
  });

  /** 启动器少带了东西：值是「注入受限」，原因在悬停提示里。 */
  it("shows the launcher warning as the injection value", async () => {
    mock.integration.mockResolvedValue({
      ...healthy,
      launcherWarning: "Codex 0.133.0 is older than 0.134.0",
      canvasAgents: {
        terminal: "limited",
        acp: "none",
        reasons: ["launcher_limited"],
      },
    });
    view();
    const warning = await screen.findByText(zh("integration.state.limited"));
    expect(warning.getAttribute("title")).toBe(
      "Codex 0.133.0 is older than 0.134.0",
    );
    // 终端驱动受限、没有 ACP 入口：在画布中创建 Agent 不可用，原因在提示里。
    const spawn = screen.getByText(zh("integration.canvasAgents.none"));
    expect(spawn.getAttribute("title")).toBe(
      zh("integration.reason.launcher_limited"),
    );
  });

  /** 版本过旧：值「待更新」，「重新生成」变 secondary；ACP 未装是值不是徽标。 */
  it("marks an out-of-date install and a missing ACP adapter", async () => {
    mock.agents.mockReset().mockResolvedValue([
      {
        ...claude,
        acp: {
          support: "official",
          program: "claude-agent-acp",
          installed: false,
          resume: "load",
        },
      },
    ]);
    mock.integration.mockResolvedValue({
      ...healthy,
      revision: 416,
      installedRevision: 412,
      stale: true,
      canvasAgents: {
        terminal: "available",
        acp: "unavailable",
        reasons: ["acp_missing"],
      },
    });
    view();
    expect(await screen.findByText(zh("integration.state.stale"))).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: zh("integration.regenerate") })
        .getAttribute("data-variant"),
    ).toBe("secondary");
    expect(screen.getByText(zh("integration.state.missing"))).toBeTruthy();
    expect(
      screen.getByText(zh("integration.canvasAgents.terminal")),
    ).toBeTruthy();
  });

  /** 原生 ACP 的 CLI：ACP 行写「随 CLI」，没有自己的动作。 */
  it("says the ACP entry comes with a native CLI", async () => {
    mock.agents.mockReset().mockResolvedValue([
      {
        ...claude,
        id: "opencode",
        label: "OpenCode",
        launchCmd: "opencode",
        acp: {
          support: "native",
          program: "opencode",
          installed: true,
          resume: "load",
        },
      },
    ]);
    mock.integration.mockResolvedValue({ ...healthy, agentId: "opencode" });
    view();
    expect(
      await screen.findByText(zh("integration.state.viaCli")),
    ).toBeTruthy();
  });

  /** CLI 没装、能代装：CLI 行「未检测到」+「安装」，按 target: cli 读任务。 */
  it("offers to install a missing CLI", async () => {
    mock.agents
      .mockReset()
      .mockResolvedValue([{ ...claude, installed: false }]);
    mock.integration.mockResolvedValue(healthy);
    view();
    expect(
      await screen.findByText(zh("integration.state.cliMissing")),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mock.installStatus).toHaveBeenCalledWith("claude", "cli"),
    );
    const install = await screen.findByRole("button", {
      name: zh("integration.action.install"),
    });
    expect(install.getAttribute("data-install-target")).toBe("cli");
  });

  /**
   * Worker 过旧的执行主机（契约 §21.2）：页首一组，每台一个徽标与「重新同步」；
   * 同步成功后重读集成状态，徽标随之消失。
   */
  it("offers a resync for each execution host with an outdated Worker", async () => {
    const base = {
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 12 },
      legacy: { found: [] },
      revision: 4,
    };
    mock.integration
      .mockResolvedValueOnce({
        ...base,
        outdatedHosts: [{ hostId: "far", name: "Build box", version: "0.0.9" }],
      })
      .mockResolvedValue({ ...base, outdatedHosts: [] });
    mock.resync.mockResolvedValue({
      executionHostId: "far",
      name: "Build box",
      kind: "ssh",
      workerConfigured: true,
      workspaceCount: 0,
    });
    view();
    expect(await screen.findByText("Build box")).toBeTruthy();
    expect(
      screen.getByText(
        zh("integration.outdatedHost.version").replace("{version}", "0.0.9"),
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.resync") }),
    );
    await waitFor(() => expect(mock.resync).toHaveBeenCalledWith("far"));
    await waitFor(() => expect(screen.queryByText("Build box")).toBeNull());
  });

  it("draws no outdated group when every Worker is current", async () => {
    mock.integration.mockResolvedValue({ ...healthy, outdatedHosts: [] });
    view();
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: zh("integration.resync") }),
    ).toBeNull();
  });

  /**
   * 接口没答上来时整页是空白的：没有 CLI 与还没读完长得一模一样，用户
   * 只能看着一张空页猜。
   */
  it("says so when there is no CLI to list", async () => {
    mock.agents.mockReset().mockResolvedValue([]);
    view();
    expect(await screen.findByText(zh("integration.empty"))).toBeTruthy();
  });
});
