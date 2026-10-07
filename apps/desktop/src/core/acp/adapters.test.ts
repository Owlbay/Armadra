import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PERMISSION_MODES, launchProfile } from "../agent/launch";
import { AGENT_IDS } from "../agent/registry";
import { tempDir } from "../testing/temp-dir";
import {
  ACP_ADAPTERS,
  type AcpAdapter,
  acpAdapter,
  acpLaunchPlan,
  acpPermissionModes,
  acpResumeId,
  cliResumeId,
  mappedSession,
  readSessionMap,
} from "./adapters";

/**
 * 适配器表（ACP 会话视图设计 §5.2）。表本身是数据，这里守的是它与别处的
 * 一致：模式集合与 `permissionFlag` 相同、一家一行、程序名与发布兼容表对齐。
 */

describe("ACP_ADAPTERS", () => {
  it("has one row per built-in agent plus ama, and nothing else", () => {
    const ids = ACP_ADAPTERS.map((adapter) => adapter.agentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...new Set([...AGENT_IDS, "ama"])].sort());
  });

  it("covers exactly the permission modes permissionFlag covers", () => {
    for (const adapter of ACP_ADAPTERS) {
      const modes = Object.keys(adapter.modes).sort();
      expect(modes, adapter.agentId).toEqual([...PERMISSION_MODES].sort());
      // ama 的终端启动配置由 G1-7 补进 core；补上之后同一条也守着它。
      const profile = launchProfile(adapter.agentId);
      if (profile !== undefined) {
        expect(modes, adapter.agentId).toEqual(
          Object.keys(profile.permissionFlag).sort(),
        );
      }
    }
  });

  it("always offers default, and only modes that land somewhere", () => {
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.modes.default, adapter.agentId).not.toBeNull();
      for (const mode of acpPermissionModes(adapter)) {
        const mapping = adapter.modes[mode];
        expect(mapping, `${adapter.agentId} ${mode}`).not.toBeNull();
        if (mode !== "default") {
          expect(
            mapping?.modeId !== undefined || (mapping?.args?.length ?? 0) > 0,
            `${adapter.agentId} ${mode}`,
          ).toBe(true);
        }
      }
    }
    expect(acpPermissionModes(acpAdapter("opencode")!)).toEqual([
      "default",
      "plan",
    ]);
    expect(acpPermissionModes(acpAdapter("pi")!)).toEqual(["default"]);
  });

  it("follows the design's resume and session-id rules", () => {
    const rule = (id: string) => {
      const adapter = acpAdapter(id)!;
      return [adapter.support, adapter.sessionId, adapter.resume];
    };
    expect(rule("claude")).toEqual(["official", "same", "load"]);
    expect(rule("codex")).toEqual(["official", "same", "load"]);
    expect(rule("opencode")).toEqual(["native", "same", "load"]);
    expect(rule("pi")).toEqual(["community", "mapFile", "load"]);
    expect(rule("omp")).toEqual(["native", "same", "load"]);
    // Copilot 跨进程不可接回，所以永不休眠。
    expect(rule("copilot")).toEqual(["native", "opaque", "none"]);
    expect(rule("ama")).toEqual(["native", "same", "resume"]);
    // ama 的画布工具走 profile 的 host 适配器，pi-acp 不接通 MCP：两家都不带，
    // 其余五家都带（契约 §48）。
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.injection.mcp, adapter.agentId).toBe(
        adapter.agentId !== "ama" && adapter.agentId !== "pi",
      );
    }
  });

  it("canvasTools: mcp exactly when MCP is injected; ama runners, pi none", () => {
    for (const adapter of ACP_ADAPTERS) {
      expect(adapter.canvasTools === "mcp", adapter.agentId).toBe(
        adapter.injection.mcp,
      );
    }
    expect(acpAdapter("ama")?.canvasTools).toBe("runners");
    expect(acpAdapter("pi")?.canvasTools).toBe("none");
  });

  it("names the same programs as the release compatibility table", () => {
    const file = join(
      __dirname,
      "../../../../../tools/release/compatibility.json",
    );
    const acp = JSON.parse(readFileSync(file, "utf8")).acp as {
      protocolVersion: number;
      adapters: Record<string, { program: string }>;
    };
    expect(acp.protocolVersion).toBe(1);
    expect(
      Object.fromEntries(
        Object.entries(acp.adapters).map(([id, entry]) => [id, entry.program]),
      ),
    ).toEqual(
      Object.fromEntries(ACP_ADAPTERS.map((a) => [a.agentId, a.program])),
    );
  });
});

describe("acpLaunchPlan", () => {
  it("puts a mode id on set_mode and nothing on the argv", () => {
    expect(acpLaunchPlan(acpAdapter("claude")!, { mode: "auto-edit" })).toEqual(
      { args: [], modeId: "acceptEdits" },
    );
    expect(acpLaunchPlan(acpAdapter("codex")!)).toEqual({
      args: [],
      modeId: "workspace-write",
    });
  });

  it("puts a flag mode on the argv after the fixed words", () => {
    expect(acpLaunchPlan(acpAdapter("omp")!, { mode: "full-auto" })).toEqual({
      args: ["acp", "--approval-mode", "yolo"],
    });
    expect(acpLaunchPlan(acpAdapter("copilot")!, { mode: "plan" })).toEqual({
      args: ["--acp", "--stdio", "--plan"],
    });
  });

  it("refuses a mode with no mapping instead of starting writable", () => {
    expect(
      acpLaunchPlan(acpAdapter("opencode")!, { mode: "full-auto" }),
    ).toEqual(expect.objectContaining({ code: "acp_mode_unsupported" }));
  });

  it("adds ama's profile and reuses only the injection the adapter can take", () => {
    expect(
      acpLaunchPlan(acpAdapter("ama")!, {
        mode: "plan",
        profilePath: "/data/ama/profile.json",
        injectionArgs: ["--ignored"],
      }),
    ).toEqual({
      args: ["--mode", "acp", "--profile", "/data/ama/profile.json"],
      modeId: "plan",
    });
    expect(
      acpLaunchPlan(acpAdapter("pi")!, {
        injectionArgs: ["--extension", "/x/armadra.ts"],
      }),
    ).toEqual({ args: ["--", "--extension", "/x/armadra.ts"] });
    expect(
      acpLaunchPlan(acpAdapter("opencode")!, { injectionArgs: ["--nope"] }),
    ).toEqual({ args: ["acp"], modeId: "build" });
  });
});

describe("pi-acp's session map (§26.3)", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });
  const pi = acpAdapter("pi") as AcpAdapter;
  const UUID = "0198a3c4-1f2e-7a6b-8c9d-0e1f2a3b4c5d";

  function home(content?: string): NodeJS.ProcessEnv {
    const directory = tempDir("armadra-acp-home-");
    homes.push(directory);
    if (content !== undefined) {
      mkdirSync(join(directory, ".pi", "acp"), { recursive: true });
      writeFileSync(join(directory, ".pi", "acp", "sessions.json"), content);
    }
    return { HOME: directory, USERPROFILE: directory };
  }

  it("is pi's only, at ~/.pi/acp/sessions.json", () => {
    expect(pi.sessionId).toBe("mapFile");
    expect(pi.sessionMap).toEqual([".pi", "acp", "sessions.json"]);
    for (const adapter of ACP_ADAPTERS) {
      if (adapter.agentId === "pi") continue;
      expect(adapter.sessionMap, adapter.agentId).toBeUndefined();
      expect(readSessionMap(adapter, home("{}"))).toBeUndefined();
    }
  });

  it("maps an ACP session id to pi's session file and back", () => {
    const file = `/sessions/--work--/2026-10-04T08-00-00-000Z_${UUID}.jsonl`;
    const env = home(
      JSON.stringify({
        "acp-1": { sessionFile: file },
        "acp-2": "/sessions/--work--/no-uuid-here.jsonl",
        "acp-3": { sessionFile: "relative/path.jsonl" },
        "acp-4": { other: true },
      }),
    );
    expect(mappedSession(pi, "acp-1", env)).toEqual({
      acpSessionId: "acp-1",
      sessionFile: file,
      cliSessionId: UUID,
    });
    // 文件名里认不出 id：接回用文件路径。
    expect(cliResumeId(pi, "acp-2", env)).toBe(
      "/sessions/--work--/no-uuid-here.jsonl",
    );
    // 相对路径与别的形状不认。
    expect(mappedSession(pi, "acp-3", env)).toBeUndefined();
    expect(mappedSession(pi, "acp-4", env)).toBeUndefined();
    // 切回终端：ACP 会话 id → pi 的会话 id；手里本来就是 pi 的也照用。
    expect(cliResumeId(pi, "acp-1", env)).toBe(UUID);
    expect(cliResumeId(pi, UUID, env)).toBe(UUID);
    expect(cliResumeId(pi, "acp-9", env)).toBeUndefined();
    // 接回 ACP：pi 的会话 id（或文件）反查成 ACP 会话 id。
    expect(acpResumeId(pi, UUID, env)).toBe("acp-1");
    expect(acpResumeId(pi, file, env)).toBe("acp-1");
    expect(acpResumeId(pi, "acp-1", env)).toBe("acp-1");
    expect(acpResumeId(pi, "unknown", env)).toBe("unknown");
  });

  it("falls back to opaque when the map is missing or not a map", () => {
    for (const env of [home(), home("not json"), home("[1,2]")]) {
      expect(readSessionMap(pi, env)).toBeUndefined();
      expect(mappedSession(pi, "acp-1", env)).toBeUndefined();
      expect(acpResumeId(pi, "acp-1", env)).toBe("acp-1");
      expect(cliResumeId(pi, "acp-1", env)).toBeUndefined();
    }
    // 别的适配器原样。
    const claude = acpAdapter("claude") as AcpAdapter;
    expect(cliResumeId(claude, "abc", home())).toBe("abc");
    expect(acpResumeId(claude, "abc", home())).toBe("abc");
  });
});
