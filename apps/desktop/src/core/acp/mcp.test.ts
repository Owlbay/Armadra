import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpClient, fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import { hookEndpointFile } from "../paths";
import { hookClient, setHookClient } from "../terminal/environment";
import { type AcpAdapter, acpAdapter } from "./adapters";
import { type AcpHostSession, startAcp, startAdapter } from "./host";
import {
  type AcpSessionClient,
  CANVAS_MCP_NAME,
  acpMcpServers,
  canvasMcpServer,
  clientAcceptsMcpServers,
  sessionOpener,
} from "./mcp";

/** `session/new.mcpServers` 的画布那一条（ACP 设计 §5.8）。 */

const DATA = join(tmpdir(), "armadra-acp-mcp-data");
const HOOK = "/opt/armadra/bin/armadra-hook";
const INPUT = { nodeId: "node-7", agentId: "claude", dataDir: DATA };

const saved = hookClient();
const sessions: AcpHostSession[] = [];
const cleanup: string[] = [];
afterEach(async () => {
  setHookClient(saved);
  await Promise.all(sessions.splice(0).map((s) => s.process.terminate()));
  for (const dir of cleanup.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("canvasMcpServer", () => {
  it("is `armadra-hook mcp` with the terminal's addresses and no token", () => {
    const server = canvasMcpServer({ ...INPUT, hookBin: HOOK });
    expect(server).toEqual({
      name: CANVAS_MCP_NAME,
      command: HOOK,
      args: ["mcp"],
      env: [
        { name: "ARMADRA_NODE_ID", value: "node-7" },
        { name: "ARMADRA_AGENT_ID", value: "claude" },
        { name: "ARMADRA_ENDPOINT_FILE", value: hookEndpointFile(DATA) },
        { name: "ARMADRA_CANVAS_CONTROL", value: "1" },
      ],
    });
    expect(JSON.stringify(server)).not.toMatch(/TOKEN/);
  });

  it("adds the name, role and the session binding when there are some", () => {
    const server = canvasMcpServer({
      ...INPUT,
      hookBin: HOOK,
      nodeName: "reviewer",
      nodeRole: "sub",
      session: { id: "s-1", generation: 3 },
    });
    const env = Object.fromEntries(server!.env.map((e) => [e.name, e.value]));
    expect(env).toMatchObject({
      ARMADRA_NODE_NAME: "reviewer",
      ARMADRA_NODE_ROLE: "sub",
      ARMADRA_SESSION_ID: "s-1",
      ARMADRA_SESSION_GENERATION: "3",
    });
  });

  it("uses the published client, and is absent when there is none", () => {
    setHookClient(HOOK);
    expect(canvasMcpServer(INPUT)?.command).toBe(HOOK);
    setHookClient(undefined);
    expect(canvasMcpServer(INPUT)).toBeUndefined();
  });
});

describe("acpMcpServers", () => {
  it("follows the adapter table: MCP for five CLIs, none for pi and ama", () => {
    setHookClient(HOOK);
    for (const id of ["claude", "codex", "opencode", "omp", "copilot"]) {
      expect(acpMcpServers(acpAdapter(id)!, INPUT)).toHaveLength(1);
    }
    expect(acpMcpServers(acpAdapter("pi")!, INPUT)).toEqual([]);
    expect(acpMcpServers(acpAdapter("ama")!, INPUT)).toEqual([]);
    expect(acpMcpServers(acpAdapter("claude")!, undefined)).toEqual([]);
    setHookClient(undefined);
    expect(acpMcpServers(acpAdapter("claude")!, INPUT)).toEqual([]);
  });
});

/** 记录调用参数的客户端替身。 */
function recordingClient() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const client = {
    newSession: record("new", { sessionId: "s" }),
    loadSession: record("load", {}),
    resumeSession: record("resume", {}),
  } as unknown as AcpSessionClient;
  return { client, calls };
}

describe("feature detection", () => {
  it("reads AcpClient.features and nothing else", () => {
    expect(clientAcceptsMcpServers({ features: { mcpServers: true } })).toBe(
      true,
    );
    expect(clientAcceptsMcpServers({})).toBe(false);
    expect(clientAcceptsMcpServers({ features: { mcpServers: "yes" } })).toBe(
      false,
    );
    // The pinned `@armadra/agent` (≥ 0.6.5) takes `mcpServers` on session open.
    expect(AcpClient.features.mcpServers).toBe(true);
    expect(clientAcceptsMcpServers()).toBe(true);
  });

  it("passes the servers as the third argument when the client takes them", async () => {
    const { client, calls } = recordingClient();
    const server = canvasMcpServer({ ...INPUT, hookBin: HOOK })!;
    const opener = sessionOpener(client, [server], true);
    await opener.newSession("/w");
    await opener.loadSession("s", "/w");
    await opener.resumeSession("s", "/w");
    expect(opener.mcpInjected).toBe(true);
    expect(calls).toEqual([
      { method: "new", args: ["/w", undefined, { mcpServers: [server] }] },
      {
        method: "load",
        args: ["s", "/w", undefined, { mcpServers: [server] }],
      },
      {
        method: "resume",
        args: ["s", "/w", undefined, { mcpServers: [server] }],
      },
    ]);
  });

  it("calls exactly as before when the client is older or there is nothing to add", async () => {
    const server = canvasMcpServer({ ...INPUT, hookBin: HOOK })!;
    for (const [servers, supported] of [
      [[server], false],
      [[], true],
    ] as const) {
      const { client, calls } = recordingClient();
      const opener = sessionOpener(client, servers, supported);
      await opener.newSession("/w");
      await opener.loadSession("s", "/w");
      expect(opener.mcpInjected).toBe(false);
      expect(calls).toEqual([
        { method: "new", args: ["/w"] },
        { method: "load", args: ["s", "/w"] },
      ]);
    }
  });
});

describe("startAcp with mcpServers", () => {
  it("opens the session either way and says whether the servers went out", async () => {
    const server = canvasMcpServer({ ...INPUT, hookBin: HOOK })!;
    const session = await startAcp({
      program: process.execPath,
      args: [fakeAcpAgentPath()],
      cwd: tmpdir(),
      mcpServers: [server],
    });
    sessions.push(session);
    expect(session.sessionId).toMatch(/^fake-/);
    expect(session.mcpInjected).toBe(true);
  });

  it("leaves mcpInjected out when none were asked for", async () => {
    const session = await startAcp({
      program: process.execPath,
      args: [fakeAcpAgentPath()],
      cwd: tmpdir(),
    });
    sessions.push(session);
    expect(session).not.toHaveProperty("mcpInjected");
  });
});

describe.skipIf(process.platform === "win32")(
  "startAdapter with canvasMcp",
  () => {
    /** 一个在 PATH 上、名字是适配器程序名的假 Agent。 */
    function onPath(program: string): NodeJS.ProcessEnv {
      const bin = mkdtempSync(join(tmpdir(), "armadra-acp-mcp-bin-"));
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

    const program = "armadra-fake-acp";
    const withMcp: AcpAdapter = {
      ...(acpAdapter("claude") as AcpAdapter),
      program,
    };
    const withoutMcp: AcpAdapter = {
      ...(acpAdapter("ama") as AcpAdapter),
      program,
      profileFlag: undefined,
    } as AcpAdapter;

    it("asks for the canvas server only where the table says MCP", async () => {
      setHookClient(HOOK);
      const on = await startAdapter(withMcp, {
        cwd: tmpdir(),
        env: onPath(program),
        canvasMcp: INPUT,
      });
      sessions.push(on);
      expect(on.mcpInjected).toBe(true);

      const off = await startAdapter(withoutMcp, {
        cwd: tmpdir(),
        env: onPath(program),
        canvasMcp: INPUT,
      });
      sessions.push(off);
      expect(off).not.toHaveProperty("mcpInjected");
    });
  },
);
