import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import { type AcpAdapter, acpAdapter } from "./adapters";
import { AcpError } from "./client";
import {
  type AcpHostSession,
  type AcpStartOptions,
  type AcpUpdateMeta,
  forgetAcpVersions,
  probeAcp,
  rememberedAcpVersion,
  resumeMethod,
  startAcp,
  startAdapter,
} from "./host";
import type { AcpSessionNotification } from "./types";

/**
 * 起会话：协商、新开 / 接回、模式、能力探测。对 `@armadra/agent/acp` 的假 ACP
 * Agent（真子进程），`--minimal` 跑降级路径。
 */

const sessions: AcpHostSession[] = [];
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.process.terminate()));
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
  forgetAcpVersions();
});

function fakeLaunch(minimal = false) {
  return {
    program: process.execPath,
    args: [fakeAcpAgentPath(), ...(minimal ? ["--minimal"] : [])],
    cwd: tmpdir(),
  };
}

async function start(
  options: Partial<AcpStartOptions> & { minimal?: boolean } = {},
): Promise<AcpHostSession> {
  const { minimal, ...rest } = options;
  const session = await startAcp({ ...fakeLaunch(minimal), ...rest });
  sessions.push(session);
  return session;
}

async function startError(
  options: Partial<AcpStartOptions> & { minimal?: boolean },
): Promise<AcpError> {
  try {
    await start(options);
  } catch (error) {
    expect(error).toBeInstanceOf(AcpError);
    return error as AcpError;
  }
  throw new Error("expected start to fail");
}

describe("resumeMethod", () => {
  it("takes the table's preference, falls back to the other, and never resumes a 'none' adapter", () => {
    const both = { load: true, resume: true };
    expect(resumeMethod("load", both)).toBe("load");
    expect(resumeMethod("resume", both)).toBe("resume");
    expect(resumeMethod("resume", { load: true, resume: false })).toBe("load");
    expect(resumeMethod("load", { load: false, resume: true })).toBe("resume");
    expect(resumeMethod("load", { load: false, resume: false })).toBe("none");
    // Copilot：同一进程内的 load 不算跨进程接回。
    expect(resumeMethod("none", both)).toBe("none");
  });
});

describe("startAcp", () => {
  it("negotiates, opens a new session and reports what the agent can do", async () => {
    const session = await start({ agentId: "opencode" });
    expect(session.opened).toBe("new");
    expect(session.resumed).toBe(false);
    expect(session.sessionId).toMatch(/^fake-/);
    expect(session.capabilities).toMatchObject({
      protocolVersion: 1,
      agent: { name: "fake-acp-agent", version: "1.0.0" },
      load: true,
      resume: true,
      list: true,
      close: true,
      images: false,
      authMethods: [],
    });
    expect(session.modes?.currentModeId).toBe("default");
    expect(rememberedAcpVersion("opencode")).toBe("1.0.0");
    const result = await session.process.prompt(session.sessionId, [
      { type: "text", text: "hi" },
    ]);
    expect(result.stopReason).toBe("end_turn");
  });

  it("resumes with session/resume when the table prefers it: no replay", async () => {
    const seen: [AcpSessionNotification, AcpUpdateMeta][] = [];
    const session = await start({
      resume: { sessionId: "fake-41", method: "resume" },
      onUpdate: (n, meta) => seen.push([n, meta]),
    });
    expect(session).toMatchObject({
      sessionId: "fake-41",
      opened: "resume",
      resumed: true,
    });
    expect(session.resumeError).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("loads with session/load and marks the replayed history, then live updates are not replay", async () => {
    const seen: [AcpSessionNotification, AcpUpdateMeta][] = [];
    const session = await start({
      resume: { sessionId: "fake-7", method: "load" },
      onUpdate: (n, meta) => seen.push([n, meta]),
    });
    expect(session).toMatchObject({ opened: "load", resumed: true });
    expect(seen.map(([n, m]) => [n.update.sessionUpdate, m.replay])).toEqual([
      ["user_message_chunk", true],
      ["agent_message_chunk", true],
    ]);
    await session.process.prompt(session.sessionId, [
      { type: "text", text: "now" },
    ]);
    const live = seen.slice(2);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every(([, m]) => !m.replay)).toBe(true);
  });

  it("opens a new session and says so when the agent refuses the old one", async () => {
    const session = await start({
      resume: { sessionId: "not-a-fake-id", method: "load" },
    });
    expect(session.opened).toBe("new");
    expect(session.resumed).toBe(false);
    expect(session.resumeError?.code).toBe("acp_resume_failed");
  });

  it("never resumes an adapter whose table says none, even if the agent declares load", async () => {
    const session = await start({
      resume: { sessionId: "fake-3", method: "none" },
    });
    expect(session.opened).toBe("new");
    expect(session.resumed).toBe(false);
    expect(session.resumeError?.code).toBe("acp_resume_unsupported");
  });

  it("applies a permission mode with session/set_mode", async () => {
    const updates: string[] = [];
    const session = await start({
      modeId: "plan",
      requireMode: true,
      onUpdate: (n) => updates.push(n.update.sessionUpdate),
    });
    expect(session.modeApplied).toBe(true);
    expect(session.modes?.currentModeId).toBe("plan");
    expect(updates).toContain("current_mode_update");
  });

  it("does not report a mode the agent does not offer as applied", async () => {
    const session = await start({ modeId: "acceptEdits" });
    expect(session.modeApplied).toBe(false);
    expect(session.modes?.currentModeId).toBe("default");
  });

  it("refuses a read-only start whose mode the agent does not offer, and leaves no process behind", async () => {
    const exits: unknown[] = [];
    const error = await startError({
      modeId: "read-only",
      requireMode: true,
      onExit: (exit) => exits.push(exit),
    });
    expect(error.code).toBe("acp_mode_unavailable");
    expect(exits).toHaveLength(1);
  });

  describe("--minimal (an agent that declares nothing)", () => {
    it("falls back to a new session when asked to resume", async () => {
      const session = await start({
        minimal: true,
        resume: { sessionId: "fake-1", method: "load" },
      });
      expect(session.capabilities).toMatchObject({
        load: false,
        resume: false,
        list: false,
        close: false,
      });
      expect(session.opened).toBe("new");
      expect(session.resumed).toBe(false);
      expect(session.resumeError?.code).toBe("acp_resume_unsupported");
      expect(session.modes).toBeNull();
    });

    it("starts without a mode table unless the mode is required", async () => {
      const session = await start({ minimal: true, modeId: "default" });
      expect(session.modeApplied).toBe(false);
      const error = await startError({
        minimal: true,
        modeId: "plan",
        requireMode: true,
      });
      expect(error.code).toBe("acp_mode_unavailable");
    });
  });

  it("answers acp_exited when the program is not an ACP agent", async () => {
    const error = await startError({
      program: process.execPath,
      args: ["-e", "process.exit(3)"],
    });
    expect(error.code).toBe("acp_exited");
    expect(error.message).toContain("code 3");
  });

  it("answers acp_initialize_timeout when the agent never answers", async () => {
    const error = await startError({
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      initializeTimeoutMs: 200,
    });
    expect(error.code).toBe("acp_initialize_timeout");
  });
});

describe("probeAcp", () => {
  it("initializes, reports capabilities and leaves no process", async () => {
    const capabilities = await probeAcp({
      ...fakeLaunch(),
      agentId: "omp",
    });
    expect(capabilities.load).toBe(true);
    expect(rememberedAcpVersion("omp")).toBe("1.0.0");
  });
});

describe.skipIf(process.platform === "win32")("startAdapter", () => {
  /** 一个在 PATH 上、名字是适配器程序名的假 Agent。 */
  function onPath(program: string): NodeJS.ProcessEnv {
    const bin = mkdtempSync(join(tmpdir(), "armadra-acp-bin-"));
    cleanup.push(bin);
    const script = join(bin, program);
    writeFileSync(
      script,
      `#!/bin/sh\nexec "${process.execPath}" "${fakeAcpAgentPath()}" "$@"\n`,
      "utf8",
    );
    chmodSync(script, 0o755);
    return { ...process.env, PATH: bin, HOME: bin };
  }

  const adapter: AcpAdapter = {
    ...(acpAdapter("opencode") as AcpAdapter),
    program: "armadra-fake-acp",
    // 假 Agent 不认 `acp` 子命令也不在乎：多余的 argv 它不看。
  };

  it("finds the program on the augmented PATH and maps the permission mode", async () => {
    const session = await startAdapter(adapter, {
      cwd: tmpdir(),
      env: onPath("armadra-fake-acp"),
      mode: "plan",
    });
    sessions.push(session);
    expect(session.modeApplied).toBe(true);
    expect(session.modes?.currentModeId).toBe("plan");
    expect(rememberedAcpVersion("opencode")).toBe("1.0.0");
  });

  it("refuses a permission mode the adapter has no mapping for", async () => {
    await expect(
      startAdapter(adapter, {
        cwd: tmpdir(),
        env: onPath("armadra-fake-acp"),
        mode: "full-auto",
      }),
    ).rejects.toMatchObject({ code: "acp_mode_unsupported" });
  });

  it("answers acp_not_installed when the program is not on PATH", async () => {
    const empty = mkdtempSync(join(tmpdir(), "armadra-acp-empty-"));
    cleanup.push(empty);
    await expect(
      startAdapter(
        { ...adapter, program: "armadra-no-such-acp-agent" },
        { cwd: tmpdir(), env: { PATH: empty, HOME: empty } },
      ),
    ).rejects.toMatchObject({ code: "acp_not_installed" });
  });

  it("resumes by the adapter's preferred method", async () => {
    const session = await startAdapter(adapter, {
      cwd: tmpdir(),
      env: onPath("armadra-fake-acp"),
      resumeSessionId: "fake-9",
    });
    sessions.push(session);
    expect(session).toMatchObject({ opened: "load", resumed: true });
  });
});
