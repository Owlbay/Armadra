import type { HostSide } from "@/updates/state";
import type { ShellOffer, ShellUpdateState } from "@/updates/shell-updater";

/**
 * `updates` 分区的假数据（设计展示页 §2.1）：更新设计 §4.1 的十一种状态，各
 * 一对「后台服务的回答 + 桌面壳的状态」，交给真的 `mergeUpdatesState` 去合并。
 * 纯对象，无副作用。
 */

const OFFER: ShellOffer = {
  version: "0.9.0",
  target: "darwin-aarch64",
  manifestUrl: "https://releases.armadra.test/latest-darwin-aarch64-mac.yml",
  packageUrl: "https://releases.armadra.test/Armadra-0.9.0-arm64.zip",
  sha256: "ab".repeat(32),
  sizeBytes: 96 * 1_048_576,
  signed: true,
  notesUrl: "https://releases.armadra.test/notes/0.9.0",
};

const answered = (
  verdict: "upToDate" | "available" | "unavailable",
  reasonCode = "",
): HostSide => ({
  kind: "answered",
  verdict,
  reasonCode,
  retryAfterMs: 0,
  checkedAtMs: Date.UTC(2026, 9, 3, 8, 0, 0),
  release:
    verdict === "available"
      ? {
          version: OFFER.version,
          channel: "stable",
          notesUrl: OFFER.notesUrl,
          sizeBytes: OFFER.sizeBytes,
          signature: "present",
        }
      : null,
});

/** 已安装的版本（只在「当前版本」一行出现）。 */
export const INSTALLED = "0.8.4";

export const UPDATE_STATES: readonly {
  id: string;
  host: HostSide;
  shell: ShellUpdateState;
}[] = [
  {
    id: "notConfigured",
    host: { kind: "notAsked" },
    shell: {
      state: "notConfigured",
      missing: { pubkey: true, endpoints: false },
    },
  },
  {
    id: "localBuild",
    host: { kind: "notAsked" },
    shell: { state: "localBuild" },
  },
  {
    id: "shellUnsupported",
    host: answered("available"),
    shell: { state: "unsupported", reason: "notDesktop" },
  },
  { id: "idle", host: { kind: "notAsked" }, shell: { state: "idle" } },
  { id: "checking", host: { kind: "checking" }, shell: { state: "checking" } },
  {
    id: "upToDate",
    host: answered("upToDate"),
    shell: { state: "upToDate", checkedAtMs: 1 },
  },
  {
    id: "unavailable",
    host: answered("unavailable", "SOURCE_UNREACHABLE"),
    shell: {
      state: "unavailable",
      reason: "sourceUnreachable",
      retryAfterMs: 15 * 60_000,
      checkedAtMs: 1,
    },
  },
  {
    id: "available",
    host: answered("available"),
    shell: { state: "available", offer: OFFER },
  },
  {
    id: "downloading",
    host: answered("available"),
    shell: {
      state: "downloading",
      offer: OFFER,
      receivedBytes: 38 * 1_048_576,
      totalBytes: OFFER.sizeBytes,
    },
  },
  {
    id: "downloaded",
    host: answered("available"),
    shell: { state: "downloaded", offer: OFFER, phase: "ready", problem: null },
  },
  {
    id: "failed",
    host: answered("available"),
    shell: { state: "failed", reason: "digestMismatch", offer: OFFER },
  },
];
