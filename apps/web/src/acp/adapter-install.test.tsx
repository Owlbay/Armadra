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
      acpAdapterInstall: (agentId: string, target: string) =>
        mock.status(agentId, target),
      installAcpAdapter: (
        agentId: string,
        reinstall: boolean,
        target: string,
        rollback: boolean,
      ) => mock.install(agentId, reinstall, target, rollback),
    },
  };
});

const { installDomPolyfills, TestProviders } = await import(
  "@/app/test-harness"
);
const { usePreferencesStore } = await import("@/app/preferences-store");
const { translate } = await import("@/i18n");
const {
  InstallButton,
  InstallFailure,
  WizardInstallButton,
  adapterAgentId,
  installAgentId,
  useInstallJob,
} = await import("./adapter-install");

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

/** 集成页一家的 CLI / ACP 两行用的那一套：按钮 + 行下的失败。 */
function Rows({ row }: { row: AgentInfo }) {
  const cli = useInstallJob(row, "cli");
  const adapter = useInstallJob(row, "adapter");
  return (
    <>
      <InstallButton install={cli} installed={row.installed} />
      <InstallButton
        install={adapter}
        installed={row.acp?.installed ?? false}
      />
      <InstallFailure agent={row} jobs={[cli, adapter]} />
    </>
  );
}

function view(row: AgentInfo, wizard = false) {
  return render(
    <TestProviders>
      <AgentsList />
      {wizard ? <WizardInstallButton agent={row} /> : <Rows row={row} />}
    </TestProviders>,
  );
}

const adapterButton = () =>
  document.querySelector(
    "[data-install-target=adapter]",
  ) as HTMLButtonElement | null;
const cliButton = () =>
  document.querySelector(
    "[data-install-target=cli]",
  ) as HTMLButtonElement | null;

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mock.status
    .mockReset()
    .mockImplementation(async (agentId: string, target: string) =>
      job({ agentId, target: target as "adapter" | "cli", state: "idle" }),
    );
  mock.install.mockReset();
  mock.agents.mockReset().mockResolvedValue([]);
});

describe("installAgentId", () => {
  it("适配器只认能代装的几家，custom: 借基础 CLI；CLI 认 CLI 表，custom: 不代装", () => {
    expect(adapterAgentId(agent("codex"))).toBe("codex");
    expect(adapterAgentId(agent("custom:x", { baseAgent: "pi" }))).toBe("pi");
    expect(adapterAgentId(agent("opencode"))).toBeNull();
    expect(installAgentId(agent("opencode"), "cli")).toBe("opencode");
    expect(installAgentId(agent("omp"), "cli")).toBe("omp");
    expect(
      installAgentId(agent("custom:x", { baseAgent: "pi" }), "cli"),
    ).toBeNull();
  });
});

describe("集成页的安装", () => {
  it("ACP 未安装：「安装」；点了进度、按钮停用；失败后行下一条 Alert，可看输出", async () => {
    mock.install.mockResolvedValue(
      job({ state: "running", startedAt: "t", output: ["fetching"] }),
    );
    view(agent("codex"));
    await waitFor(() => expect(adapterButton()).not.toBeNull());
    expect(adapterButton()!.textContent).toBe(zh("integration.action.install"));
    // CLI 已装：那一行是「重新安装」。
    await waitFor(() =>
      expect(cliButton()?.textContent).toBe(zh("integration.action.reinstall")),
    );

    mock.status.mockImplementation(async (agentId: string, target: string) =>
      target === "cli"
        ? job({ agentId, target: "cli", state: "idle" })
        : job({
            state: "failed",
            exitCode: 1,
            output: ["npm error code E404", "npm error 404 Not Found"],
            failure: { code: "adapter_install_failed", message: "x" },
          }),
    );
    fireEvent.click(adapterButton()!);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith(
        "codex",
        false,
        "adapter",
        false,
      ),
    );
    await waitFor(() =>
      expect(adapterButton()?.getAttribute("aria-busy")).toBe("true"),
    );
    expect(adapterButton()!.disabled).toBe(true);

    const alert = await screen.findByText(
      zh("integration.install.failed").replace(
        "{name}",
        "@agentclientprotocol/codex-acp",
      ),
      undefined,
      { timeout: 3000 },
    );
    expect(alert.closest("[role=alert]")).not.toBeNull();
    // 结束了：刷新 Agent 列表（挂载时读过一次），按钮可以再点。
    await waitFor(() => expect(mock.agents).toHaveBeenCalledTimes(2));
    expect(adapterButton()!.disabled).toBe(false);
    // 没有上一版本：没有「恢复上一版本」。
    expect(
      screen.queryByRole("button", { name: zh("integration.action.rollback") }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: zh("integration.action.output") }),
    );
    expect(
      await screen.findByText(
        zh("integration.acp.failure.failed").replace("{code}", "1"),
      ),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-slot=acp-install-output]")?.textContent,
    ).toBe("npm error code E404\nnpm error 404 Not Found");
  });

  it("重新安装坏了且有上一版本：「恢复上一版本」带 rollback", async () => {
    mock.status.mockImplementation(async (agentId: string, target: string) =>
      target === "cli"
        ? job({ agentId, target: "cli", state: "idle" })
        : job({
            state: "failed",
            reinstall: true,
            installed: false,
            previousVersion: "0.9.0",
            failure: { code: "adapter_install_missing", message: "x" },
          }),
    );
    mock.install.mockResolvedValue(job({ state: "running", rollback: true }));
    view(agent("codex", { acp: true }));
    const rollback = await screen.findByRole("button", {
      name: zh("integration.action.rollback"),
    });
    fireEvent.click(rollback);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith("codex", true, "adapter", true),
    );
  });

  it("CLI 未检测到：「安装」装 CLI 包", async () => {
    mock.install.mockResolvedValue(job({ target: "cli", state: "running" }));
    view(agent("opencode", { cli: false }));
    await waitFor(() =>
      expect(cliButton()?.textContent).toBe(zh("integration.action.install")),
    );
    // opencode 没有可代装的适配器：ACP 那一样不画按钮、不问 core。
    expect(adapterButton()).toBeNull();
    expect(mock.status).not.toHaveBeenCalledWith("opencode", "adapter");
    fireEvent.click(cliButton()!);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith(
        "opencode",
        false,
        "cli",
        false,
      ),
    );
  });

  it("没有 npm：行下一条「没有找到 npm」+「复制命令」", async () => {
    const { RuntimeRequestError } = await import("@/api/request");
    mock.install.mockRejectedValue(
      new RuntimeRequestError(409, "找不到 npm", "npm_not_found"),
    );
    view(agent("codex"));
    await waitFor(() => expect(adapterButton()).not.toBeNull());
    fireEvent.click(adapterButton()!);
    expect(
      await screen.findByText(zh("integration.install.npmMissing")),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: zh("integration.action.copyCommand") })
        .getAttribute("title"),
    ).toBe("npm i -g @agentclientprotocol/codex-acp");
  });

  it("打开页面时已有一个在装的任务：直接显示进度", async () => {
    mock.status.mockResolvedValue(job({ state: "running" }));
    view(agent("codex"));
    await waitFor(() =>
      expect(adapterButton()?.textContent).toBe(
        zh("integration.action.installing"),
      ),
    );
  });

  it("读不到任务（成员没有权限）：不画按钮", async () => {
    mock.status.mockRejectedValue(new Error("forbidden"));
    view(agent("codex"));
    await waitFor(() => expect(mock.status).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("新建向导的直接安装", () => {
  it("CLI 已装、适配器没装时出现，点了装适配器、运行中停用", async () => {
    mock.install.mockResolvedValue(job({ state: "running" }));
    view(agent("codex"), true);
    const button = await screen.findByRole("button", {
      name: zh("integration.action.install"),
    });
    mock.status.mockResolvedValue(job({ state: "running" }));
    fireEvent.click(button);
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith(
        "codex",
        false,
        "adapter",
        false,
      ),
    );
    const running = await screen.findByRole("button", {
      name: zh("integration.action.installing"),
    });
    expect((running as HTMLButtonElement).disabled).toBe(true);
  });

  it("CLI 没装时装 CLI；都装好时不出现", async () => {
    mock.install.mockResolvedValue(job({ target: "cli", state: "running" }));
    view(agent("opencode", { cli: false }), true);
    fireEvent.click(
      await screen.findByRole("button", {
        name: zh("integration.action.install"),
      }),
    );
    await waitFor(() =>
      expect(mock.install).toHaveBeenCalledWith(
        "opencode",
        false,
        "cli",
        false,
      ),
    );
    cleanup();
    view(agent("codex", { acp: true }), true);
    await waitFor(() => expect(mock.status).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
