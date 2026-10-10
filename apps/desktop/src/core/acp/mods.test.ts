import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import { artifactLayout } from "../hook/install/inject";
import { type AcpCore, acpCore, until } from "./fixture";
import { acpPrestartPool } from "./index";

/**
 * The Claude Code mod under ACP (contract §59): the adapter is started with
 * `CLAUDE_CODE_PLUGIN_DIRS` naming the mod and `ARMADRA_MOD_PROFILE=acp`
 * beside the node's own addresses, when the Claude Code the adapter ships is
 * at or above the gate — and, needing the node's identity, it is no longer
 * prestarted.
 *
 * The adapter is a stand-in laid out as the npm package is (the SDK's
 * manifest names the Claude Code it ships) that writes its environment to a
 * file and then runs the fake ACP agent.
 */

const cleanup: string[] = [];
let open: AcpCore | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

const TAG = `${process.platform}-${process.arch}`;

/** A `claude-agent-acp` whose SDK ships `claudeCode`; answers its env file. */
function fakeAdapter(claudeCode: string): { program: string; envFile: string } {
  const root = temp("armadra-acp-mods-");
  const pkg = join(root, "lib", "claude-agent-acp");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  const scope = join(pkg, "node_modules", "@anthropic-ai");
  mkdirSync(join(scope, `claude-agent-sdk-${TAG}`), { recursive: true });
  writeFileSync(join(scope, `claude-agent-sdk-${TAG}`, "claude"), "");
  mkdirSync(join(scope, "claude-agent-sdk"));
  writeFileSync(
    join(scope, "claude-agent-sdk", "package.json"),
    JSON.stringify({ version: "0.3.293", claudeCodeVersion: claudeCode }),
  );
  const envFile = join(root, "env.json");
  const program = join(pkg, "dist", "claude-agent-acp");
  writeFileSync(
    program,
    `#!/bin/sh\n"${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' "${envFile}"\nexec "${process.execPath}" "${fakeAcpAgentPath()}" "$@"\n`,
  );
  chmodSync(program, 0o755);
  return { program, envFile };
}

async function start(claudeCode: string) {
  open = await acpCore({ baseAgent: "claude" });
  const adapter = fakeAdapter(claudeCode);
  const patched = await open.core.call("PATCH", "/api/settings", {
    agents: {
      custom: [
        {
          id: "custom:fake-claude",
          label: "Fake Claude",
          launchCmd: "claude",
          // 官方适配器不换程序：表里的 `claude-agent-acp` 经条目的 PATH 找到。
          env: {
            PATH: `${dirname(adapter.program)}:${process.env.PATH ?? ""}`,
          },
          baseAgent: "claude",
        },
      ],
    },
  });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  return adapter;
}

async function session(core: AcpCore) {
  const nodeId = await core.node({ agentId: "custom:fake-claude" });
  const created = await core.core.call("POST", "/api/acp/sessions", {
    workspaceId: core.workspaceId,
    nodeId,
    cwd: core.core.directory,
    agentId: "custom:fake-claude",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return nodeId;
}

function envOf(file: string): Promise<Record<string, string>> {
  return until(
    () => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      } catch {
        return undefined;
      }
    },
    (env) => env !== undefined,
  ) as Promise<Record<string, string>>;
}

describe.skipIf(process.platform === "win32")(
  "the Claude Code mod under ACP (contract §59)",
  () => {
    it("mounts the mod for the adapter's Claude Code at the gate, with the node's addresses, and does not prestart", async () => {
      const adapter = await start("2.1.293");
      const core = open as AcpCore;
      const prestart = await core.core.call("POST", "/api/acp/prestart", {
        workspaceId: core.workspaceId,
        agentId: "custom:fake-claude",
      });
      expect(prestart.status).toBe(204);
      expect(acpPrestartPool()?.size).toBe(0);

      const nodeId = await session(core);
      const env = await envOf(adapter.envFile);
      // 适配器环境里原有的插件目录保留，mod 接在最后。
      const before = (process.env.CLAUDE_CODE_PLUGIN_DIRS ?? "")
        .split(delimiter)
        .filter((dir) => dir !== "");
      expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(
        [...before, artifactLayout(core.core.dataDir, "claude").modDir].join(
          delimiter,
        ),
      );
      expect(env.ARMADRA_MOD_PROFILE).toBe("acp");
      expect(env.ARMADRA_NODE_ID).toBe(nodeId);
      expect(env.ARMADRA_ENDPOINT_FILE).toBeTruthy();
      expect(env.ARMADRA_SESSION_ID).toBeTruthy();
    });

    it("mounts nothing below the gate, and prestarts as before", async () => {
      const adapter = await start("2.1.292");
      const core = open as AcpCore;
      const prestart = await core.core.call("POST", "/api/acp/prestart", {
        workspaceId: core.workspaceId,
        agentId: "custom:fake-claude",
      });
      expect(prestart.status).toBe(204);
      await until(
        () => acpPrestartPool()?.size ?? 0,
        (size) => size === 1,
      );
      await session(core);
      const env = await envOf(adapter.envFile);
      expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(
        process.env.CLAUDE_CODE_PLUGIN_DIRS,
      );
      expect(env.ARMADRA_MOD_PROFILE).toBeUndefined();
    });
  },
);
