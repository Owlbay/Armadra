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
  });

  it("lists every leftover entry before offering the repair", async () => {
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
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
      revision: 4,
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
    // 清单收在徽标里，点开之前不占行高。
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.legacy.count").replace("{count}", "2"),
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
    const command =
      "(if [ -r '/Users/dev/.aicc/aicc-hook/claude.sh' ]; then sh '/Users/dev/.aicc/aicc-hook/claude.sh'; fi)";
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 10 },
      legacy: {
        found: Array.from({ length: 11 }, () => ({
          kind: "hook_entry",
          path: "/Users/dev/.claude/settings.json",
          detail: command,
        })),
      },
      revision: 4,
    });
    view();
    // 名字仍在行里，没有被挤出视口。
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    expect(screen.queryByText(/aicc-hook\/claude/)).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.legacy.count").replace("{count}", "11"),
      }),
    );
    expect(await screen.findByText("~/.claude/settings.json")).toBeTruthy();
    const entries = screen.getAllByText(/aicc-hook\/claude\.sh/);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.textContent).toContain("'~/.aicc/aicc-hook");
    expect(screen.getByText("×11")).toBeTruthy();
  });

  /**
   * 画布内注入：没有「安装 / 卸载」，只有「重新生成」。数据目录之外不写文件，
   * 旧 core 答的 globalWrites 也不再画；升级时清掉的旧全局安装与 Codex 的
   * 会话信任记录在一个徽标上说出来。
   */
  it("shows the migration but no global write, and only regenerates", async () => {
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 12 },
      legacy: { found: [] },
      revision: 412,
      globalWrites: ["/Users/dev/.codex/config.toml"],
      migration: {
        migratedAt: "2026-09-26T00:00:00Z",
        removed: ["/Users/dev/.codex/hooks.json: armadra-hook"],
        backups: ["/Users/dev/.codex/hooks.json.armadra-backup-20260926"],
      },
    });
    mock.installIntegration.mockResolvedValue({});
    view();
    expect(await screen.findByText(zh("integration.mode.canvas"))).toBeTruthy();
    expect(screen.queryByText(/config\.toml/)).toBeNull();
    expect(screen.queryByText(zh("integration.launcherWarning"))).toBeNull();
    expect(screen.getByText(zh("integration.migrated"))).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: zh("integration.repair") }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.regenerate") }),
    );
    await waitFor(() =>
      expect(mock.installIntegration).toHaveBeenCalledWith("claude"),
    );
    expect(mock.uninstallIntegration).not.toHaveBeenCalled();
  });

  /** 启动器少带了东西：徽标说「注入受限」，原因在悬停提示里。 */
  it("shows the launcher warning and the cleared session trust", async () => {
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 16 },
      legacy: { found: [] },
      revision: 416,
      globalWrites: [],
      launcherWarning: "Codex 0.133.0 is older than 0.134.0",
      migration: {
        migratedAt: "2026-09-26T00:00:00Z",
        removed: [],
        backups: [],
        sessionTrust: {
          at: "2026-10-02T00:00:00Z",
          removed: ["/<session-flags>/config.toml:stop:0:0"],
          backup: "/Users/dev/.codex/config.toml.armadra-backup-20261002",
        },
      },
    });
    view();
    const warning = await screen.findByText(zh("integration.launcherWarning"));
    expect(warning.getAttribute("title")).toBe(
      "Codex 0.133.0 is older than 0.134.0",
    );
    expect(
      screen.getByText(zh("integration.migrated")).getAttribute("title"),
    ).toBe("/Users/dev/.codex/config.toml.armadra-backup-20261002");
  });

  /** 历史数据三项：没有数据写状态词，不写 0。 */
  it("shows the three history badges with a state word each", async () => {
    mock.agents.mockReset().mockResolvedValue([
      {
        ...claude,
        history: {
          index: "available",
          cost: "unsupported",
          transcript: "not-found",
        },
      },
    ]);
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 12 },
      legacy: { found: [] },
      revision: 4,
    });
    view();
    const badge = (part: string, state: string) =>
      zh(`integration.history.${part}`).replace("{state}", zh(state));
    const index = await screen.findByText(
      badge("index", "capability.state.supported"),
    );
    expect(index.getAttribute("data-variant")).toBe("secondary");
    const cost = screen.getByText(
      badge("cost", "capability.state.unsupported"),
    );
    expect(cost.getAttribute("data-variant")).toBe("outline");
    expect(
      screen.getByText(badge("transcript", "capability.state.notFound")),
    ).toBeTruthy();
  });

  it("marks a transcript switched off on a custom entry as disabled", async () => {
    mock.agents.mockReset().mockResolvedValue([
      {
        ...claude,
        history: {
          index: "not-found",
          cost: "not-found",
          transcript: "disabled",
        },
      },
    ]);
    mock.integration.mockResolvedValue({
      agentId: "claude",
      mode: "canvas",
      hook: { installed: true, revision: 4 },
      skill: { installed: true, revision: 12 },
      legacy: { found: [] },
      revision: 4,
    });
    view();
    expect(
      await screen.findByText(
        zh("integration.history.transcript").replace(
          "{state}",
          zh("capability.state.disabled"),
        ),
      ),
    ).toBeTruthy();
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
