import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../testing/temp-dir";
import { CLAUDE_HOOK_EVENTS } from "../events";
import {
  MOD_MODULE_FILE,
  MOD_PLUGIN_NAME,
  claudeModHooks,
  claudeModManifest,
  claudeModSource,
} from "./template";
import { MOD_CLASSIC_EVENTS } from "./status";
import { claudeModPluginTest } from "./plugin-test";

/**
 * The generated Claude Code mod (contract §55): what the engine's loader
 * refuses (a computed `$.env.get` name, `import()`, `$` handed to an arrow
 * function), what our rules forbid (answering a permission prompt, steering a
 * tool call, writing into the conversation), and that it type-checks against
 * the API subset in `tools/vendor/claude-mod-api.d.ts`.
 *
 * With `ARMADRA_CLAUDE_PROBE=1` and a Claude Code at or above the gate
 * (`ARMADRA_CLAUDE_BIN`, else `claude` on PATH) the engine's own
 * `claude plugin validate` reads it too, under a throwaway HOME. Without one
 * that case is skipped, not failed.
 */

const ROOT = resolve(__dirname, "../../../../../../..");
const SHIM = join(ROOT, "tools/vendor/claude-mod-api.d.ts");
const CLIENT = "/opt/Armadra/armadra-hook";

function writeMod(dir: string, clientBin = CLIENT): void {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(claudeModManifest(), null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    `${JSON.stringify(claudeModHooks(), null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "hooks", MOD_MODULE_FILE),
    claudeModSource(clientBin),
  );
}

describe("the Claude Code mod", () => {
  const source = claudeModSource(CLIENT);

  it("is the same bytes for the same client, and names it", () => {
    expect(claudeModSource(CLIENT)).toBe(source);
    expect(source).toContain(`const ARMADRA_CLIENT = "${CLIENT}";`);
    expect(claudeModSource('C:\\Program "x"\\hook')).toContain(
      'const ARMADRA_CLIENT = "C:\\\\Program \\"x\\"\\\\hook";',
    );
    expect(source).not.toContain("${");
  });

  it("is named armadra and loads one module", () => {
    expect(MOD_PLUGIN_NAME).toMatch(/^armadra/);
    expect(MOD_MODULE_FILE).toMatch(/^armadra/);
    expect(claudeModManifest().name).toBe(MOD_PLUGIN_NAME);
    expect(claudeModHooks()).toEqual({ modules: ["./armadra.ts"] });
  });

  it("reads only literal, armadra-named variables and imports nothing at run time", () => {
    const calls = [...source.matchAll(/\$\.env\.get\(([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const argument of calls) {
      expect(argument).toMatch(/^"ARMADRA_[A-Z_]+"$/);
    }
    expect(new Set(calls)).toEqual(
      new Set(
        [
          "ARMADRA_NODE_ID",
          "ARMADRA_ENDPOINT_FILE",
          "ARMADRA_SESSION_ID",
          "ARMADRA_SESSION_GENERATION",
          "ARMADRA_NODE_NAME",
          "ARMADRA_MOD_PROFILE",
        ].map((name) => `"${name}"`),
      ),
    );
    expect(source).not.toMatch(/\bimport\s*\(/);
    const imports = source.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      'import type { EngineInterface, Register, SessionStartInput } from "claude-code";',
    ]);
    expect(source).not.toMatch(/\$\.env\.set\b/);
  });

  it("never answers for a person, never steers a tool, never writes into the conversation", () => {
    for (const forbidden of [
      "classic.PermissionRequest",
      '"tool.check"',
      '"tool.call"',
      "prompt.submit",
      "prompt.fill",
      "session.append",
      "$.fs.write",
      "$.store",
      "deny",
      "decision",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // Every hook passes its event on, unchanged.
    const hooks = source.match(/on\("[^"]+"/g) ?? [];
    expect(hooks.length).toBe(MOD_CLASSIC_EVENTS.length + 1);
    expect(source.match(/return next\(e\);/g)?.length).toBe(hooks.length);
    expect(
      source.match(/\.catch\(\(\$, e, next\) => next\(e\)\)/g)?.length,
    ).toBe(MOD_CLASSIC_EVENTS.length);
  });

  it("carries every settings hook event but PermissionRequest", () => {
    expect([...MOD_CLASSIC_EVENTS].sort()).toEqual(
      CLAUDE_HOOK_EVENTS.filter(
        (event) => event !== "PermissionRequest",
      ).sort(),
    );
    for (const event of MOD_CLASSIC_EVENTS) {
      expect(source).toContain(`on("classic.${event}",`);
    }
  });

  it("type-checks against the API it uses", () => {
    const dir = tempDir("armadra-claude-mod-tsc-");
    const file = join(dir, MOD_MODULE_FILE);
    writeFileSync(file, source);
    const program = ts.createProgram([file, SHIM], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts"],
      types: [],
      skipLibCheck: true,
      noUnusedLocals: true,
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    expect(diagnostics).toEqual([]);
  });

  /**
   * The module itself, run in this process against a `$` that answers from
   * memory: transpiled, imported, its hooks registered and raised by hand.
   */
  async function load(world: {
    env: Record<string, string>;
    files: Record<string, string>;
    fetch?: (url: string, init: Record<string, unknown>) => unknown;
  }) {
    const js = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
    )) as { register: (on: unknown) => void };
    const hooks = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const on = (
      event: string,
      hook: (...args: unknown[]) => Promise<unknown>,
    ) => {
      hooks.set(event, hook);
      return { catch: () => {} };
    };
    module.register(on);
    const fetched: { url: string; init: Record<string, unknown> }[] = [];
    const ran: { argv: string[]; init: Record<string, unknown> }[] = [];
    const statuses: (string | undefined)[] = [];
    const $ = {
      env: { get: async (name: string) => world.env[name] },
      fs: {
        read: async (path: string) => {
          const text = world.files[path];
          if (text === undefined) throw new Error(`no ${path}`);
          return text;
        },
      },
      http: {
        fetch: async (url: string, init: Record<string, unknown>) => {
          fetched.push({ url, init });
          await world.fetch?.(url, init);
          return { status: 204, ok: true, headers: {}, text: "" };
        },
      },
      process: {
        run: async (argv: string[], init: Record<string, unknown>) => {
          ran.push({ argv, init });
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      clock: {
        sleep: (ms: number) => new Promise((done) => setTimeout(done, ms)),
      },
      session: {
        version: async () => ({ version: "2.1.293", base: "2.1.293" }),
      },
      ui: { status: (text: string | undefined) => statuses.push(text) },
    };
    const raise = async (event: string, e: unknown) => {
      const passed: unknown[] = [];
      const hook = hooks.get(event);
      if (hook === undefined) throw new Error(`no hook on ${event}`);
      await hook($, e, async (value: unknown) => {
        passed.push(value);
        return {};
      });
      await new Promise((done) => setTimeout(done, 20));
      return passed;
    };
    return { hooks, raise, fetched, ran, statuses };
  }

  const WORLD = {
    env: {
      ARMADRA_NODE_ID: "node-1",
      ARMADRA_ENDPOINT_FILE: "/data/hook-endpoint.env",
      ARMADRA_SESSION_ID: "session-1",
      ARMADRA_SESSION_GENERATION: "2",
      ARMADRA_NODE_NAME: "reviewer",
    },
    files: {
      "/data/hook-endpoint.env":
        "ARMADRA_HOOK_PORT='4100'\nARMADRA_HOOK_SOCK='/data/hook.sock'\nARMADRA_HOOK_TOKEN='it'\\''s'\nARMADRA_NODE_TOKEN_DIR='/data/node-tokens'\n",
      "/data/node-tokens/node-1": "kid.mac\n",
    },
  };

  it("forwards each event unchanged and at once, PreToolUse rebuilt", async () => {
    const mod = await load(WORLD);
    const start = {
      hook_event_name: "SessionStart",
      session_id: "claude-1",
      transcript_path: "/t.jsonl",
      cwd: "/work",
      source: "startup",
    };
    expect(await mod.raise("classic.SessionStart", start)).toEqual([start]);
    const envelope = {
      tool: "Bash",
      tool_use_id: "toolu_1",
      command: "echo hi",
    };
    expect(await mod.raise("classic.PreToolUse", envelope)).toEqual([envelope]);
    const bodies = mod.fetched.map((call) =>
      JSON.parse(call.init.body as string),
    );
    expect(
      mod.fetched.every((call) => call.url === "http://armadra/hook/claude"),
    ).toBe(true);
    expect(mod.fetched[0]?.init.socketPath).toBe("/data/hook.sock");
    expect(mod.fetched[0]?.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Armadra-Hook-Client": "5",
      "X-Armadra-Hook-Token": "it's",
      "X-Armadra-Node-Token": "kid.mac",
    });
    expect(bodies[0]).toEqual({
      nodeId: "node-1",
      version: 1,
      payload: start,
      terminalBinding: { sessionId: "session-1", generation: 2 },
    });
    expect(bodies[1]?.payload).toEqual({
      session_id: "claude-1",
      transcript_path: "/t.jsonl",
      cwd: "/work",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_use_id: "toolu_1",
    });
    expect(mod.ran).toEqual([]);
  });

  it("takes the port when the socket fails, and the client when both do", async () => {
    let refuse = (url: string) => url.startsWith("http://armadra");
    const mod = await load({
      ...WORLD,
      fetch: (url) => {
        if (refuse(url)) throw new Error("refused");
      },
    });
    await mod.raise("classic.Stop", { hook_event_name: "Stop" });
    expect(mod.fetched.map((call) => call.url)).toEqual([
      "http://armadra/hook/claude",
      "http://127.0.0.1:4100/hook/claude",
    ]);
    refuse = () => true;
    await mod.raise("classic.Stop", { hook_event_name: "Stop", n: 2 });
    expect(mod.ran).toEqual([
      {
        argv: [CLIENT, "claude"],
        init: {
          stdin: JSON.stringify({ hook_event_name: "Stop", n: 2 }),
          timeoutMs: 5000,
        },
      },
    ]);
  });

  it("says hello with versions only, and again through the client once its reports go there", async () => {
    let refuse = false;
    const mod = await load({
      ...WORLD,
      fetch: () => {
        if (refuse) throw new Error("refused");
      },
    });
    await mod.raise("session.start", {
      cwd: "/work",
      surface: "terminal",
      isInteractive: true,
    });
    const hello = mod.fetched.find((call) => call.url.endsWith("/node/mod"));
    expect(JSON.parse(hello?.init.body as string)).toEqual({
      engine: "claude",
      version: "2.1.293",
      base: "2.1.293",
      surface: "terminal",
      isInteractive: true,
      profile: "terminal",
      modRevision: 1,
      nodeId: "node-1",
      transport: "socket",
    });
    expect(mod.statuses).toEqual(["reviewer"]);
    refuse = true;
    await mod.raise("classic.Stop", { hook_event_name: "Stop" });
    expect(mod.ran.map((call) => call.argv[1])).toEqual([
      "claude",
      "mod-hello",
    ]);
    expect(JSON.parse(mod.ran[1]?.init.stdin as string)).toMatchObject({
      transport: "process",
    });
  });

  it("does nothing outside a canvas node, and nothing under ACP but pass events on", async () => {
    const outside = await load({ env: {}, files: {} });
    expect(
      await outside.raise("classic.Stop", { hook_event_name: "Stop" }),
    ).toHaveLength(1);
    await outside.raise("session.start", {
      cwd: "/",
      surface: "terminal",
      isInteractive: true,
    });
    expect(outside.fetched).toEqual([]);
    expect(outside.statuses).toEqual([]);
    const acp = await load({
      ...WORLD,
      env: { ...WORLD.env, ARMADRA_MOD_PROFILE: "acp" },
    });
    await acp.raise("classic.Stop", { hook_event_name: "Stop" });
    expect(acp.fetched).toEqual([]);
    // Headless: no status line.
    const headless = await load(WORLD);
    await headless.raise("session.start", {
      cwd: "/",
      surface: null,
      isInteractive: false,
    });
    expect(headless.statuses).toEqual([]);
  });

  const claude = process.env.ARMADRA_CLAUDE_BIN ?? "claude";
  const probe = process.env.ARMADRA_CLAUDE_PROBE === "1";
  it.skipIf(!probe)("passes claude plugin validate", () => {
    const dir = tempDir("armadra-claude-mod-validate-");
    const home = join(dir, "home");
    mkdirSync(home);
    const mod = join(dir, "mod");
    writeMod(mod);
    const ran = spawnSync(claude, ["plugin", "validate", mod], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
      },
      timeout: 60_000,
    });
    const output = `${ran.stdout}${ran.stderr}`;
    expect(ran.status, output).toBe(0);
    expect(output).toContain("Validation passed");
    const hooked =
      /armadra\.ts hooks: (.+)$/m.exec(output)?.[1]?.split(", ") ?? [];
    expect(new Set(hooked)).toEqual(
      new Set([
        "session.start",
        ...MOD_CLASSIC_EVENTS.map((event) => `classic.${event}`),
      ]),
    );
    expect(output).not.toMatch(/gating hook without \.catch/);
    const reads =
      /armadra\.ts env reads: (.+)$/m.exec(output)?.[1]?.split(", ") ?? [];
    for (const name of reads) expect(name).toMatch(/^ARMADRA_/);
  });

  it.skipIf(!probe)("passes its own claude plugin test", () => {
    // ARMADRA_CLAUDE_MOD_KEEP keeps the folder for a rerun by hand.
    const dir =
      process.env.ARMADRA_CLAUDE_MOD_KEEP ??
      tempDir("armadra-claude-mod-plugin-test-");
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const mod = join(dir, "mod");
    writeMod(mod);
    writeFileSync(
      join(mod, "hooks", "armadra.test.ts"),
      claudeModPluginTest(CLIENT),
    );
    const ran = spawnSync(claude, ["plugin", "test", mod], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
      },
      timeout: 120_000,
    });
    const output = `${ran.stdout}${ran.stderr}`;
    expect(ran.status, output).toBe(0);
    expect(output).not.toContain("(fail)");
    expect(output).toMatch(/\b[1-9]\d* pass\b/);
  });
});
