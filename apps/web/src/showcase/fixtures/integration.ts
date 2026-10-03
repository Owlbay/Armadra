import type { ExecutionHost, ExecutionHostHealth } from "@armadra/shared";

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
