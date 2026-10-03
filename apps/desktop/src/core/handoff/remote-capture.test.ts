/**
 * 跨执行主机交接（契约 §21.1）：来源 Agent 在一台别的执行主机的 SSH 终端里，
 * 转录经那台主机的 Worker 读，`capturedOn` 记主机 id；主机不在登记里、没有
 * Worker 或连不上，一律 501 `handoff_host_offline`。
 *
 * 与 `remote.test.ts` 同一个办法：core 的真入口打成包，本机子进程跑
 * `worker --stdio`（进程内的假 ssh，没有 sshd）。工作空间留在本机。
 */

import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { type AgentFixture, agentFixture } from "../agent/fixture";
import { setRemoteCaller } from "../remote/execute";
import { handoffCapture } from "../remote/handoff-worker";
import { RemoteWorker } from "../remote/worker";
import { disposeWorkerBundle, spawnWorker } from "../remote/worker.fixture";
import type { SshHost } from "../settings/ssh-hosts";
import { tempDir } from "../testing/temp-dir";
import { EMPTY_SECTIONS } from "./bundle";
import {
  HANDOFF_HOST_OFFLINE,
  setCaptureHosts,
  tailOf,
} from "./remote-capture";
import { prepare } from "./store";

const HOST: SshHost = {
  id: "far",
  name: "far",
  host: "far.example",
  worker: { path: "/opt/armadra/bin/armadra-core" },
};

let start: () => ChildProcess;

beforeAll(async () => {
  start = await spawnWorker();
}, 120_000);

afterAll(() => {
  setRemoteCaller(undefined);
  setCaptureHosts(undefined);
  disposeWorkerBundle();
});

describe("a handoff from an SSH Agent on another execution host", () => {
  let fixture: AgentFixture;
  let remote: RemoteWorker;
  let source: string;
  let target: string;
  let sourceSession: string;
  let targetSession: string;
  let transcript: string;
  const operations: string[] = [];
  let hosts: Map<string, SshHost>;

  const request = (overrides: Record<string, unknown> = {}) =>
    ({
      sourceNodeId: source,
      sourceSessionId: sourceSession,
      sourceGeneration: 1,
      targetNodeId: target,
      targetSessionId: targetSession,
      targetGeneration: 1,
      sections: { ...EMPTY_SECTIONS, goal: "finish the port" },
      filePaths: [],
      byteBudget: 8192,
      includeTranscript: true,
      ...overrides,
    }) as never;

  const setHost = (nodeId: string, hostId: string): void => {
    fixture.database
      .prepare(
        "UPDATE nodes SET data_json = json_set(data_json, '$.ssh', json(?)) WHERE id = ?",
      )
      .run(JSON.stringify({ hostId }), nodeId);
  };

  beforeEach(() => {
    operations.length = 0;
    fixture = agentFixture();
    source = fixture.agentNode("Source");
    target = fixture.agentNode("Target", "codex");
    fixture.link(source, target);
    sourceSession = fixture.session(source, "claude");
    targetSession = fixture.session(target, "codex");
    setHost(source, HOST.id);
    // 「那台主机」上的转录：假 ssh 就是这台机器，路径只在 Worker 那边读。
    transcript = join(tempDir("armadra-far-history-"), "session.jsonl");
    writeFileSync(
      transcript,
      '{"type":"user","message":{"role":"user","content":"把远端那块迁完"}}\n',
    );
    fixture.database
      .prepare(
        "INSERT INTO agent_status (node_id, workspace_id, agent_id, state, unread, verified, restored, " +
          "updated_at, session_id, transcript_path) VALUES (?, ?, 'claude', 'done', 0, 1, 0, ?, 'far-session', ?)",
      )
      .run(source, fixture.workspaceId, new Date().toISOString(), transcript);
    hosts = new Map([[HOST.id, HOST]]);
    setCaptureHosts((hostId) => hosts.get(hostId));
    remote = new RemoteWorker({
      dataDir: "/nonexistent",
      host: HOST,
      worker: HOST.worker as NonNullable<SshHost["worker"]>,
      askpass: {} as never,
      version: "0.1.0",
      spawn: start,
      node: async () => ({
        version: "v24.0.0",
        major: 24,
        usable: true,
        detail: "",
      }),
    });
    setRemoteCaller(async (hostId, operation, payload, replay) => {
      operations.push(`${hostId}:${operation}`);
      return await remote.request(operation, payload, replay);
    });
  });

  afterEach(() => {
    setRemoteCaller(undefined);
    setCaptureHosts(undefined);
    remote.close();
    fixture.close();
  });

  it("reads the transcript on the source's host and says where", async () => {
    const view = await prepare(fixture.collab, fixture.workspaceId, request());
    expect(operations).toEqual(["far:handoff.capture"]);
    expect(view.bundle.capturedOn).toBe("far");
    expect(view.bundle.source.executionHost).toBe("execution-host:far");
    expect(view.bundle.target.executionHost).toBe("local-runtime");
    expect(view.bundle.transcriptExcerpt).toContain("把远端那块迁完");
    expect(view.bundle.budget.omitted).not.toContain(
      "noGenerationBoundTranscript",
    );
    // 文件与仓库仍在工作空间那边（本机）读：远端只答了转录。
    expect(view.bundle.cutoff.kind).toBe("transcriptBytes");
  });

  it("answers handoff_host_offline when the Worker cannot be reached", async () => {
    setRemoteCaller(async () => {
      throw Object.assign(new Error("执行主机 far 的 Worker 连接断开了"), {
        status: 503,
        code: "unavailable",
      });
    });
    await expect(
      prepare(fixture.collab, fixture.workspaceId, request()),
    ).rejects.toMatchObject({ status: 501, code: HANDOFF_HOST_OFFLINE });
  });

  it("answers handoff_host_offline for a host that is not an execution host", async () => {
    hosts.clear();
    await expect(
      prepare(fixture.collab, fixture.workspaceId, request()),
    ).rejects.toMatchObject({ status: 501, code: HANDOFF_HOST_OFFLINE });
    hosts.set(HOST.id, { ...HOST, worker: undefined });
    await expect(
      prepare(fixture.collab, fixture.workspaceId, request()),
    ).rejects.toMatchObject({ status: 501, code: HANDOFF_HOST_OFFLINE });
    expect(operations).toEqual([]);
  });

  it("needs no host when no transcript is read, and takes a target anywhere", async () => {
    hosts.clear();
    setHost(target, "elsewhere");
    const view = await prepare(
      fixture.collab,
      fixture.workspaceId,
      request({ includeTranscript: false }),
    );
    expect(operations).toEqual([]);
    expect(view.bundle.capturedOn).toBeUndefined();
    expect(view.bundle.target.executionHost).toBe("execution-host:elsewhere");
  });

  it("a local source still reads its transcript here, without capturedOn", async () => {
    fixture.database
      .prepare(
        "UPDATE nodes SET data_json = json_remove(data_json, '$.ssh') WHERE id = ?",
      )
      .run(source);
    const view = await prepare(fixture.collab, fixture.workspaceId, request());
    expect(operations).toEqual([]);
    expect(view.bundle.capturedOn).toBeUndefined();
    expect(view.bundle.transcriptExcerpt).toContain("把远端那块迁完");
  });
});

describe("handoff.capture on the Worker", () => {
  it("reads only the transcript when asked to", () => {
    const root = tempDir("armadra-capture-only-");
    const path = join(root, "session.jsonl");
    writeFileSync(path, '{"type":"user","message":"hi"}\n');
    writeFileSync(join(root, "a.txt"), "x");
    const captured = handoffCapture("/", {
      paths: ["a.txt"],
      executionHost: "execution-host:far",
      transcriptOnly: true,
      transcript: { provider: "claude", path },
    });
    expect(captured.files).toEqual([]);
    expect(captured.git.status).toBe("unavailable");
    expect(captured.transcript).toEqual({
      state: "read",
      text: '{"type":"user","message":"hi"}\n',
    });
    const full = handoffCapture(root, {
      paths: ["a.txt"],
      executionHost: "execution-host:far",
    });
    expect(full.files.map((file) => file.status)).toEqual(["referenced"]);
  });

  it("takes only the three answer shapes from a Worker", () => {
    expect(tailOf({ transcript: { state: "read", text: "x" } })).toEqual({
      state: "read",
      text: "x",
    });
    expect(tailOf({ transcript: { state: "unreadable" } })).toEqual({
      state: "unreadable",
    });
    expect(tailOf({ transcript: { state: "read", text: 3 } })).toEqual({
      state: "missing",
    });
    expect(tailOf(null)).toEqual({ state: "missing" });
    expect(
      tailOf({ transcript: { state: "read", text: "x".repeat(600 * 1024) } }),
    ).toEqual({ state: "unreadable" });
  });
});
