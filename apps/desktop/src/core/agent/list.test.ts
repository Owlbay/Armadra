import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetAcpVersions, probeAcp } from "../acp/host";
import { launcherPath } from "../hook/install/inject";
import { install as installIntegration } from "../hook/install/integration";
import { type AgentListRow, listAgents } from "./list";
import { forgetProbes, rememberProbe } from "./probe";
import { AGENT_IDS, type AgentSettings, type CustomAgent } from "./registry";
import { type AgentFixture, agentFixture } from "./fixture";

/**
 * `GET /api/agents`.
 *
 * The field names are asserted one by one rather than loosely: this list is
 * what the new-node menu, the command palette and every settings page parse
 * through `agentListSchema`, and a key this core spelled differently would
 * empty all four at once with no error anyone could see. The core has no
 * dependency on `@armadra/shared`, so the schema cannot be imported here —
 * the names below are the contract, copied deliberately.
 *
 * Every case that touches an integration passes an explicit `env`. The config
 * home comes from `CLAUDE_CONFIG_DIR` and friends, so a suite that left it
 * alone would read the developer's own `~/.claude` and pass or fail depending
 * on whose machine ran it.
 */

let fixture: AgentFixture;
let home: string;
let hookBin: string;

function isolated(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The installer writes a hook entry naming a real file; the suite supplies
    // a stub rather than the packaged sidecar, which does not exist in a test.
    ARMADRA_HOOK_BIN: hookBin,
    // Windows' launcher is a copy of it; any bytes do. Ignored elsewhere.
    ARMADRA_LAUNCH_EXE: join(home, "armadra-launch.exe"),
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"),
    COPILOT_HOME: join(home, "copilot"),
    XDG_CONFIG_HOME: join(home, "xdg"),
    PI_CODING_AGENT_DIR: join(home, "pi"),
  };
}

beforeEach(() => {
  fixture = agentFixture();
  home = mkdtempSync(join(tmpdir(), "armadra-agents-"));
  hookBin = join(home, "armadra-hook");
  writeFileSync(hookBin, "#!/bin/sh\n", "utf8");
  writeFileSync(join(home, "armadra-launch.exe"), "MZ", "utf8");
});

afterEach(() => {
  fixture.close();
  forgetProbes();
  rmSync(home, { recursive: true, force: true });
});

describe("GET /api/agents", () => {
  it("answers one row per built-in adapter, in a shape the page parses", async () => {
    const answer = await fixture.call("GET", "/api/agents");
    expect(answer.status).toBe(200);
    const rows = answer.body as AgentListRow[];
    expect(rows.map((row) => row.id)).toEqual([...AGENT_IDS]);
    const claude = rows.find((row) => row.id === "claude");
    expect(claude?.label).toBe("Claude Code");
    expect(claude?.promptMode).toBe("argv");
    expect(claude?.capabilities).toContain("contextLink");
  });

  it("lists a custom agent after the built-ins, with its base borrowed", async () => {
    fixture.customAgents.push({
      id: "custom:mine",
      label: "My Claude",
      baseAgent: "claude",
      launchCmd: "/nope/claude-wrapper",
      args: ["--flag"],
    });
    const rows = (await fixture.call("GET", "/api/agents"))
      .body as AgentListRow[];
    const mine = rows.at(-1);
    expect(mine?.id).toBe("custom:mine");
    expect(mine?.baseAgent).toBe("claude");
    expect(mine?.args).toEqual(["--flag"]);
    // The wrapper is not on this box, so the row says so instead of guessing.
    expect(mine?.installed).toBe(false);
    expect(mine?.resolvedPath).toBeNull();
  });
});

describe("listAgents and the integration", () => {
  const settings = (custom: CustomAgent[] = []): AgentSettings => ({
    customAgents: () => custom,
  });

  it("omits both revisions and the launcher while nothing is installed", () => {
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings(),
      env: isolated(),
    });
    const claude = rows.find((row) => row.id === "claude");
    // Absent, not zero: `0` would read as "integrated, by an ancient build".
    expect(claude?.clientRevision).toBeUndefined();
    expect(claude?.skillsRevision).toBeUndefined();
    expect(claude?.launcher).toBeUndefined();
  });

  /** docs/design/canvas-launcher.md §8.1: `launcher`, no injected argv. */
  it("answers Claude's launcher once its integration is written", () => {
    const env = isolated();
    installIntegration("claude", { dataDir: fixture.directory, env });
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings(),
      env,
    });
    const claude = rows.find((row) => row.id === "claude");
    // The path is inside *this* data directory, which is why it is answered
    // per request rather than frozen into a launch definition.
    expect(claude?.launcher).toBe(launcherPath(fixture.directory, "claude"));
    expect(claude?.clientRevision).toBeGreaterThan(0);
    // 注入的 argv 不在行上：由启动器追加，要看的读 /integration 的 launchArgs。
    expect(claude).not.toHaveProperty("launchArgs");
    expect(claude).not.toHaveProperty("launchWords");
    // Codex was not written, so its row is untouched by Claude's.
    expect(rows.find((row) => row.id === "codex")?.launcher).toBeUndefined();
  });

  it("answers history availability on every row, the custom one by its base", () => {
    const env = isolated();
    mkdirSync(join(home, "claude", "projects"), { recursive: true });
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings([
        {
          id: "custom:mine",
          label: "My Claude",
          baseAgent: "claude",
          launchCmd: "/nope/claude-wrapper",
          disabledCapabilities: ["contextLink"],
        },
      ]),
      env,
    });
    for (const row of rows) {
      expect(Object.keys(row.history).sort()).toEqual([
        "cost",
        "index",
        "transcript",
      ]);
    }
    expect(rows.find((row) => row.id === "claude")?.history).toEqual({
      index: "available",
      cost: "available",
      transcript: "available",
    });
    expect(rows.find((row) => row.id === "codex")?.history.index).toBe(
      "not-found",
    );
    expect(rows.find((row) => row.id === "custom:mine")?.history).toEqual({
      index: "available",
      cost: "available",
      transcript: "disabled",
    });
  });

  it("gives a custom entry the integration of the base it borrows", () => {
    const env = isolated();
    installIntegration("claude", { dataDir: fixture.directory, env });
    const rows = listAgents({
      dataDir: fixture.directory,
      settings: settings([
        {
          id: "custom:mine",
          label: "My Claude",
          baseAgent: "claude",
          launchCmd: "/nope/claude-wrapper",
        },
      ]),
      env,
    });
    const mine = rows.find((row) => row.id === "custom:mine");
    expect(mine?.launcher).toBe(
      rows.find((row) => row.id === "claude")?.launcher,
    );
    expect(mine?.clientRevision).toBeGreaterThan(0);
  });
});

/**
 * 探测那一栏（Agent 自动化设计 §1）。
 *
 * 只**读**缓存：探测是后台扫描的事，一次列表绝不等一个子进程。所以这里断言的是
 * 两件事——探到的结果会出现在行里，没探到的行里干脆没有这个键（页面据此把有版
 * 本门槛的能力判成 unknown，而不是判成「支持」）。
 */
describe("listAgents 与版本探测", () => {
  const rowsNow = (): AgentListRow[] =>
    listAgents({
      dataDir: fixture.directory,
      settings: { customAgents: () => [] },
      env: isolated(),
    });

  it("没探过的行没有 probe 这个键", () => {
    forgetProbes();
    expect(rowsNow().every((row) => !Object.hasOwn(row, "probe"))).toBe(true);
  });

  it("探到的结果原样出现在它自己那一行上", () => {
    forgetProbes();
    rememberProbe({
      agentId: "codex",
      launchCmd: "codex",
      version: "0.155.1",
      status: "ok",
      probedAt: new Date().toISOString(),
    });
    const rows = rowsNow();
    expect(rows.find((row) => row.id === "codex")?.probe).toMatchObject({
      version: "0.155.1",
      status: "ok",
      launchCmd: "codex",
    });
    // 别人的行不受影响：版本是那一个程序的事实。
    expect(rows.find((row) => row.id === "claude")?.probe).toBeUndefined();
  });
});

/**
 * `acp` 那一栏（契约 §14.1）：`installed` 每次在补齐过的 PATH 上找适配器程序；
 * `version` 只读最近一次 `initialize` 报的值，列表从不为它起进程。
 */
describe("listAgents 的 acp", () => {
  afterEach(() => forgetAcpVersions());

  /** PATH 上放一个名叫 `name` 的可执行文件；HOME 用临时目录，不碰本机的。 */
  function withProgram(name: string): NodeJS.ProcessEnv {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const file = join(bin, process.platform === "win32" ? `${name}.cmd` : name);
    writeFileSync(file, "#!/bin/sh\n", "utf8");
    chmodSync(file, 0o755);
    return { ...isolated(), PATH: bin };
  }

  const rowsWith = (env: NodeJS.ProcessEnv, custom: CustomAgent[] = []) =>
    listAgents({
      dataDir: fixture.directory,
      settings: { customAgents: () => custom },
      env,
    });

  it("answers the adapter row on every built-in, installed by its program", () => {
    const rows = rowsWith(withProgram("codex-acp"), [
      {
        id: "custom:mine",
        label: "My Codex",
        baseAgent: "codex",
        launchCmd: "/nope/codex-wrapper",
      },
    ]);
    const codex = rows.find((row) => row.id === "codex");
    expect(codex?.acp).toEqual({
      support: "official",
      program: "codex-acp",
      installed: true,
      resume: "load",
    });
    expect(rows.find((row) => row.id === "copilot")?.acp).toMatchObject({
      support: "native",
      program: "copilot",
      resume: "none",
    });
    expect(rows.find((row) => row.id === "pi")?.acp).toMatchObject({
      support: "community",
      program: "pi-acp",
    });
    for (const row of rows) {
      expect(Object.keys(row.acp ?? {}).sort(), row.id).toEqual([
        "installed",
        "program",
        "resume",
        "support",
      ]);
    }
    // custom 借它基础适配器的。
    expect(rows.find((row) => row.id === "custom:mine")?.acp).toEqual(
      codex?.acp,
    );
  });

  it("carries the version the last initialize reported, and only once installed", async () => {
    await probeAcp({
      agentId: "codex",
      program: process.execPath,
      args: [fakeAcpAgentPath()],
      cwd: home,
    });
    const installed = rowsWith(withProgram("codex-acp"));
    expect(installed.find((row) => row.id === "codex")?.acp?.version).toBe(
      "1.0.0",
    );
    expect(
      installed.find((row) => row.id === "claude")?.acp?.version,
    ).toBeUndefined();
    const gone = rowsWith({ ...isolated(), PATH: join(home, "empty") });
    expect(gone.find((row) => row.id === "codex")?.acp).toMatchObject({
      installed: false,
    });
    expect(gone.find((row) => row.id === "codex")?.acp).not.toHaveProperty(
      "version",
    );
  });
});
