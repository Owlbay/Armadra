/**
 * 「检查」经桌面壳的 `updates:check`（不带答复）由壳自己问发布索引；
 * `noReleaseSource` 只在壳答没有发布源时出现。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeUpdatesState } from "./state";
import { NO_RELEASE_SOURCE, useUpdateState } from "./use-update-state";

const calls: [string, unknown][] = [];

function expose(answers: Record<string, unknown> | null): void {
  if (answers === null) {
    Reflect.deleteProperty(globalThis as object, "armadra");
    return;
  }
  const record = (name: string) => async (argument?: unknown) => {
    calls.push([name, argument]);
    const answer = answers[name];
    return typeof answer === "function" ? (answer as () => unknown)() : answer;
  };
  const updates: ArmadraUpdatesBridge = {
    state: record("state"),
    check: record("check"),
    dismiss: record("dismiss"),
    cancel: record("cancel"),
    download: record("download"),
    install: record("install"),
    restartReport: record("restartReport"),
    onProgress: () => () => undefined,
  };
  Object.defineProperty(globalThis, "armadra", {
    value: { updates },
    configurable: true,
    writable: true,
  });
}

function reset(): void {
  useUpdateState.setState({
    host: { kind: "notAsked" },
    shell: { state: "unsupported", reason: "notDesktop" },
    release: null,
    restart: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  expose(null);
  reset();
});

afterEach(() => {
  expose(null);
});

describe("useUpdateState.check", () => {
  it("asks the shell with nothing attached, and its answer is the release side", async () => {
    expose({ check: { state: "upToDate", checkedAtMs: 5 } });
    await useUpdateState.getState().check();
    expect(calls).toEqual([["check", undefined]]);
    const { host, shell } = useUpdateState.getState();
    expect(host).toEqual({ kind: "shell" });
    expect(mergeUpdatesState(host, shell).state).toBe("upToDate");
  });

  it("an offer from the shell is offered", async () => {
    const offer = {
      version: "0.2.1",
      target: "darwin-aarch64",
      manifestUrl: "https://x.invalid/latest.json",
      packageUrl: "https://x.invalid/a.zip",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      signed: true,
      notesUrl: "",
    };
    expose({ check: { state: "available", offer } });
    await useUpdateState.getState().check();
    const { host, shell } = useUpdateState.getState();
    const view = mergeUpdatesState(host, shell);
    expect(view.state).toBe("available");
    expect(view.actions).toContain("download");
  });

  it("says noReleaseSource only when the shell had no index to ask", async () => {
    // 壳没有发布源时原样答回 idle。
    expose({ check: { state: "idle" } });
    await useUpdateState.getState().check();
    expect(useUpdateState.getState().host).toEqual(NO_RELEASE_SOURCE);

    expose({
      check: {
        state: "notConfigured",
        missing: { pubkey: false, endpoints: true },
      },
    });
    await useUpdateState.getState().check();
    expect(useUpdateState.getState().host).toEqual(NO_RELEASE_SOURCE);

    expose({
      check: {
        state: "unavailable",
        reason: "sourceUnreachable",
        retryAfterMs: 0,
        checkedAtMs: 1,
      },
    });
    await useUpdateState.getState().check();
    const { host, shell } = useUpdateState.getState();
    expect(host).toEqual({ kind: "shell" });
    const view = mergeUpdatesState(host, shell);
    expect(view.state).toBe("unavailable");
    expect(view.detailKeys).toEqual(["updates.shellReason.sourceUnreachable"]);
  });

  it("a browser asks nothing and never shows noReleaseSource", async () => {
    await useUpdateState.getState().check();
    expect(calls).toEqual([]);
    const { host, shell } = useUpdateState.getState();
    expect(host).toEqual({ kind: "notAsked" });
    const view = mergeUpdatesState(host, shell);
    expect(view.state).toBe("shellUnsupported");
    expect(view.detailKeys).not.toContain("updates.blocked.noReleaseSource");
  });

  it("a check cancelled while the shell asked reads the state back", async () => {
    let release: (value: unknown) => void = () => undefined;
    expose({
      check: () => new Promise((resolve) => (release = resolve)),
      cancel: { state: "idle" },
      state: { state: "idle" },
    });
    const pending = useUpdateState.getState().check();
    expect(useUpdateState.getState().host).toEqual({ kind: "checking" });
    await useUpdateState.getState().cancel();
    release({ state: "idle" });
    await pending;
    // 取消后壳回到 idle，不是「没有发布源」。
    expect(useUpdateState.getState().host).toEqual({ kind: "notAsked" });
  });
});

describe("useUpdateState.refresh", () => {
  it("reads the state back without asking the release index", async () => {
    expose({ state: { state: "upToDate", checkedAtMs: 9 } });
    await useUpdateState.getState().refresh();
    expect(calls).toEqual([["state", undefined]]);
    expect(useUpdateState.getState().host).toEqual({ kind: "shell" });
  });

  it("an idle shell before any check is not yet asked, not unconfigured", async () => {
    expose({ state: { state: "idle" } });
    await useUpdateState.getState().refresh();
    const { host, shell } = useUpdateState.getState();
    expect(mergeUpdatesState(host, shell).state).toBe("idle");
  });
});
