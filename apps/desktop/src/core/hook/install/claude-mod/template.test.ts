import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../testing/temp-dir";
import { CLAUDE_HOOK_EVENTS, MOD_REVISION } from "../events";
import {
  MOD_MODULE_FILE,
  MOD_PLUGIN_NAME,
  MOD_TYPES_FILE,
  claudeModHooks,
  claudeModManifest,
  claudeModSource,
  claudeModTypes,
} from "./template";
import { MOD_CLASSIC_EVENTS } from "./status";
import { MOD_COMMANDS } from "./commands";
import { claudeModPluginTest } from "./plugin-test";

/**
 * The generated Claude Code mod (contract §57): what the engine's loader
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
  writeFileSync(join(dir, MOD_TYPES_FILE), claudeModTypes());
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
    expect(claudeModManifest().types).toBe("./hooks/armadra-state.d.ts");
    // The contract declares the mod's own state, and nothing else.
    expect(claudeModTypes()).toContain('"armadra-mod": {');
    expect(claudeModTypes()).not.toMatch(/^import /m);
    const keys = [
      ...source.matchAll(/\{ plugin: "([^"]+)", key: "([^"]+)" \}/g),
    ].map((match) => `${match[1]}.${match[2]}`);
    expect(keys.sort()).toEqual(["armadra-mod.overlay", "armadra-mod.seen"]);
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
      'import type { CommandRunResult, EngineInterface, Register, RenderElement, SessionStartInput } from "claude-code";',
      'import type { ArmadraModLink, ArmadraModOverlay } from "./armadra-state";',
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
    // Every hook passes its event on, unchanged; the band's draws or hands
    // the band on (twice), and nothing else; a slash command's answers for
    // itself (commands.test.ts).
    const hooks = (source.match(/on\("[^"]+"/g) ?? []).filter(
      (hook) => hook !== 'on("command.run"',
    );
    expect(hooks.length).toBe(MOD_CLASSIC_EVENTS.length + 2);
    expect(source.match(/return next\(e\);/g)?.length).toBe(hooks.length + 1);
    expect(
      source.match(/\.catch\(\(\$, e, next\) => next\(e\)\)/g)?.length,
    ).toBe(MOD_CLASSIC_EVENTS.length + 1);
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
    writeMod(dir);
    const file = join(dir, "hooks", MOD_MODULE_FILE);
    const program = ts.createProgram([file, join(dir, MOD_TYPES_FILE), SHIM], {
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
    /** What a GET answers; 204 with no body when absent. */
    get?: (
      url: string,
      init: Record<string, unknown>,
    ) => { status: number; text: string } | undefined;
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
    type Hook = (...args: unknown[]) => Promise<unknown>;
    const hooks = new Map<string, Hook[]>();
    const on = (event: string, ...rest: unknown[]) => {
      const hook = rest[rest.length - 1] as Hook;
      const matcher = rest.length > 1 ? (rest[0] as { command?: string }) : {};
      const key =
        matcher.command === undefined ? event : `${event}:${matcher.command}`;
      hooks.set(key, [...(hooks.get(key) ?? []), hook]);
      return { catch: () => {} };
    };
    // The JSX factory is a global of the module's environment.
    (globalThis as Record<string, unknown>).h = (
      tag: unknown,
      props: unknown,
      ...children: unknown[]
    ) => ({ tag, props, children });
    module.register(on);
    const fetched: { url: string; init: Record<string, unknown> }[] = [];
    const ran: { argv: string[]; init: Record<string, unknown> }[] = [];
    const statuses: (string | undefined)[] = [];
    const toasts: string[] = [];
    const timers: (() => void)[] = [];
    const state = new Map<string, { value: unknown; version: number }>();
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
          const got =
            init.method === "GET" ? world.get?.(url, init) : undefined;
          if (got !== undefined) {
            return { ...got, ok: got.status < 300, headers: {} };
          }
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
        every: (_ms: number, fn: () => void) => {
          timers.push(fn);
          return { cancel: () => timers.splice(timers.indexOf(fn), 1) };
        },
      },
      state: {
        get: async (ref: { plugin: string; key: string }) =>
          state.get(`${ref.plugin}.${ref.key}`) ?? {
            value: undefined,
            version: 0,
          },
        set: async (ref: { plugin: string; key: string }, value: unknown) => {
          const key = `${ref.plugin}.${ref.key}`;
          const version = (state.get(key)?.version ?? 0) + 1;
          state.set(key, { value, version });
          return { isSet: true, version };
        },
      },
      session: {
        version: async () => ({ version: "2.1.293", base: "2.1.293" }),
      },
      ui: {
        status: (text: string | undefined) => statuses.push(text),
        toast: (text: string) => toasts.push(text),
        resolve: () => ({ Text: "Text", Box: "Box" }),
      },
    };
    const raise = async (event: string, e: unknown) => {
      const passed: unknown[] = [];
      const chain = hooks.get(event);
      if (chain === undefined) throw new Error(`no hook on ${event}`);
      for (const hook of chain) {
        await hook($, e, async (value: unknown) => {
          passed.push(value);
          return {};
        });
      }
      await new Promise((done) => setTimeout(done, 20));
      return passed;
    };
    // The band as the engine asks for it: what the hook drew, or "next".
    const band = async (props: Record<string, unknown>) => {
      const hook = hooks.get("ui.render")?.[0];
      if (hook === undefined) throw new Error("no band");
      return hook(
        $,
        {
          surface: "terminal",
          component: "AbovePrompt",
          requestId: "band",
          props: {
            hasSurvey: false,
            isWorking: false,
            maxRows: 10,
            bodyColumns: 80,
            ...props,
          },
        },
        async () => "next",
      );
    };
    const tick = async () => {
      for (const timer of [...timers]) timer();
      await new Promise((done) => setTimeout(done, 20));
    };
    return { hooks, raise, fetched, ran, statuses, toasts, timers, band, tick };
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
      modRevision: MOD_REVISION,
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

  function overlay(extra: Record<string, unknown> = {}) {
    return {
      revision: 7,
      node: { id: "node-1", name: "reviewer", role: "sub", agentId: "claude" },
      board: { id: "b1", title: "Release" },
      links: {
        main: [{ id: "n-lead", name: "lead" }],
        subs: [],
        peers: [
          { id: "n-t", name: "tester" },
          { id: "n-x", name: "" },
        ],
      },
      inbox: { pending: 2, latestSequence: 40, latestFrom: "lead" },
      outbox: { queued: 0 },
      approvals: { pending: 0 },
      ...extra,
    };
  }

  it("draws the band from the overlay: names, counts and glyphs only", async () => {
    let answer = overlay();
    const mod = await load({
      ...WORLD,
      get: (url, init) => {
        expect(url).toBe("http://armadra/node/overlay?nodeId=node-1");
        const headers = init.headers as Record<string, string>;
        expect(headers["X-Armadra-Node-Token"]).toBe("kid.mac");
        expect(headers["Content-Type"]).toBeUndefined();
        if (headers["If-None-Match"] === `"${answer.revision}"`) {
          return { status: 304, text: "" };
        }
        return { status: 200, text: JSON.stringify(answer) };
      },
    });
    expect(await mod.band({})).toBe("next");
    await mod.raise("session.start", {
      cwd: "/work",
      surface: "terminal",
      isInteractive: true,
    });
    expect(mod.timers).toHaveLength(1);
    expect(await mod.band({})).toEqual({
      tag: "Text",
      props: { dimColor: true, wrap: "truncate" },
      children: ["↑ lead   ↔ tester, +1   ✉ 2"],
    });
    // Narrow: the peers are left out. A survey holds the band.
    expect(
      ((await mod.band({ bodyColumns: 30 })) as { children: string[] })
        .children,
    ).toEqual(["↑ lead   ✉ 2"]);
    expect(await mod.band({ hasSurvey: true })).toBe("next");
    // The status line gains the board's name.
    expect(mod.statuses.at(-1)).toBe("reviewer · Release");
    // What was waiting at the start is the band's, not a toast.
    expect(mod.toasts).toEqual([]);
    // Nothing moved: 304, nothing redrawn, no toast.
    await mod.tick();
    expect(mod.toasts).toEqual([]);
    // A newer message: one toast, the sender's name only.
    answer = overlay({
      revision: 8,
      inbox: { pending: 3, latestSequence: 41, latestFrom: "tester" },
    });
    await mod.tick();
    await mod.tick();
    expect(mod.toasts).toEqual(["✉ tester"]);
    // Nothing linked, nothing unread: no band.
    answer = overlay({
      revision: 9,
      links: { main: [], subs: [], peers: [] },
      inbox: { pending: 0, latestSequence: 0, latestFrom: "" },
    });
    await mod.tick();
    expect(await mod.band({})).toBe("next");
  });

  it("asks for no overlay under -p or ACP", async () => {
    const headless = await load({ ...WORLD, get: () => undefined });
    await headless.raise("session.start", {
      cwd: "/",
      surface: null,
      isInteractive: false,
    });
    const acp = await load({
      ...WORLD,
      env: { ...WORLD.env, ARMADRA_MOD_PROFILE: "acp" },
      get: () => undefined,
    });
    await acp.raise("session.start", {
      cwd: "/",
      surface: "terminal",
      isInteractive: true,
    });
    for (const mod of [headless, acp]) {
      expect(mod.timers).toEqual([]);
      expect(mod.fetched.some((call) => call.url.includes("overlay"))).toBe(
        false,
      );
    }
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
        ...MOD_COMMANDS.map(
          (command) => `command.run{command=${command.name}}`,
        ),
        "ui.render{component=AbovePrompt}",
      ]),
    );
    // A slash command is answered by its own hook, not a gate.
    for (const command of MOD_COMMANDS) {
      expect(output).toContain(
        `answers its own command: command.run{command=${command.name}}`,
      );
    }
    expect(output).not.toMatch(/gating hook without \.catch/);
    // Every $.state key the module names is the contract's.
    expect(output).not.toMatch(/not declared|undeclared/i);
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
