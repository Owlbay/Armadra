import type {
  AdapterInstallJob,
  AdapterInstallTarget,
  AgentInfo,
  ExecutionHost,
  ExecutionHostHealth,
  IntegrationState,
} from "@armadra/shared";

/**
 * `integration` 分区的假数据（设计展示页 §2.1）：执行主机的舰队。纯对象，
 * 无副作用；主机名与地址是数据不是界面文案。
 */

const CAPABILITIES = ["remote.execution.v1", "remote.handoff.v1"];

const at = (minute: number): string =>
  new Date(Date.UTC(2026, 9, 3, 8, minute, 0)).toISOString();

const STEADY: ExecutionHostHealth[] = Array.from({ length: 8 }, (_, index) => ({
  at: at(index * 5),
  event: "handshake" as const,
  ok: true,
  version: "0.1.0",
}));

const FLAKY: ExecutionHostHealth[] = [
  { at: at(0), event: "handshake", ok: true, version: "0.0.9" },
  { at: at(12), event: "disconnected", ok: false },
  { at: at(13), event: "failed", ok: false, code: "unreachable" },
  { at: at(20), event: "handshake", ok: true, version: "0.0.9" },
  { at: at(41), event: "disconnected", ok: false },
  { at: at(42), event: "failed", ok: false, code: "unavailable" },
];

export const LOCAL: ExecutionHost = {
  executionHostId: "",
  name: "",
  kind: "local",
  workerConfigured: true,
  workspaceCount: 3,
};

export const BUILD_BOX: ExecutionHost = {
  executionHostId: "build-box",
  name: "build-box",
  kind: "ssh",
  ssh: { id: "build-box", name: "build-box", host: "build.lan", user: "ci" },
  workerConfigured: true,
  workspaceCount: 2,
  worker: {
    version: "0.1.0",
    capabilities: CAPABILITIES,
    outdated: false,
    connected: true,
    checkedAt: at(35),
  },
  health: STEADY,
};

export const GPU_NODE: ExecutionHost = {
  executionHostId: "gpu-01",
  name: "gpu-01",
  kind: "ssh",
  ssh: { id: "gpu-01", name: "gpu-01", host: "10.0.4.21", port: 2222 },
  workerConfigured: true,
  workspaceCount: 1,
  worker: {
    version: "0.0.9",
    capabilities: CAPABILITIES.slice(0, 1),
    outdated: true,
    connected: false,
    checkedAt: at(20),
  },
  health: FLAKY,
};

export const NEW_HOST: ExecutionHost = {
  executionHostId: "staging",
  name: "staging",
  kind: "ssh",
  ssh: { id: "staging", name: "staging", host: "staging.example.com" },
  workerConfigured: true,
  workspaceCount: 0,
};

export const TERMINAL_ONLY: ExecutionHost = {
  executionHostId: "pi",
  name: "pi",
  kind: "ssh",
  ssh: { id: "pi", name: "pi", host: "raspberrypi.local", user: "pi" },
  workerConfigured: false,
  workspaceCount: 0,
};

export const FLEET: ExecutionHost[] = [
  LOCAL,
  BUILD_BOX,
  GPU_NODE,
  NEW_HOST,
  TERMINAL_ONLY,
];

/* ------------------------------ CLI 分组 ------------------------------ */

/** 一种 CLI：画布启动器 + ACP 入口（`acp` 为空的没有 ACP 入口）。 */
function cli(
  id: string,
  label: string,
  acp: {
    installed: boolean;
    support?: "native" | "official" | "community";
  } | null,
  extra: Partial<AgentInfo> = {},
): AgentInfo {
  return {
    id,
    label,
    color: "#d97757",
    launchCmd: id,
    promptMode: "argv",
    args: [],
    capabilities: ["hooks"],
    resolvedPath: `/usr/local/bin/${id}`,
    installed: true,
    clientRevision: 3,
    probe: {
      agentId: id,
      launchCmd: id,
      version: "2.1.0",
      status: "ok",
      probedAt: at(0),
    },
    history: { index: "available", cost: "available", transcript: "available" },
    ...(acp === null
      ? {}
      : {
          acp: {
            support: acp.support ?? "official",
            program: acp.support === "native" ? id : `${id}-acp`,
            installed: acp.installed,
            resume: "load",
          },
        }),
    ...extra,
  } as AgentInfo;
}

function state(
  agentId: string,
  extra: Partial<IntegrationState> = {},
): IntegrationState {
  return {
    agentId,
    mode: "canvas",
    hook: { installed: true, revision: 4, path: `run/${agentId}` },
    skill: { installed: true, revision: 16 },
    legacy: { found: [] },
    revision: 416,
    stale: false,
    launchArgs: [],
    launchEnv: [],
    globalWrites: [],
    canvasAgents: { terminal: "available", acp: "available", reasons: [] },
    ...extra,
  } as IntegrationState;
}

/** 一家一样东西的安装任务（展示页预先放进缓存，不去问 core）。 */
export function idleJob(
  agentId: string,
  target: AdapterInstallTarget,
): AdapterInstallJob {
  return { agentId, target, state: "idle", package: agentId, output: [] };
}

/**
 * 正常 · 注入待更新（带两条本产品旧版本的残留）· 原生 ACP、启动器异常 · 适配器
 * 不接画布工具、重新安装失败可恢复 · CLI 未检测到。
 */
export const CLI_GROUP: readonly {
  agent: AgentInfo;
  integration: IntegrationState;
  jobs?: Partial<Record<AdapterInstallTarget, AdapterInstallJob>>;
}[] = [
  {
    agent: cli("claude", "Claude Code", { installed: true }),
    integration: state("claude"),
  },
  {
    agent: cli("codex", "Codex", { installed: true }),
    integration: state("codex", {
      stale: true,
      installedRevision: 412,
      legacy: {
        found: [
          {
            kind: "hook_entry",
            path: "/Users/demo/.codex/hooks.json",
            detail: "armadra-hook --event session-start",
          },
          {
            kind: "hook_entry",
            path: "/Users/demo/.codex/hooks.json",
            detail: "armadra-hook --event session-start",
          },
        ],
      },
    }),
  },
  {
    agent: cli("copilot", "Copilot", { installed: true, support: "native" }),
    integration: state("copilot", {
      launcherWarning: "armadra-launch.exe is missing",
      canvasAgents: {
        terminal: "limited",
        acp: "available",
        reasons: ["launcher_limited"],
      },
    }),
  },
  {
    agent: cli("pi", "Pi", { installed: true, support: "community" }),
    integration: state("pi", {
      canvasAgents: {
        terminal: "available",
        acp: "limited",
        reasons: ["mcp_not_wired"],
      },
    }),
    jobs: {
      adapter: {
        agentId: "pi",
        target: "adapter",
        state: "failed",
        package: "pi-acp",
        reinstall: true,
        previousVersion: "0.0.30",
        startedAt: at(30),
        endedAt: at(31),
        exitCode: 1,
        installed: false,
        output: [
          "npm error code ETARGET",
          "npm error notarget No matching version",
        ],
        failure: { code: "adapter_install_failed", message: "npm 以 1 退出" },
      },
    },
  },
  {
    agent: cli(
      "opencode",
      "OpenCode",
      { installed: false, support: "native" },
      { installed: false, resolvedPath: null, history: undefined },
    ),
    integration: state("opencode", {
      canvasAgents: {
        terminal: "unavailable",
        acp: "unavailable",
        reasons: ["cli_missing", "acp_missing"],
      },
    }),
  },
];
