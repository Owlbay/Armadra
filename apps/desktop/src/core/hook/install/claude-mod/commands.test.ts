import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { modCommands } from "../../../../../../web/src/i18n/mod-commands";
import { parseFlags } from "../../../../cli/armadra-hook/control";
import { tempDir } from "../../../testing/temp-dir";
import { VERBS } from "../../../collab/control";
import {
  COMMAND_MESSAGES,
  COMMAND_REGISTRATIONS,
  MOD_COMMANDS,
  commandDeclarations,
} from "./commands";
import { claudeModSource } from "./template";

/**
 * The `/armadra-*` slash commands (contract §59): the table, its words in
 * both languages, and the module's commands run in this process against a
 * `$` that answers from memory — the person's words split as a shell would
 * have, handed to the same `armadra-hook canvas` the model runs.
 */

const CLIENT = "/opt/Armadra/armadra-hook";

async function load(
  source: string,
  world: {
    env: Record<string, string>;
    run?: (argv: string[]) => {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
  },
) {
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
  const starts: Hook[] = [];
  const commands = new Map<string, Hook>();
  const on = (event: string, ...rest: unknown[]) => {
    const hook = rest[rest.length - 1] as Hook;
    if (event === "session.start") starts.push(hook);
    if (event === "command.run") {
      commands.set((rest[0] as { command: string }).command, hook);
    }
    return { catch: () => {} };
  };
  module.register(on);
  const registered: Record<string, unknown>[] = [];
  const ran: { argv: string[]; init: Record<string, unknown> }[] = [];
  const $ = {
    env: { get: async (name: string) => world.env[name] },
    fs: {
      read: async () => {
        throw new Error("no file");
      },
    },
    http: {
      fetch: async () => ({ status: 204, ok: true, headers: {}, text: "" }),
    },
    process: {
      run: async (argv: string[], init: Record<string, unknown>) => {
        ran.push({ argv, init });
        return world.run?.(argv) ?? { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
    },
    clock: { sleep: () => new Promise((done) => setTimeout(done, 1)) },
    session: { version: async () => ({ version: "2.1.293" }) },
    ui: { status: () => {} },
    command: {
      register: async (spec: Record<string, unknown>) => {
        registered.push(spec);
        return { command: spec.name };
      },
    },
  };
  const start = async () => {
    for (const hook of starts) {
      await hook(
        $,
        { cwd: "/", surface: "terminal", isInteractive: true },
        async () => ({}),
      );
    }
    await new Promise((done) => setTimeout(done, 20));
  };
  const run = async (command: string, args: string) => {
    const hook = commands.get(command);
    if (hook === undefined) throw new Error(`no command ${command}`);
    let calledNext = false;
    const answer = await hook($, { command, args }, async () => {
      calledNext = true;
      return {};
    });
    expect(calledNext).toBe(false);
    return answer as { text?: string };
  };
  return { commands, start, run, registered, ran };
}

const NODE = { ARMADRA_NODE_ID: "node-1" };

describe("the mod's slash commands", () => {
  it("are the design's seven, armadra-named, on verbs the core answers", () => {
    expect(MOD_COMMANDS.map((command) => command.name)).toEqual([
      "armadra-post",
      "armadra-inbox",
      "armadra-ack",
      "armadra-send",
      "armadra-team",
      "armadra-open",
      "armadra-list",
    ]);
    for (const command of MOD_COMMANDS) {
      expect(command.name).toMatch(/^armadra-[a-z-]+$/);
      expect(command.name.length).toBeLessThanOrEqual(64);
      expect(VERBS as readonly string[]).toContain(command.verb);
    }
  });

  it("keeps its words equal to the interface's, in both languages", () => {
    expect(COMMAND_MESSAGES).toEqual(modCommands);
    for (const command of MOD_COMMANDS) {
      expect(COMMAND_MESSAGES["zh-CN"][command.message]).toBeTruthy();
      expect(COMMAND_MESSAGES.en[command.message]).toBeTruthy();
    }
  });

  it("describes them in the interface language, English when unset", () => {
    const zh = commandDeclarations("zh-CN");
    const en = commandDeclarations("en");
    expect(commandDeclarations()).toBe(en);
    expect(zh).toContain(
      JSON.stringify(COMMAND_MESSAGES["zh-CN"]["mod.command.post"]),
    );
    expect(en).toContain(
      JSON.stringify(COMMAND_MESSAGES.en["mod.command.post"]),
    );
    expect(zh).not.toContain(COMMAND_MESSAGES.en["mod.command.post"]);
    expect(claudeModSource(CLIENT, { locale: "zh-CN" })).toContain(zh);
    expect(claudeModSource(CLIENT)).toBe(
      claudeModSource(CLIENT, { locale: "en" }),
    );
  });

  it("answer their own commands with a literal matcher and never read next", () => {
    const matchers = [
      ...COMMAND_REGISTRATIONS.matchAll(
        /on\("command\.run", \{ command: "([^"]+)" \}, async \(\$, e\) =>/g,
      ),
    ].map((match) => match[1]);
    expect(matchers).toEqual(MOD_COMMANDS.map((command) => command.name));
    const runs = COMMAND_REGISTRATIONS.split('on("command.run"').slice(1);
    for (const run of runs) expect(run).not.toContain("next");
  });

  it("are declared, immediate, only in a canvas node", async () => {
    const source = claudeModSource(CLIENT, { locale: "zh-CN" });
    const inside = await load(source, { env: NODE });
    await inside.start();
    expect(inside.registered.map((spec) => spec.name)).toEqual(
      MOD_COMMANDS.map((command) => command.name),
    );
    for (const spec of inside.registered) {
      expect(spec.immediate).toBe(true);
      expect(typeof spec.description).toBe("string");
    }
    expect(inside.registered[0]?.description).toBe(
      COMMAND_MESSAGES["zh-CN"]["mod.command.post"],
    );
    expect(inside.registered[0]?.argumentHint).toBe(
      "--to NAME --key KEY --body TEXT",
    );
    expect(
      inside.registered.find((spec) => spec.name === "armadra-list"),
    ).not.toHaveProperty("argumentHint");
    const outside = await load(source, { env: {} });
    await outside.start();
    expect(outside.registered).toEqual([]);
    expect(await outside.run("armadra-list", "")).toEqual({
      text: COMMAND_MESSAGES["zh-CN"]["mod.command.outside"],
    });
    expect(outside.ran).toEqual([]);
  });

  it("run the client's canvas verb with the words a shell would have passed", async () => {
    const mod = await load(claudeModSource(CLIENT), { env: NODE });
    expect(
      await mod.run(
        "armadra-post",
        `--to lead --key "design notes" --body 'it''s "done"' --flag`,
      ),
    ).toEqual({ text: "ok" });
    expect(mod.ran[0]).toEqual({
      argv: [
        CLIENT,
        "canvas",
        "post",
        "--to",
        "lead",
        "--key",
        "design notes",
        "--body",
        'its "done"',
        "--flag",
      ],
      init: { timeoutMs: 60000 },
    });
    await mod.run("armadra-open", "--agent claude --task a\\ b\\\"c ''");
    expect(mod.ran[1]?.argv.slice(2)).toEqual([
      "open-agent",
      "--agent",
      "claude",
      "--task",
      'a b"c',
      "",
    ]);
    await mod.run("armadra-list", "   ");
    expect(mod.ran[2]?.argv).toEqual([CLIENT, "canvas", "list"]);
    await mod.run(
      "armadra-team",
      `--member "claude|lead|plan it" --member 'codex|dev|do $X \\n' --chain`,
    );
    expect(mod.ran[3]?.argv.slice(2)).toEqual([
      "team",
      "--member",
      "claude|lead|plan it",
      "--member",
      "codex|dev|do $X \\n",
      "--chain",
    ]);
  });

  it("split the words into the same flags the client parses", async () => {
    const mod = await load(claudeModSource(CLIENT), { env: NODE });
    await mod.run(
      "armadra-send",
      `--to n_2 --body "two words" --key=k --interrupt --to n_3`,
    );
    const words = mod.ran[0]?.argv.slice(3) ?? [];
    expect(parseFlags(words)).toEqual({
      ok: {
        to: ["n_2", "n_3"],
        body: "two words",
        key: "k",
        interrupt: true,
      },
    });
  });

  it("show the client's refusal, an unclosed quote, and a client that cannot start", async () => {
    let refuse = true;
    const mod = await load(claudeModSource(CLIENT), {
      env: NODE,
      run: () => {
        if (!refuse) throw new Error("ENOENT");
        return {
          exitCode: 1,
          stdout: "",
          stderr: "armadra-hook: No link to `lead` (403)\n",
        };
      },
    });
    expect(await mod.run("armadra-send", "--to lead --body hi")).toEqual({
      text: "armadra-hook: No link to `lead` (403)",
    });
    expect(await mod.run("armadra-post", `--body "open`)).toEqual({
      text: COMMAND_MESSAGES.en["mod.command.unclosed"],
    });
    expect(mod.ran).toHaveLength(1);
    refuse = false;
    expect(await mod.run("armadra-inbox", "")).toEqual({
      text: COMMAND_MESSAGES.en["mod.command.failed"],
    });
  });

  it.skipIf(process.platform === "win32")(
    "print exactly what armadra-hook canvas prints",
    async () => {
      // A stand-in client: what it prints for the argv it got is the answer.
      const dir = tempDir("armadra-claude-mod-commands-");
      const client = join(dir, "armadra-hook");
      writeFileSync(client, `#!/bin/sh\nprintf 'canvas:%s\\n' "$*"\n`);
      chmodSync(client, 0o755);
      const mod = await load(claudeModSource(client), {
        env: NODE,
        run: (argv) => {
          const ran = spawnSync(argv[0] as string, argv.slice(1), {
            encoding: "utf8",
          });
          return {
            exitCode: ran.status ?? 1,
            stdout: ran.stdout,
            stderr: ran.stderr,
          };
        },
      });
      expect(await mod.run("armadra-ack", "--id 'm 1'")).toEqual({
        text: "canvas:canvas ack --id m 1",
      });
    },
  );
});
