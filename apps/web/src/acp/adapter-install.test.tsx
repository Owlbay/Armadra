import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import type { AdapterInstallJob, AgentInfo } from "@armadra/shared";

/**
 * ACP 适配器的安装入口（契约 §39.7）：集成页每行的状态与按钮、运行中的进度、
 * 失败的原因与输出尾部、新建向导里的直接安装。core 换成假的，不发请求。
 */

const mock = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  agents: vi.fn(),
}));

vi.mock("@/api/client", async () => {
  const request = await import("@/api/request");
  return {
    ...request,
    runtimeApi: {
      agents: () => mock.agents(),
      acpAdapterInstall: (agentId: string) => mock.status(agentId),
      installAcpAdapter: (agentId: string, reinstall: boolean) =>
        mock.install(agentId, reinstall),
    },
  };
});

const { installDomPolyfills, TestProviders } = await import(
  "@/app/test-harness"
);
const { usePreferencesStore } = await import("@/app/preferences-store");
const { translate } = await import("@/i18n");
const { AdapterInstallStatus, WizardInstallButton, adapterAgentId } =
  await import("./adapter-install");

installDomPolyfills();
afterEach(cleanup);

const zh = (key: string) => translate("zh-CN", key);

function agent(
  id: string,
  options: { cli?: boolean; acp?: boolean; baseAgent?: string } = {},
): AgentInfo {
  return {
    id,
    label: id === "codex" ? "Codex" : id,
    color: "#000000",
    launchCmd: id,
    promptMode: "argv",
    capabilities: [],
    installed: options.cli ?? true,
    ...(options.baseAgent ? { baseAgent: options.baseAgent } : {}),
    acp: {
      support: "official",
      program: `${id}-acp`,
      installed: options.acp ?? false,
      resume: "load",
    },
  } as unknown as AgentInfo;
}

function job(patch: Partial<AdapterInstallJob>): AdapterInstallJob {
  return {
    agentId: "codex",
    state: "idle",
    package: "@agentclientprotocol/codex-acp",
    output: [],
    ...patch,
  };
}

/** 页面上读 Agent 列表的那个查询：结束后它该被刷新一次。 */
function AgentsList() {
  useQuery({ queryKey: ["agents"], queryFn: () => mock.agents() });
  return null;
}

function view(row: AgentInfo, wizard = false) {
  return render(
    <TestProviders>
      <AgentsList />
      {wizard ? (
        <WizardInstallButton agent={row} />
      ) : (
        <AdapterInstallStatus agent={row} />
      )}
    </TestProviders>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mock.status.mockReset();
  mock.install.mockReset();
  mock.agents.mockReset().mockResolvedValue([]);
});

describe("adapterAgentId", () => {
  it("只认能代装的几家；custom: 条目借基础 CLI", () => {
    expect(adapterAgentId(agent("codex"))).toBe("codex");
    expect(adapterAgentId(agent("custom:x", { baseAgent: "pi" }))).toBe("pi");
    expect(adapterAgentId(agent("opencode"))).toBeNull();
  });
});

describe("集成页的 ACP 状态", () => {
  it("未安装：徽标 +「安装」；点了显示进度，按钮停用；失败后可展开看原因与输出", async () => {
    mock.status.mockResolvedValueOnce(job({ state: "idle" }));
    mock.install.mockResolvedValue(
      job({ state: "running", startedAt: "t", output: ["fetching"] }),
    );
    view(agent("codex"));
    const install = await screen.findByRole("button", {
      name: zh("integration.acp.install"),
    });
    expect(screen.getByText(zh("integration.acp.missing"))).toBeTruthy();

    // 下一次轮询答失败。
    mock.status.mockResolvedValue(
      job({
        state: "failed",
        exitCode: 1,
        output: ["npm error code E404", "npm error 404 Not Found"],
        failure: { code: "adapter_install_failed", message: "x" },
      }),
    );
    fireEvent.click(install);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith("codex", false),
    );
    const running = await screen.findByRole("button", {
      name: zh("integration.acp.installing"),
    });
    expect(running).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: zh("integration.acp.install"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    const failed = await screen.findByRole(
      "button",
      { name: zh("integration.acp.failed") },
      { timeout: 3000 },
    );
    // 结束了：刷新 Agent 列表（挂载时读过一次），按钮可以再点。
    await waitFor(() => expect(mock.agents).toHaveBeenCalledTimes(2));
    expect(
      (
        screen.getByRole("button", {
          name: zh("integration.acp.install"),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(failed);
    expect(
      await screen.findByText(
        zh("integration.acp.failure.failed").replace("{code}", "1"),
      ),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-slot=acp-install-output]")?.textContent,
    ).toBe("npm error code E404\nnpm error 404 Not Found");
  });

  it("已安装：「重新安装」带 reinstall；成功后刷新列表", async () => {
    mock.status.mockResolvedValueOnce(job({ state: "idle" }));
    mock.install.mockResolvedValue(job({ state: "running", reinstall: true }));
    view(agent("codex", { acp: true }));
    const reinstall = await screen.findByRole("button", {
      name: zh("integration.acp.reinstall"),
    });
    expect(screen.getByText(zh("integration.acp.installed"))).toBeTruthy();
    mock.status.mockResolvedValue(
      job({ state: "succeeded", exitCode: 0, installed: true }),
    );
    fireEvent.click(reinstall);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith("codex", true),
    );
    await waitFor(() => expect(mock.agents).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    expect(screen.getByText(zh("integration.acp.installed"))).toBeTruthy();
  });

  it("打开页面时已有一个在装的任务：直接显示进度", async () => {
    mock.status.mockResolvedValue(job({ state: "running" }));
    view(agent("codex"));
    expect(
      await screen.findByRole("button", {
        name: zh("integration.acp.installing"),
      }),
    ).toBeTruthy();
  });

  it("不能代装的那几家只有徽标，不问 core", async () => {
    view(agent("opencode"));
    expect(await screen.findByText(zh("integration.acp.missing"))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mock.status).not.toHaveBeenCalled();
  });

  it("读不到任务（成员没有权限）：不画按钮", async () => {
    mock.status.mockRejectedValue(new Error("forbidden"));
    view(agent("codex"));
    await waitFor(() => expect(mock.status).toHaveBeenCalled());
    expect(await screen.findByText(zh("integration.acp.missing"))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("新建向导的直接安装", () => {
  it("CLI 已装、适配器没装时出现，点了装、运行中停用", async () => {
    mock.status.mockResolvedValue(job({ state: "idle" }));
    mock.install.mockResolvedValue(job({ state: "running" }));
    view(agent("codex"), true);
    const button = await screen.findByRole("button", {
      name: zh("wizard.install.run"),
    });
    mock.status.mockResolvedValue(job({ state: "running" }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith("codex", false),
    );
    const running = await screen.findByRole("button", {
      name: zh("integration.acp.installing"),
    });
    expect((running as HTMLButtonElement).disabled).toBe(true);
  });

  it("CLI 没装、或适配器已装时不出现", async () => {
    mock.status.mockResolvedValue(job({ state: "idle" }));
    view(agent("codex", { cli: false }), true);
    await waitFor(() => expect(mock.status).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    view(agent("codex", { acp: true }), true);
    await waitFor(() => expect(mock.status).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
