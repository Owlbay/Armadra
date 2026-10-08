import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import { launchGate } from "../agent/launch-gate";
import { getAgentStatus } from "../agent/status";
import type { WorkspaceEvent } from "../bus";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";
import { acpPrestartPool } from "./index";
import {
  AcpPrestartPool,
  AcpWarmer,
  adapterPhases,
  bundledCli,
  launchSignature,
  programFingerprint,
} from "./prestart";

/**
 * 契约 §51：菜单打开时的预启动池、冷启动预热与适配器阶段耗时的解析。池的
 * 用例对着 `@armadra/agent/acp` 的假 Agent（真子进程）。
 */

const cleanup: string[] = [];
const pools: AcpPrestartPool[] = [];
let open: AcpCore | undefined;

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
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

function plan(env: NodeJS.ProcessEnv = { ...process.env }) {
  return {
    program: process.execPath,
    args: [fakeAcpAgentPath()],
    cwd: tmpdir(),
    env,
  };
}

function pool(idleMs = 10_000): AcpPrestartPool {
  const created = new AcpPrestartPool({ idleMs });
  pools.push(created);
  return created;
}

describe("launchSignature", () => {
  it("does not depend on the order of the environment", () => {
    expect(launchSignature({ ...plan({ A: "1", B: "2" }) })).toBe(
      launchSignature({ ...plan({ B: "2", A: "1" }) }),
    );
    expect(launchSignature(plan({ A: "1" }))).not.toBe(
      launchSignature(plan({ A: "2" })),
    );
  });
});

describe("AcpPrestartPool", () => {
  it("hands out the prestarted process once and is idempotent per key", async () => {
    const prestarts = pool();
    const key = AcpPrestartPool.key("claude", "ws");
    prestarts.prestart(key, plan());
    prestarts.prestart(key, plan());
    expect(prestarts.spawned).toBe(1);
    const claimed = await prestarts.claim(key, plan());
    expect(claimed?.process.alive).toBe(true);
    expect(claimed?.initialized.protocolVersion).toBe(1);
    expect(prestarts.has(key)).toBe(false);
    expect(await prestarts.claim(key, plan())).toBeUndefined();
    await claimed?.process.terminate();
  });

  it("does not hand out a process started with a different launch", async () => {
    const prestarts = pool();
    const key = AcpPrestartPool.key("claude", "ws");
    prestarts.prestart(key, plan({ ...process.env, EXTRA: "1" }));
    expect(await prestarts.claim(key, plan())).toBeUndefined();
    // 不匹配的那一个还在池里，等它自己到期。
    expect(prestarts.has(key)).toBe(true);
  });

  it("reaps a process nobody claimed within the idle window", async () => {
    const prestarts = pool(200);
    const key = AcpPrestartPool.key("claude", "ws");
    prestarts.prestart(key, plan());
    await until(
      () => prestarts.has(key),
      (present) => !present,
    );
    expect(await prestarts.claim(key, plan())).toBeUndefined();
  });

  it("drops a prestart that could not start", async () => {
    const prestarts = pool();
    const key = AcpPrestartPool.key("claude", "ws");
    prestarts.prestart(key, {
      ...plan(),
      program: join(temp("armadra-acp-none-"), "missing"),
    });
    expect(await prestarts.claim(key, plan())).toBeUndefined();
  });
});

describe("bundledCli", () => {
  it("finds the CLI an adapter ships beside its own entry point", () => {
    const root = temp("armadra-acp-pkg-");
    const pkg = join(root, "node_modules", "@agentclientprotocol", "claude");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    const entry = join(pkg, "dist", "index.js");
    writeFileSync(entry, "");
    const sdk = join(
      pkg,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-darwin-arm64",
    );
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "claude"), "");
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(entry, join(bin, "claude-agent-acp"));
    expect(
      bundledCli([join(bin, "claude-agent-acp")], "darwin", "arm64"),
    ).toMatch(/claude-agent-sdk-darwin-arm64[/\\]claude$/);

    const codexPkg = join(root, "codex-acp");
    mkdirSync(join(codexPkg, "dist"), { recursive: true });
    writeFileSync(join(codexPkg, "dist", "index.js"), "");
    const vendor = join(
      codexPkg,
      "node_modules",
      "@openai",
      "codex-linux-x64",
      "vendor",
      "x86_64-unknown-linux-musl",
      "bin",
    );
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, "codex"), "");
    expect(
      bundledCli([join(codexPkg, "dist", "index.js")], "linux", "x64"),
    ).toMatch(/codex-linux-x64[/\\]vendor[/\\].+[/\\]codex$/);

    expect(bundledCli([join(root, "nothing")], "darwin", "arm64")).toBe(
      undefined,
    );
  });
});

describe("AcpWarmer", () => {
  it("warms each target once per interval and again when the program changed", async () => {
    const dir = temp("armadra-acp-warm-");
    const program = join(dir, "adapter");
    writeFileSync(program, "");
    chmodSync(program, 0o755);
    let now = 0;
    const probed: string[] = [];
    const logged: Record<string, unknown>[] = [];
    const target = {
      agentId: "claude",
      plan: { program, args: [], cwd: dir },
    };
    const warmer = new AcpWarmer({
      targets: () => [target],
      now: () => now,
      probe: async (next) => {
        probed.push(next.program);
      },
      version: async () => undefined,
      log: (_message, fields) => logged.push(fields),
    });
    expect(warmer.stale(target)).toBe(true);
    await warmer.warm("idle");
    await warmer.warm("idle");
    expect(probed).toHaveLength(1);
    expect(warmer.stale(target)).toBe(false);
    // 只记数字：没有任何输出正文。
    expect(logged[0]).toMatchObject({ agentId: "claude", reason: "idle" });
    expect(typeof logged[0]?.initializeMs).toBe("number");

    // 升级换了文件：不等满间隔就再做一次。
    const before = programFingerprint(program);
    utimesSync(program, new Date(), new Date(Date.now() + 5_000));
    expect(programFingerprint(program)).not.toBe(before);
    expect(warmer.stale(target)).toBe(true);
    await warmer.warm("install", "claude");
    expect(probed).toHaveLength(2);

    now += 11 * 60_000;
    await warmer.warm("idle");
    expect(probed).toHaveLength(3);
  });

  it("goes through the gate when one is given", async () => {
    const order: string[] = [];
    const warmer = new AcpWarmer({
      targets: () => [
        { agentId: "codex", plan: { program: "x", args: [], cwd: "/" } },
      ],
      probe: async () => {
        order.push("probe");
      },
      gate: async (agentId, run) => {
        order.push(`acquire ${agentId}`);
        await run();
        order.push("release");
      },
    });
    await warmer.warm("idle");
    expect(order).toEqual(["acquire codex", "probe", "release"]);
  });
});

describe("adapterPhases", () => {
  it("keeps only the phase names and the numbers", () => {
    expect(
      adapterPhases(
        "noise [session/create] phase=sdk-initialize durationMs=246.7\n" +
          "[session/create] phase=hooks durationMs=3000 secret text\n" +
          "[session/create] phase=<script> durationMs=1",
      ),
    ).toEqual([
      { phase: "sdk-initialize", durationMs: 247 },
      { phase: "hooks", durationMs: 3000 },
    ]);
  });
});

/* ------------------------------ 路由与领走 ------------------------------ */

function events(core: AcpCore): WorkspaceEvent[] {
  const seen: WorkspaceEvent[] = [];
  core.core.bus.on("workspace.event", ({ event }) => {
    seen.push(event);
  });
  return seen;
}

describe("POST /api/acp/prestart (contract §51)", () => {
  it("prestarts an adapter whose injection needs no node identity, and the next session claims it", async () => {
    // ama 的注入不复用终端的环境与 argv：可以预启动。
    open = await acpCore({ baseAgent: "ama" });
    const seen = events(open);
    const answer = await open.core.call("POST", "/api/acp/prestart", {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
    });
    expect(answer.status).toBe(204);
    const prestarts = acpPrestartPool();
    const key = AcpPrestartPool.key(FAKE_AGENT, open.workspaceId);
    expect(prestarts?.has(key)).toBe(true);
    expect(prestarts?.spawned).toBe(1);

    const nodeId = await open.node();
    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
      prompt: "hello",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(prestarts?.has(key)).toBe(false);
    expect(prestarts?.spawned).toBe(1);

    // 领走的进程不报 spawn / initialize，开会话与落设置照报。
    const phases = seen
      .filter((event) => event.type === "acp.starting")
      .map((event) => (event as { phase: string }).phase);
    expect(phases).toEqual(["session", "configure"]);
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
  });

  it("answers 204 and starts nothing for an adapter whose injection is per node", async () => {
    open = await acpCore();
    const seen = events(open);
    const answer = await open.core.call("POST", "/api/acp/prestart", {
      workspaceId: open.workspaceId,
      agentId: FAKE_AGENT,
    });
    expect(answer.status).toBe(204);
    expect(acpPrestartPool()?.size).toBe(0);

    // 正常起会话：四个阶段按序，都在 `acp.driver` / `acp.update` 之前。
    const nodeId = await open.node();
    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
    });
    expect(created.status).toBe(200);
    const starting = seen.filter((event) => event.type === "acp.starting");
    expect(starting.map((event) => (event as { phase: string }).phase)).toEqual(
      ["spawn", "initialize", "session", "configure"],
    );
    expect(starting[0]).toMatchObject({ nodeId });
  });

  it("refuses a body without a workspace or agent, and an unknown workspace", async () => {
    open = await acpCore();
    expect(
      (await open.core.call("POST", "/api/acp/prestart", { agentId: "claude" }))
        .status,
    ).toBe(400);
    expect(
      (
        await open.core.call("POST", "/api/acp/prestart", {
          workspaceId: "no-such-workspace",
          agentId: "claude",
        })
      ).status,
    ).toBe(404);
  });
});

describe("the launch gate on ACP starts (contracts §51, §52)", () => {
  it.skipIf(process.platform === "win32")(
    "lets the second Codex adapter spawn only after the first one's session/new answered",
    async () => {
      open = await acpCore();
      const bin = temp("armadra-acp-codex-bin-");
      const script = join(bin, "codex-acp");
      writeFileSync(
        script,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeAcpAgentPath()}" "$@"\n`,
      );
      chmodSync(script, 0o755);
      const home = temp("armadra-acp-codex-home-");
      const patched = await open.core.call("PATCH", "/api/settings", {
        agents: {
          custom: [
            {
              id: "custom:fake-codex",
              label: "Fake Codex",
              launchCmd: "codex",
              baseAgent: "codex",
              env: {
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                CODEX_HOME: home,
              },
            },
          ],
        },
      });
      expect(patched.status).toBe(200);
      const seen = events(open);
      const first = await open.node({ agentId: "custom:fake-codex" });
      const second = await open.node({ agentId: "custom:fake-codex" });
      const create = (nodeId: string) =>
        open!.core.call("POST", "/api/acp/sessions", {
          workspaceId: open!.workspaceId,
          nodeId,
          cwd: open!.core.directory,
          agentId: "custom:fake-codex",
        });
      const answers = await Promise.all([create(first), create(second)]);
      for (const answer of answers) {
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      }
      const starting = seen.filter(
        (event) => event.type === "acp.starting",
      ) as unknown as { nodeId: string; phase: string; at: string }[];
      const at = (nodeId: string, phase: string) =>
        Date.parse(
          starting.find(
            (event) => event.nodeId === nodeId && event.phase === phase,
          )?.at ?? "",
        );
      const [leader, follower] =
        at(first, "spawn") <= at(second, "spawn")
          ? [first, second]
          : [second, first];
      expect(at(follower, "spawn")).toBeGreaterThanOrEqual(
        at(leader, "configure"),
      );
      expect(launchGate().holds(first)).toBe(false);
      expect(launchGate().holds(second)).toBe(false);
    },
  );
});
