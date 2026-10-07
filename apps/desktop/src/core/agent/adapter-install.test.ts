import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EventBus } from "../bus";
import { type Kit, startKit } from "../contract/parity-kit";
import { CoreFailure } from "../http/errors";
import { installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import type { RequestIdentity } from "../identity/gate";
import { createLog, nodePlatform } from "../platform";
import { tempDir } from "../testing/temp-dir";
import { OUTBOUND } from "../net/outbound";
import {
  ADAPTER_INSTALL_OUTBOUND,
  AdapterInstaller,
  type InstallCommand,
  type InstallRunner,
  type NpmLocation,
  TAIL_LINES,
  cleanLine,
  installAdapterInstallRoutes,
  parseNpmLsVersion,
  locateNpm,
  npmInvocation,
} from "./adapter-install";

/**
 * ACP 适配器的安装（契约 §39.7）。不真去 npm：起进程的那一层换成假的，记下
 * 命令、吐几段输出、按要求的退出码结束。
 */

const onUnix = process.platform !== "win32";

const NPM: NpmLocation = {
  program: "/opt/fake/bin/npm",
  prefix: [],
  directory: "/opt/fake/bin",
  source: "cli",
};

interface FakeRun {
  readonly commands: InstallCommand[];
  readonly runner: InstallRunner;
  kills: number;
}

/** 一个假 runner：每次起进程都吐 `chunks`，然后以 `exitCode` 结束。 */
function fakeRunner(
  chunks: readonly string[],
  exitCode: number | null = 0,
  options: { hang?: boolean; onRun?: () => void } = {},
): FakeRun {
  const fake: FakeRun = {
    commands: [],
    kills: 0,
    runner: (command, onOutput) => {
      fake.commands.push(command);
      let finish: (value: { exitCode: number | null }) => void = () => {};
      const done = new Promise<{ exitCode: number | null }>((resolve) => {
        finish = resolve;
      });
      queueMicrotask(() => {
        for (const chunk of chunks) onOutput(chunk);
        options.onRun?.();
        if (!options.hang) finish({ exitCode });
      });
      return {
        done,
        kill: () => {
          fake.kills += 1;
          finish({ exitCode: null });
        },
      };
    },
  };
  return fake;
}

function rejection(run: () => unknown): CoreFailure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreFailure);
    return error as CoreFailure;
  }
  throw new Error("没有拒绝");
}

const audits: AuditEvent[] = [];
afterEach(() => {
  audits.length = 0;
  resetAuditSink();
});

describe("allowlist", () => {
  it("只认有独立适配器包的那几家，别的 agentId 一律拒绝且不起进程", () => {
    const fake = fakeRunner([]);
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: () => false,
      locate: () => NPM,
    });
    for (const agentId of [
      "opencode",
      "copilot",
      "ama",
      "omp",
      "custom:codex",
      "codex; rm -rf /",
      "",
    ]) {
      expect(rejection(() => installer.start(agentId)).code).toBe(
        "adapter_not_installable",
      );
      expect(rejection(() => installer.status(agentId)).code).toBe(
        "adapter_not_installable",
      );
    }
    expect(fake.commands).toEqual([]);
  });

  it("命令是固定的 npm install --global <包>，不带调用方给的任何东西", async () => {
    const fake = fakeRunner(["added 1 package\n"]);
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: (() => {
        let calls = 0;
        return () => calls++ > 0;
      })(),
      locate: () => NPM,
      env: () => ({ PATH: "/usr/bin", HOME: "/home/x" }),
    });
    installer.start("codex");
    await installer.settled("codex");
    expect(fake.commands).toHaveLength(1);
    const [command] = fake.commands;
    expect(command?.program).toBe("/opt/fake/bin/npm");
    expect(command?.args).toEqual([
      "install",
      "--global",
      "@agentclientprotocol/codex-acp",
    ]);
    // npm 所在目录排在 PATH 最前：`env node` 解析到同一个 Node。
    expect(command?.env.PATH?.split(delimiter)[0]).toBe("/opt/fake/bin");
  });
});

describe("任务", () => {
  it("开始 → 输出尾部 → 结束与退出码；结束后重新探测", async () => {
    let installed = false;
    let probes = 0;
    const fake = fakeRunner(["npm notice\n", "added 3 packages in 2s\n"], 0, {
      onRun: () => {
        installed = true;
      },
    });
    installAuditSink((event) => audits.push(event));
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: () => {
        probes += 1;
        return installed;
      },
      locate: () => NPM,
    });
    expect(installer.status("claude")).toEqual({
      agentId: "claude",
      target: "adapter",
      state: "idle",
      package: "@agentclientprotocol/claude-agent-acp",
      output: [],
    });
    const started = installer.start("claude");
    expect(started.state).toBe("running");
    expect(started.startedAt).toBeTypeOf("string");
    // 同一家在装时再点一次：答那一个任务，不起第二个进程。
    expect(installer.start("claude").startedAt).toBe(started.startedAt);
    const probesBefore = probes;
    const done = await installer.settled("claude");
    expect(probes).toBeGreaterThan(probesBefore);
    expect(done).toMatchObject({
      agentId: "claude",
      state: "succeeded",
      exitCode: 0,
      installed: true,
      output: ["npm notice", "added 3 packages in 2s"],
    });
    expect(done.endedAt).toBeTypeOf("string");
    expect(fake.commands).toHaveLength(1);
    // 审计：开始与结束各一条，只有包名、状态与退出码，没有输出。
    expect(audits.map((event) => event.action)).toEqual([
      "agent.adapter.install",
      "agent.adapter.install.finish",
    ]);
    expect(audits[1]?.detail).toMatchObject({
      state: "succeeded",
      exitCode: 0,
    });
    expect(JSON.stringify(audits)).not.toContain("added 3 packages");
  });

  it("已装好时不带 reinstall 被拒，带上就重装", async () => {
    const fake = fakeRunner([]);
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: () => true,
      locate: () => NPM,
    });
    expect(rejection(() => installer.start("pi")).code).toBe(
      "adapter_already_installed",
    );
    expect(installer.start("pi", true).reinstall).toBe(true);
    expect((await installer.settled("pi")).state).toBe("succeeded");
  });

  it("非零退出 → adapter_install_failed，带退出码", async () => {
    const installer = new AdapterInstaller({
      runner: fakeRunner(["npm error code E404\n"], 1).runner,
      probe: () => false,
      locate: () => NPM,
    });
    installer.start("codex");
    const done = await installer.settled("codex");
    expect(done).toMatchObject({
      state: "failed",
      exitCode: 1,
      installed: false,
      failure: { code: "adapter_install_failed" },
      output: ["npm error code E404"],
    });
  });

  it("npm 说成功了但 PATH 上没有 → adapter_install_missing", async () => {
    const installer = new AdapterInstaller({
      runner: fakeRunner([], 0).runner,
      probe: () => false,
      locate: () => NPM,
    });
    installer.start("codex");
    expect((await installer.settled("codex")).failure?.code).toBe(
      "adapter_install_missing",
    );
  });

  it("超时按 pid 结束那一个进程 → adapter_install_timeout", async () => {
    const fake = fakeRunner([], 0, { hang: true });
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: () => false,
      locate: () => NPM,
      timeoutMs: 5,
    });
    installer.start("codex");
    const done = await installer.settled("codex");
    expect(fake.kills).toBe(1);
    expect(done.failure?.code).toBe("adapter_install_timeout");
    expect(done.exitCode).toBeNull();
  });

  it("找不到 npm → npm_not_found，不起进程", () => {
    const fake = fakeRunner([]);
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: () => false,
      locate: () => undefined,
    });
    expect(rejection(() => installer.start("codex")).code).toBe(
      "npm_not_found",
    );
    expect(installer.status("codex").state).toBe("idle");
    expect(fake.commands).toEqual([]);
  });
});

describe("CLI 与回滚（§47）", () => {
  it("target: cli 只认 CLI 表，命令装 CLI 包；任务键分开", async () => {
    const fake = fakeRunner(["added 1 package\n"]);
    const probes: string[] = [];
    let done = false;
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: (agentId, target) => {
        probes.push(`${agentId}:${target}`);
        return done;
      },
      locate: () => NPM,
    });
    expect(
      rejection(() => installer.start("custom:x", { target: "cli" })).code,
    ).toBe("adapter_not_installable");
    for (const [agentId, name] of [
      ["omp", "@oh-my-pi/pi-coding-agent"],
      ["pi", "@mariozechner/pi-coding-agent"],
      ["claude", "@anthropic-ai/claude-code"],
      ["codex", "@openai/codex"],
      ["opencode", "opencode-ai"],
      ["copilot", "@github/copilot"],
      ["ama", "@armadra/agent"],
    ] as const) {
      expect(installer.status(agentId, "cli")).toMatchObject({
        target: "cli",
        state: "idle",
        package: name,
      });
    }
    const started = installer.start("omp", { target: "cli" });
    expect(started).toMatchObject({ target: "cli", state: "running" });
    done = true;
    const finished = await installer.settled("omp", "cli");
    expect(finished).toMatchObject({ state: "succeeded", installed: true });
    expect(fake.commands.at(-1)?.args).toEqual([
      "install",
      "--global",
      "@oh-my-pi/pi-coding-agent",
    ]);
    expect(probes).toContain("omp:cli");
    // 适配器那一样没被碰过。
    expect(installer.status("pi").state).toBe("idle");
  });

  it("同一家另一样在装 → 409 adapter_install_busy；同一样再点答那一个任务", async () => {
    const fake = fakeRunner([], 0, { hang: true });
    const installer = new AdapterInstaller({
      runner: fake.runner,
      probe: () => false,
      locate: () => NPM,
    });
    const first = installer.start("claude", { target: "cli" });
    expect(installer.start("claude", { target: "cli" }).startedAt).toBe(
      first.startedAt,
    );
    const busy = rejection(() => installer.start("claude"));
    expect(busy.code).toBe("adapter_install_busy");
    expect(busy.status).toBe(409);
    // 别家不受影响。
    expect(installer.start("codex").state).toBe("running");
    installer.dispose();
  });

  it("开始前记下上一版本；失败后 rollback 装回 <包>@<版本>", async () => {
    let exitCode = 1;
    const commands: InstallCommand[] = [];
    const installer = new AdapterInstaller({
      runner: (command, onOutput) => {
        commands.push(command);
        const code = exitCode;
        return {
          done: Promise.resolve().then(() => {
            onOutput("npm output\n");
            return { exitCode: code };
          }),
          kill: () => undefined,
        };
      },
      probe: () => true,
      locate: () => NPM,
      installedVersion: async (name) =>
        name === "pi-acp" ? "0.0.30" : undefined,
    });
    expect(
      rejection(() => installer.start("pi", { rollback: true })).code,
    ).toBe("adapter_rollback_unavailable");
    installer.start("pi", { reinstall: true });
    const failed = await installer.settled("pi");
    expect(failed).toMatchObject({
      state: "failed",
      previousVersion: "0.0.30",
      failure: { code: "adapter_install_failed" },
    });
    exitCode = 0;
    const rolled = installer.start("pi", { rollback: true });
    expect(rolled).toMatchObject({ rollback: true, previousVersion: "0.0.30" });
    expect((await installer.settled("pi")).state).toBe("succeeded");
    expect(commands.at(-1)?.args).toEqual([
      "install",
      "--global",
      "pi-acp@0.0.30",
    ]);
  });

  it("拿不到上一版本时不带 previousVersion，回滚被拒", async () => {
    const installer = new AdapterInstaller({
      runner: fakeRunner([], 1).runner,
      probe: () => false,
      locate: () => NPM,
      installedVersion: async () => undefined,
    });
    installer.start("codex", { target: "cli" });
    const done = await installer.settled("codex", "cli");
    expect(done.previousVersion).toBeUndefined();
    expect(
      rejection(() =>
        installer.start("codex", { target: "cli", rollback: true }),
      ).code,
    ).toBe("adapter_rollback_unavailable");
  });

  it("parseNpmLsVersion 读 npm ls --json 的 dependencies.<包>.version", () => {
    expect(
      parseNpmLsVersion(
        JSON.stringify({ dependencies: { "pi-acp": { version: "0.0.34" } } }),
        "pi-acp",
      ),
    ).toBe("0.0.34");
    expect(parseNpmLsVersion("{}", "pi-acp")).toBeUndefined();
    expect(parseNpmLsVersion("not json", "pi-acp")).toBeUndefined();
  });
});

describe("输出", () => {
  it("脱敏：npm 令牌、.npmrc 的 _authToken、URL 里的口令、常见凭据", async () => {
    const secrets = [
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "s3cr3t-registry-token-value",
      "hunter2hunter2",
      "ghp_abcdefghijklmnopqrstuv",
    ];
    const installer = new AdapterInstaller({
      runner: fakeRunner([
        `npm http fetch GET 401 token ${secrets[0]}\n`,
        `//registry.example.com/:_authToken=${secrets[1]}\n`,
        `GET https://user:${secrets[2]}@registry.example.com/pkg\n`,
        `\x1b[31mAuthorization: Bearer ${secrets[3]}\x1b[0m\n`,
      ]).runner,
      probe: () => false,
      locate: () => NPM,
    });
    installer.start("codex");
    const done = await installer.settled("codex");
    const text = JSON.stringify(done);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(done.output[1]).toContain("_authToken=");
    expect(done.output[3]).not.toContain("\x1b");
  });

  it(`只留最后 ${TAIL_LINES} 行，一行截长，半行也在`, async () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("");
    const installer = new AdapterInstaller({
      runner: fakeRunner([many, "x".repeat(1000) + "\n", "partial"]).runner,
      probe: () => false,
      locate: () => NPM,
    });
    installer.start("codex");
    const done = await installer.settled("codex");
    expect(done.output).toHaveLength(TAIL_LINES);
    expect(done.output.at(-1)).toBe("partial");
    expect(done.output.at(-2)?.length).toBeLessThan(400);
    expect(cleanLine("a\x07b")).toBe("ab");
  });
});

describe("出站登记", () => {
  it("npm 子进程的联网登记在出站表的 npmRegistry", () => {
    expect(ADAPTER_INSTALL_OUTBOUND).toBe(OUTBOUND.npmRegistry);
    expect(ADAPTER_INSTALL_OUTBOUND.purpose).toContain("ACP");
  });
});

describe("npm 的位置", () => {
  function executable(directory: string, name: string): void {
    const path = join(directory, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }

  it.skipIf(!onUnix)(
    "CLI 所在 bin 目录里的 npm 优先于 PATH 上排在前面的那个",
    () => {
      const first = tempDir("armadra-npm-first-");
      const cliBin = tempDir("armadra-npm-cli-");
      executable(first, "npm");
      executable(cliBin, "codex");
      executable(cliBin, "npm");
      const env = {
        PATH: [first, cliBin].join(delimiter),
        HOME: tempDir("armadra-npm-home-"),
      };
      expect(locateNpm("codex", env)).toEqual({
        program: join(cliBin, "npm"),
        prefix: [],
        directory: cliBin,
        source: "cli",
      });
    },
  );

  it.skipIf(!onUnix)("CLI 旁边没有 npm 时退回 PATH 上的", () => {
    const first = tempDir("armadra-npm-path-");
    const cliBin = tempDir("armadra-npm-lonely-");
    executable(first, "npm");
    executable(cliBin, "codex");
    const env = {
      PATH: [first, cliBin].join(delimiter),
      HOME: tempDir("armadra-npm-home-"),
    };
    expect(locateNpm("codex", env)).toMatchObject({
      program: join(first, "npm"),
      source: "path",
    });
  });

  it("Windows 的 npm.cmd 改成同目录 node.exe 跑 npm-cli.js；拼不出来就不用", () => {
    const directory = tempDir("armadra-npm-win-");
    const cmd = join(directory, "npm.cmd");
    writeFileSync(cmd, "@echo off\n");
    expect(npmInvocation(cmd, "win32")).toBeUndefined();
    mkdirSync(join(directory, "node_modules", "npm", "bin"), {
      recursive: true,
    });
    const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    writeFileSync(cli, "");
    writeFileSync(join(directory, "node.exe"), "");
    expect(npmInvocation(cmd, "win32")).toEqual({
      program: join(directory, "node.exe"),
      prefix: [cli],
    });
    expect(npmInvocation("/usr/bin/npm", "linux")).toEqual({
      program: "/usr/bin/npm",
      prefix: [],
    });
  });
});

/* ------------------------------- procedure ------------------------------- */

describe("agents.installAdapter / agents.adapterInstall", () => {
  let server: CoreServer;
  let kit: Kit;
  let fake: FakeRun;
  const identities: Record<string, RequestIdentity | undefined> = {
    member: {
      subject: { principalId: "member-1", kind: "member", scopes: [] },
    },
    owner: {
      subject: { principalId: "owner-1", kind: "owner", scopes: [] },
    },
  };

  beforeAll(async () => {
    const platform = nodePlatform({
      dataDir: tempDir("armadra-adapter-install-"),
      appVersion: "0.0.0-test",
      isPackaged: false,
      log: createLog("error"),
    });
    server = new CoreServer({
      platform,
      bus: new EventBus(),
      version: "0.0.0-test",
    });
    fake = fakeRunner(["added 1 package\n"]);
    installAdapterInstallRoutes(
      server,
      new AdapterInstaller({
        runner: fake.runner,
        probe: () => false,
        locate: () => NPM,
      }),
    );
    installContract(server, { validateOutput: true, platform });
    kit = await startKit(server, (name) => identities[name]);
  });

  afterAll(async () => {
    await server.close();
  });

  it("非 owner 被拒（403 forbidden），不起进程", async () => {
    for (const name of ["agents.installAdapter", "agents.adapterInstall"]) {
      const answer = await kit.procedure(name, { agentId: "codex" }, "member");
      expect(answer.status, name).toBe(403);
      expect((answer.body as { code: string }).code).toBe("forbidden");
    }
    expect(fake.commands).toEqual([]);
  });

  it("allowlist 外的 agentId 答 400 adapter_not_installable", async () => {
    const answer = await kit.procedure(
      "agents.installAdapter",
      { agentId: "opencode" },
      "owner",
    );
    expect(answer.status).toBe(400);
    expect((answer.body as { code: string }).code).toBe(
      "adapter_not_installable",
    );
  });

  it("target: cli 经 procedure 起 CLI 安装，进度按 target 读", async () => {
    const started = await kit.procedure(
      "agents.installAdapter",
      { agentId: "opencode", target: "cli" },
      "owner",
    );
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      target: "cli",
      package: "opencode-ai",
    });
    const read = await kit.procedure(
      "agents.adapterInstall",
      { agentId: "opencode", target: "cli" },
      "owner",
    );
    expect(read.status).toBe(200);
    expect((read.body as { target: string }).target).toBe("cli");
  });

  it("入参只收 agentId 与 reinstall：多给的参数不进命令", async () => {
    const answer = await kit.procedure(
      "agents.installAdapter",
      { agentId: "pi", args: ["--registry", "http://evil"] },
      "owner",
    );
    expect(answer.status).toBe(200);
    expect(fake.commands.at(-1)?.args).toEqual([
      "install",
      "--global",
      "pi-acp",
    ]);
  });

  it("owner 起一次、再读进度（本机请求没有身份，同样是 owner）", async () => {
    const started = await kit.procedure("agents.installAdapter", {
      agentId: "codex",
    });
    expect(started.status).toBe(200);
    expect((started.body as { state: string }).state).toBe("running");
    let state = "running";
    for (let i = 0; i < 50 && state === "running"; i += 1) {
      const read = await kit.procedure("agents.adapterInstall", {
        agentId: "codex",
      });
      state = (read.body as { state: string }).state;
    }
    // 假的 probe 一直答没装：结束态是 adapter_install_missing。
    expect(state).toBe("failed");
  });
});
