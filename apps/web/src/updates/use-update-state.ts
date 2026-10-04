/**
 * The update section's live state: the desktop shell's machine, plus the
 * periodic check that keeps it current (design §4.2, §5.3).
 *
 * The store holds no opinion of its own. It records what each side last said
 * and lets `mergeUpdatesState` decide what that means, so the rule about never
 * reporting "up to date" for a check that did not happen lives in one tested
 * function rather than in a component's conditionals.
 *
 * **The desktop shell asks the release index itself.** "Check" is
 * `updates:check` with nothing attached; the shell fetches the index, applies
 * the channel and the staged rollout, cross-checks the manifest and answers
 * with its machine's state, which is then the whole release answer
 * (`hostAfterShell`). `noReleaseSource` appears only when the shell says it has
 * no index to ask. A page with no desktop shell (a browser) asks nothing: the
 * core has no release side of its own, and installing there is a manual act.
 *
 * The shell runs its own schedule (`startSchedule`, honouring
 * `updates.autoCheck`), so the page's timer only reads the state back
 * (`refresh`) instead of forcing a check past the shell's interval.
 */
import { create } from "zustand";

import {
  hasShellUpdater,
  onShellProgress,
  onShellStaged,
  shellCancel,
  shellCheck,
  shellDismiss,
  shellDownload,
  shellInstall,
  shellRestartReport,
  shellState,
  UNSUPPORTED_HERE,
  type ShellRestartReport,
  type ShellUpdateState,
} from "./shell-updater";
import {
  hostAfterShell,
  NO_RELEASE_SOURCE,
  type HostRelease,
  type HostSide,
} from "./state";

export { NO_RELEASE_SOURCE };

/** Design §2.1: after 30s, then every six hours, then whenever asked. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 30_000;

/** The build target a release would be published for, from the browser. */
export function detectTarget(
  platform: string,
  userAgent: string,
): string | null {
  const haystack = `${platform} ${userAgent}`.toLowerCase();
  const system = haystack.includes("mac")
    ? "darwin"
    : haystack.includes("win")
      ? "windows"
      : haystack.includes("linux")
        ? "linux"
        : null;
  if (!system) return null;
  // "arm64" is what every one of the three reports; a browser never says which
  // ABI, which is why a target is asked about rather than a triple.
  const arch = /arm64|aarch64/.test(haystack) ? "aarch64" : "x86_64";
  return `${system}-${arch}`;
}

export interface UpdatesStore {
  host: HostSide;
  shell: ShellUpdateState;
  release: HostRelease | null;
  restart: ShellRestartReport | null;
  /** Started once per page; safe to call again. */
  start: () => () => void;
  /** A person pressing "check": the shell asks the release index now. */
  check: () => Promise<void>;
  /** Reads the shell's state back; asks nothing off the network. */
  refresh: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => Promise<void>;
  /** Stops a transfer or a check in flight and reports where that left it. */
  cancel: () => Promise<void>;
  acknowledgeRestart: () => void;
}

export const useUpdateState = create<UpdatesStore>((set, get) => {
  let started = false;

  return {
    host: { kind: "notAsked" },
    shell: UNSUPPORTED_HERE,
    release: null,
    restart: null,

    start() {
      if (started) return () => undefined;
      started = true;
      void (async () => {
        const shell = await shellState();
        set({ shell, host: hostAfterShell(shell, false) });
        const report = await shellRestartReport();
        if (report) set({ restart: report });
      })();
      const stopProgress = onShellProgress((progress) => {
        // Progress is only meaningful while a transfer is the current state;
        // a late event must not resurrect one that already ended.
        const shell = get().shell;
        if (shell.state !== "downloading") return;
        set({ shell: { ...shell, ...progress } });
      });
      // The tray and the notification are driven by the same announcement. A
      // page that was not open when an `autoDownload` transfer finished reads
      // the state back rather than guessing it from the payload.
      const stopStaged = onShellStaged(() => {
        void get().refresh();
      });
      return () => {
        started = false;
        stopProgress();
        stopStaged();
      };
    },

    async check() {
      if (!hasShellUpdater()) {
        set({
          host: { kind: "notAsked" },
          release: null,
          shell: UNSUPPORTED_HERE,
        });
        return;
      }
      set({ host: { kind: "checking" }, release: null });
      const shell = await shellCheck();
      // Cancelled while the shell was still asking: its answer is no longer
      // the one this check stands for, so read the state back instead.
      if (get().host.kind !== "checking") {
        await get().refresh();
        return;
      }
      set({ shell, host: hostAfterShell(shell, true) });
    },

    async refresh() {
      const shell = await shellState();
      // A check in flight keeps its spinner; the answer it brings decides.
      if (get().host.kind === "checking") {
        set({ shell });
        return;
      }
      const host = get().host;
      set({
        shell,
        host:
          host.kind === "blocked" && shell.state === "idle"
            ? host
            : hostAfterShell(shell, false),
      });
    },

    async download() {
      set({ shell: await shellDownload() });
    },

    async install() {
      set({ shell: await shellInstall() });
    },

    async dismiss() {
      set({ shell: await shellDismiss() });
    },

    async cancel() {
      const shell = await shellCancel();
      // A cancelled check leaves the Host side mid-request too; reporting it as
      // "checking" for ever would be the one thing this section must not do.
      if (get().host.kind === "checking") set({ host: { kind: "notAsked" } });
      set({ shell });
    },

    acknowledgeRestart() {
      set({ restart: null });
    },
  };
});
