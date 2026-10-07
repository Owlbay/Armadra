import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAgentStatus } from "../agent/status";
import { probeAgents } from "../remote/node-probe";
import {
  capabilityOf,
  INTEGRATION_CAPABILITY,
  OPERATIONS,
} from "../remote/operations";
import type { SshHost } from "../settings/ssh-hosts";
import { streamArgv } from "../terminal/ssh/argv";
import { ACP_ADAPTERS } from "./adapters";
import { AcpError } from "./client";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";
import {
  type AcpSshDeps,
  remoteAcpCommand,
  setAcpSshDeps,
  sshHostOf,
  startRemoteAdapter,
} from "./ssh";

/**
 * SSH 节点的 ACP（契约 §26 的 SSH 小节）。「远端」是这台机器自己，经一个假
 * ssh：吃掉 ssh 的选项与目的主机，把远端命令交给本机的 `/bin/sh -c`，与远端
 * 登录 shell 做的事一样（与 `tools/probes/remote-e2e.mjs` 同一个脚本）。假 ACP
 * Agent 是 `@armadra/agent/acp` 的那一个，真子进程。
 */

const unix = process.platform !== "win32";
const describeUnix = unix ? describe : describe.skip;

const FAKE_SSH = (log: string) => `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(log)}
while [ $# -gt 0 ]; do
  case "$1" in
    -B|-b|-c|-D|-E|-e|-F|-I|-i|-J|-L|-l|-m|-O|-o|-P|-p|-Q|-R|-S|-W|-w) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
for name in $(env | cut -d= -f1 | grep '^ARMADRA_[A-Za-z0-9_]*$'); do unset "$name"; done
exec /bin/sh -c "$*"
`;

const HOST: SshHost = {
  id: "fake-remote",
  name: "假远端",
  host: "fake-remote.invalid",
  user: "probe",
  worker: { path: "/opt/armadra/worker" },
};

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "armadra-acp-ssh-"));
});

afterEach(() => {
  setAcpSshDeps(undefined);
  rmSync(scratch, { recursive: true, force: true });
});

describe("the remote command", () => {
  it("quotes every word, enters the directory and execs the adapter", () => {
    const line = remoteAcpCommand(
      "/srv/project",
      "codex-acp",
      ["--flag", "a b"],
      [["FOO", "bar baz"]],
    );
    expect(line).toBe(
      `env FOO='bar baz' /bin/sh -c 'cd "$0" || exit 1; exec "$@"' '/srv/project' 'codex-acp' '--flag' 'a b'`,
    );
  });

  it("refuses a value no remote shell would read literally", () => {
    for (const bad of ["it's", "a\\b", "hey!", "line\nbreak"]) {
      expect(() => remoteAcpCommand(bad, "x", [])).toThrow(AcpError);
      expect(() => remoteAcpCommand("/w", "x", [bad])).toThrow(AcpError);
    }
    expect(() => remoteAcpCommand("/w", "x", [], [["BAD-NAME", "v"]])).toThrow(
      AcpError,
    );
  });

  it("ends ssh's option parsing before the destination", () => {
    const argv = streamArgv("/data", { ...HOST, port: 2222 }, "env /bin/sh");
    expect(argv[0]).toBe("ssh");
    expect(argv).not.toContain("-t");
    expect(argv.slice(-3)).toEqual([
      "--",
      "probe@fake-remote.invalid",
      "env /bin/sh",
    ]);
    expect(argv).toContain("2222");
  });

  it("reads the host id off the node data", () => {
    expect(sshHostOf({ ssh: { hostId: "h1" } })).toBe("h1");
    expect(sshHostOf({ ssh: null })).toBeUndefined();
    expect(sshHostOf({})).toBeUndefined();
  });
});

describe("agents.probe", () => {
  it("is a read-only action under remote.integration.v1", () => {
    expect(OPERATIONS["agents.probe"]?.replay).toBe(true);
    expect(capabilityOf("agents.probe")).toBe(INTEGRATION_CAPABILITY);
  });

  it.runIf(unix)("finds programs on the Worker's PATH and nothing else", () => {
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex-acp"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex-acp"), 0o755);
    writeFileSync(join(bin, "not-executable"), "");
    const answer = probeAgents(
      {
        programs: [
          "codex-acp",
          "not-executable",
          "missing",
          "../escape",
          join(bin, "codex-acp"),
        ],
      },
      { PATH: `${bin}:relative` },
    );
    expect(answer.platform).toBe(process.platform);
    expect(answer.programs).toEqual({
      "codex-acp": join(bin, "codex-acp"),
      "not-executable": null,
      missing: null,
      "../escape": null,
      [join(bin, "codex-acp")]: join(bin, "codex-acp"),
    });
  });
});

describe("starting a remote adapter", () => {
  const adapter = ACP_ADAPTERS.find((entry) => entry.agentId === "codex")!;
  const deps = (overrides: Partial<AcpSshDeps> = {}): AcpSshDeps => ({
    dataDir: scratch,
    host: (id) => (id === HOST.id ? HOST : undefined),
    probe: async () => ({
      platform: "linux",
      programs: { "codex-acp": "/usr/bin/codex-acp" },
    }),
    launcher: "/nonexistent/ssh",
    ...overrides,
  });
  const start = (given: AcpSshDeps | undefined, hostId = HOST.id) =>
    startRemoteAdapter(
      adapter,
      { hostId, dataDir: scratch, cwd: "/srv" },
      given,
    );

  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as AcpError).code;
    }
    return "resolved";
  };

  it("answers acp_unsupported only for an unknown host or an old Worker", async () => {
    expect(await code(start(undefined))).toBe("acp_unsupported");
    expect(await code(start(deps(), "other"))).toBe("acp_unsupported");
    expect(
      await code(start(deps({ host: () => ({ ...HOST, worker: undefined }) }))),
    ).toBe("acp_unsupported");
    const old = Object.assign(
      new Error("This worker does not perform agents.probe"),
      {
        status: 501,
      },
    );
    expect(
      await code(
        start(
          deps({
            probe: async () => {
              throw old;
            },
          }),
        ),
      ),
    ).toBe("acp_unsupported");
  });

  it("answers acp_not_installed when the Worker does not find the adapter", async () => {
    expect(
      await code(
        start(
          deps({
            probe: async () => ({
              platform: "linux",
              programs: { "codex-acp": null },
            }),
          }),
        ),
      ),
    ).toBe("acp_not_installed");
  });

  it("answers acp_spawn_failed when the Worker cannot be reached", async () => {
    expect(
      await code(
        start(
          deps({
            probe: async () => {
              throw Object.assign(new Error("down"), { status: 503 });
            },
          }),
        ),
      ),
    ).toBe("acp_spawn_failed");
  });
});

describeUnix("an SSH node driven over ACP", () => {
  let open: AcpCore | undefined;

  afterEach(async () => {
    await open?.stop();
    open = undefined;
  });

  it("runs the adapter through ssh, answers a turn, and switches to a remote terminal and back", async () => {
    open = await acpCore();
    const log = join(scratch, "ssh-argv.log");
    const fakeSsh = join(scratch, "fake-ssh");
    writeFileSync(fakeSsh, FAKE_SSH(log));
    chmodSync(fakeSsh, 0o755);
    const probed: string[][] = [];
    const canvas: (readonly (readonly [string, string])[])[] = [];
    setAcpSshDeps({
      dataDir: open.core.directory,
      host: (id) => (id === HOST.id ? HOST : undefined),
      launcher: fakeSsh,
      probe: async (_hostId, programs) => {
        probed.push([...programs]);
        return probeAgents({ programs });
      },
      canvas: async (_hostId, env) => {
        canvas.push(env);
        return undefined;
      },
    });
    const nodeId = await open.node({ sshHostId: HOST.id });

    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
      prompt: "over ssh",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const row = created.body as { id: string; generation: number };
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    const reply = (
      await open.core.call("GET", `/api/acp/sessions/${row.id}/log`)
    ).body as { entries: { blocks: { text?: string }[] }[] };
    expect(
      reply.entries.flatMap((entry) => entry.blocks.map((block) => block.text)),
    ).toContain("echo: over ssh");

    // 经的是假 ssh：选项、`--`、目的主机，再是一行远端命令。
    const argv = readFileSync(log, "utf8").trimEnd().split("\n");
    const separator = argv.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(argv[separator + 1]).toBe("probe@fake-remote.invalid");
    expect(argv[separator + 2]).toContain(`'${open.core.directory}'`);
    expect(argv[separator + 2]).toContain(`'${process.execPath}'`);
    expect(probed[0]).toEqual([process.execPath]);
    // 画布工具按节点身份准备；凭据条目名不带过去。
    const env = new Map(canvas[0]);
    expect(env.get("ARMADRA_NODE_ID")).toBe(nodeId);
    expect(env.get("ARMADRA_SESSION_ID")).toBe(row.id);
    expect(env.has("ARMADRA_CREDENTIAL_REF")).toBe(false);
    const cliSession = getAgentStatus(open.core.database, nodeId)?.sessionId;
    // CLI 的转录在执行主机上：本机认镜像。
    expect(getAgentStatus(open.core.database, nodeId)?.transcriptPath).toMatch(
      /\.acp\.jsonl$/u,
    );

    // ACP → 终端：同一行，下一代经 SSH 起在同一台主机上。
    const toTerminal = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "terminal" },
    );
    expect(toTerminal.status, JSON.stringify(toTerminal.body)).toBe(200);
    expect(toTerminal.body).toMatchObject({ sessionId: row.id });
    const record = open.terminal.manager
      .liveRecords()
      .find((entry) => entry.id === row.id);
    expect(record?.spec.sshHostId).toBe(HOST.id);
    expect(record?.kind).not.toBe("acp");

    // 终端 → ACP：接回同一个 CLI 会话。
    const toAcp = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      {
        driver: "acp",
      },
    );
    expect(toAcp.status, JSON.stringify(toAcp.body)).toBe(200);
    expect(toAcp.body).toEqual({ sessionId: row.id, resumed: true });
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.sessionId,
      (id) => id === cliSession,
    );
    const again = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/prompt`,
      { text: "still remote" },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    await until(
      async () =>
        (
          (await open!.core.call("GET", `/api/acp/sessions/${row.id}/log`))
            .body as { entries: { blocks: { text?: string }[] }[] }
        ).entries.flatMap((entry) => entry.blocks.map((block) => block.text)),
      (texts) => texts.includes("echo: still remote"),
    );
    expect(probed.length).toBe(2);
  });

  it("refuses an SSH node whose host is not registered", async () => {
    open = await acpCore();
    setAcpSshDeps({
      dataDir: open.core.directory,
      host: () => undefined,
      probe: async () => ({}),
    });
    const nodeId = await open.node({ sshHostId: "gone" });
    const refused = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "acp_unsupported" });
  });
});
