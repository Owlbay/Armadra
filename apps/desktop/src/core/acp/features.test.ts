import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { fakeAcpAgentPath } from "@armadra/agent/acp";
import { afterEach, describe, expect, it } from "vitest";

import { getAgentStatus } from "../agent/status";
import type { WorkspaceEvent } from "../bus";
import { tempDir } from "../testing/temp-dir";
import { acpClientFeatures } from "./client";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";
import { type AcpHostSession, startAcp } from "./host";
import { AcpMirror, mirrorPath } from "./mirror";
import type { AcpSignal } from "./normalize";
import { AcpSession, type AcpSessionSink } from "./session";

/**
 * 契约 §26.1 / §26.2：客户端自报 `elicitation` / `configOptions` 时的那条路。
 * 用的是上游（`@armadra/agent` ≥ 0.6.8）真的 `AcpClient` 与它的假 Agent（真子
 * 进程）：`[elicit]` 发 `elicitation/create`，`--config-options` 答一个模型配置项。
 */

const NODE = "11111111-2222-4333-8444-555555555555";

const sessions: AcpSession[] = [];
const dirs: string[] = [];
let core: AcpCore | undefined;

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.terminate()));
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await core?.stop();
  core = undefined;
});

interface Recorder extends AcpSessionSink {
  readonly signals: { signal: AcpSignal; raw?: unknown }[];
  readonly events: WorkspaceEvent[];
  readonly cancelledIds: string[];
}

function recorder(): Recorder {
  const signals: { signal: AcpSignal; raw?: unknown }[] = [];
  const events: WorkspaceEvent[] = [];
  const cancelledIds: string[] = [];
  return {
    signals,
    events,
    cancelledIds,
    signal: (signal, raw) => signals.push({ signal, raw }),
    publish: (event) => events.push(event),
    cancelled: (pendingId) => cancelledIds.push(pendingId),
    transcriptPath: (_id, mirror) => mirror,
  };
}

async function open(options: { modelId?: string } = {}) {
  const dataDir = tempDir("armadra-acp-features-");
  dirs.push(dataDir);
  const sink = recorder();
  const session = new AcpSession({
    rowId: "row-1",
    generation: 1,
    nodeId: NODE,
    workspaceId: "ws",
    agentId: "claude",
    sink,
    mirrorFor: (id) => new AcpMirror(mirrorPath(dataDir, NODE, id)),
  });
  const host: AcpHostSession = await startAcp({
    program: process.execPath,
    args: [fakeAcpAgentPath(), "--config-options"],
    cwd: tmpdir(),
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
    ...session.callbacks(),
  });
  session.opened(host);
  sessions.push(session);
  return { session, sink, host };
}

const turns = (sink: Recorder) =>
  sink.events.filter((event) => event.type === "acp.turn");

function lastReply(session: AcpSession): string | undefined {
  const entries = new AcpMirror(session.mirrorPath as string).read().entries;
  const last = entries.filter((entry) => entry.role === "assistant").at(-1);
  const block = last?.blocks.at(-1) as { text?: string } | undefined;
  return block?.text;
}

async function elicited(sink: Recorder) {
  const asked = await until(
    () => sink.signals.find((item) => item.signal.signal === "elicitation"),
    (item) => item !== undefined,
  );
  return (asked!.signal as { pendingId: string }).pendingId;
}

describe("the client's optional features", () => {
  it("are read from AcpClient.features", () => {
    expect(acpClientFeatures()).toEqual({
      mcpServers: true,
      elicitation: true,
      configOptions: true,
    });
    expect(acpClientFeatures({})).toEqual({
      mcpServers: false,
      elicitation: false,
      configOptions: false,
    });
  });
});

describe("models (§26.2)", () => {
  it("reads the catalog from the session's configOptions, groups flattened", async () => {
    const { session, host } = await open();
    expect(host.models).toMatchObject({ configId: "model" });
    expect(session.models).toEqual({
      currentModelId: "small",
      availableModels: [
        { modelId: "small", name: "Small" },
        { modelId: "large", name: "Large", description: "slow" },
      ],
    });
  });

  it("sets a model with session/set_config_option and refuses one not offered", async () => {
    const { session, sink } = await open();
    await session.setModel("large");
    expect(session.models?.currentModelId).toBe("large");
    await expect(session.setModel("huge")).rejects.toMatchObject({
      code: "acp_model_unavailable",
    });
    session.prompt("[model]");
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(lastReply(session)).toBe("model large");
  });

  it("applies the node's model when the session opens, and ignores one not offered", async () => {
    const applied = await open({ modelId: "large" });
    expect(applied.host.modelApplied).toBe(true);
    expect(applied.session.models?.currentModelId).toBe("large");
    const ignored = await open({ modelId: "huge" });
    expect(ignored.host.modelApplied).toBe(false);
    expect(ignored.session.models?.currentModelId).toBe("small");
  });
});

describe("elicitation (§26.1)", () => {
  it("holds a request as a pending elicitation and accepts it with checked content", async () => {
    const { session, sink } = await open();
    session.prompt("[elicit]");
    const pendingId = await elicited(sink);
    const asked = sink.signals.find(
      (item) => item.signal.signal === "elicitation",
    );
    expect(asked?.raw).toEqual({
      protocol: "acp",
      elicitation: {
        message: "Pick a color",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            color: { type: "string", enum: ["red", "blue"] },
            count: { type: "integer", minimum: 1 },
          },
          required: ["color"],
        },
      },
    });
    expect(session.owns(pendingId)).toBe(true);
    expect(session.pendingElicitations().map((item) => item.pendingId)).toEqual(
      [pendingId],
    );
    expect(session.pending()).toEqual([]);
    expect(
      session.answerElicitation(pendingId, {
        action: "accept",
        content: { color: "blue", count: 2 },
      }),
    ).toBe(true);
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(lastReply(session)).toBe(
      'elicit: accept {"color":"blue","count":2}',
    );
    expect(sink.cancelledIds).toEqual([]);
    expect(sink.signals.map((item) => item.signal.signal)).toContain(
      "permissionSettled",
    );
    expect(session.pendingElicitations()).toEqual([]);
    // 已经答过的再答不进去。
    expect(session.answerElicitation(pendingId, { action: "decline" })).toBe(
      false,
    );
  });

  it("declines without content", async () => {
    const { session, sink } = await open();
    session.prompt("[elicit]");
    const pendingId = await elicited(sink);
    expect(session.answerElicitation(pendingId, { action: "decline" })).toBe(
      true,
    );
    await until(
      () => turns(sink).length,
      (count) => count === 1,
    );
    expect(lastReply(session)).toBe("elicit: decline null");
  });

  it("answers cancel when the turn is cancelled, and when the adapter goes away", async () => {
    const first = await open();
    first.session.prompt("[elicit]");
    const pendingId = await elicited(first.sink);
    await first.session.cancel();
    await until(
      () => turns(first.sink).length,
      (count) => count === 1,
    );
    expect(first.sink.cancelledIds).toEqual([pendingId]);
    expect(turns(first.sink)[0]).toMatchObject({ stopReason: "cancelled" });

    const second = await open();
    second.session.prompt("[elicit]");
    const gone = await elicited(second.sink);
    await second.session.terminate();
    await until(
      () => second.sink.cancelledIds.length,
      (count) => count === 1,
    );
    expect(second.sink.cancelledIds).toEqual([gone]);
  });
});

describe("the routes with the features (§26)", () => {
  function events(open: AcpCore): WorkspaceEvent[] {
    const seen: WorkspaceEvent[] = [];
    open.core.bus.on("workspace.event", ({ event }) => {
      seen.push(event);
    });
    return seen;
  }

  async function started(open: AcpCore) {
    const nodeId = await open.node();
    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return { nodeId, rowId: (created.body as { id: string }).id };
  }

  it("lists the models with the log and sets one with PUT …/model", async () => {
    core = await acpCore({ configOptions: true });
    const { rowId } = await started(core);
    const log = await core.core.call("GET", `/api/acp/sessions/${rowId}/log`);
    expect((log.body as { models: unknown }).models).toEqual({
      currentModelId: "small",
      availableModels: [
        { modelId: "small", name: "Small" },
        { modelId: "large", name: "Large", description: "slow" },
      ],
    });
    const set = await core.core.call(
      "PUT",
      `/api/acp/sessions/${rowId}/model`,
      { modelId: "large" },
    );
    expect(set.status, JSON.stringify(set.body)).toBe(204);
    const after = await core.core.call("GET", `/api/acp/sessions/${rowId}/log`);
    expect(
      (after.body as { models: { currentModelId: string } }).models
        .currentModelId,
    ).toBe("large");
    const unknown = await core.core.call(
      "PUT",
      `/api/acp/sessions/${rowId}/model`,
      { modelId: "huge" },
    );
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ code: "acp_model_unavailable" });
    const missing = await core.core.call(
      "PUT",
      `/api/acp/sessions/${rowId}/model`,
      {},
    );
    expect(missing.status).toBe(400);
  });

  it("records an elicitation as an approval, checks the answer and never stores the content", async () => {
    core = await acpCore({ configOptions: true });
    const seen = events(core);
    const { nodeId, rowId } = await started(core);
    const prompt = await core.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "[elicit]" },
    );
    expect(prompt.status).toBe(200);
    const asked = await until(
      () =>
        seen.find(
          (event) =>
            event.type === "agent.approval" &&
            (event.request as { resolved?: boolean }).resolved !== true,
        ),
      (event) => event !== undefined,
    );
    const pendingId = (asked as { pendingId: string }).pendingId;
    expect(pendingId).toMatch(new RegExp(`^${nodeId}-\\d+-acp-\\d+$`));
    const record = (asked as { request: { request: unknown } }).request
      .request as { protocol: string; elicitation: { message: string } };
    expect(record.protocol).toBe("acp");
    expect(record.elicitation.message).toBe("Pick a color");
    await until(
      () => getAgentStatus(core!.core.database, nodeId),
      (status) => status?.state === "waiting",
    );
    expect(getAgentStatus(core.core.database, nodeId)).toMatchObject({
      state: "waiting",
      pendingId,
    });
    const log = await core.core.call("GET", `/api/acp/sessions/${rowId}/log`);
    expect(
      (log.body as { elicitations: { pendingId: string }[] }).elicitations,
    ).toMatchObject([{ pendingId, protocol: "acp" }]);

    const answer = (body: unknown) =>
      core!.core.call("POST", `/api/approvals/${pendingId}/answer`, body);
    // 不合表单：缺必填、类型不对、表单外的字段、optionId。
    for (const bad of [
      { elicitation: { action: "accept", content: {} } },
      { elicitation: { action: "accept", content: { color: "green" } } },
      { elicitation: { action: "accept", content: { color: "red", x: 1 } } },
      { elicitation: { action: "decline", content: { color: "red" } } },
      { elicitation: { action: "maybe" } },
      { decision: "allow" },
      {
        decision: "deny",
        elicitation: { action: "accept", content: { color: "red" } },
      },
      { decision: "allow", optionId: "allow" },
    ]) {
      const refused = await answer(bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    const accepted = await answer({
      elicitation: { action: "accept", content: { color: "blue", count: 3 } },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body).toMatchObject({
      answer: "allow",
      route: "acp",
      elicitation: { action: "accept" },
    });
    await until(
      () => seen.filter((event) => event.type === "acp.turn"),
      (turns) => turns.length > 0,
    );
    const resolved = seen.find(
      (event) =>
        event.type === "agent.approval" &&
        (event.request as { resolved?: boolean }).resolved === true,
    );
    expect(resolved).toMatchObject({
      request: { decision: "allow", elicitation: { action: "accept" } },
    });
    expect(JSON.stringify(resolved)).not.toContain('"count":3');
    // 内容只交给了 Agent：审批行、审计都没有它。
    const rows = core.core.database
      .prepare(
        "SELECT a.request_json AS request, a.answer AS answer FROM agent_approvals a WHERE a.id = ?",
      )
      .get(pendingId) as { request: string; answer: string };
    expect(rows.answer).toBe("allow");
    expect(rows.request).not.toContain('"count":3');
    const audit = core.core.database
      .prepare(
        "SELECT decision, refusal FROM agent_approval_audit WHERE approval_id = ? ORDER BY rowid",
      )
      .all(pendingId) as { decision: string; refusal: string }[];
    expect(audit.at(-1)).toEqual({ decision: "allow", refusal: "" });
    expect(audit.map((row) => row.refusal)).toContain("elicitation_invalid");
    expect(JSON.stringify(audit)).not.toContain('"count":3');
    const mirror = readFileSync(
      (
        getAgentStatus(core.core.database, nodeId) as {
          transcriptPath: string;
        }
      ).transcriptPath,
      "utf8",
    );
    expect(mirror).toContain("elicit: accept");
    // 答过的不能再答。
    const again = await answer({ elicitation: { action: "decline" } });
    expect(again.status).toBe(409);
    expect(getAgentStatus(core.core.database, nodeId)?.state).toBe("done");
  });

  it("lets the header's deny button decline an elicitation", async () => {
    core = await acpCore({ configOptions: true });
    const seen = events(core);
    const { rowId } = await started(core);
    await core.core.call("POST", `/api/acp/sessions/${rowId}/prompt`, {
      text: "[elicit]",
    });
    const asked = await until(
      () =>
        seen.find(
          (event) =>
            event.type === "agent.approval" &&
            (event.request as { resolved?: boolean }).resolved !== true,
        ),
      (event) => event !== undefined,
    );
    const pendingId = (asked as { pendingId: string }).pendingId;
    const denied = await core.core.call(
      "POST",
      `/api/approvals/${pendingId}/answer`,
      { decision: "deny" },
    );
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    expect(denied.body).toMatchObject({
      answer: "deny",
      route: "acp",
      elicitation: { action: "decline" },
    });
  });

  it("refuses to switch drivers while an elicitation waits, and cancels it on cancel", async () => {
    core = await acpCore({ configOptions: true });
    const seen = events(core);
    const { nodeId, rowId } = await started(core);
    await core.core.call("POST", `/api/acp/sessions/${rowId}/prompt`, {
      text: "[elicit]",
    });
    const asked = await until(
      () =>
        seen.find(
          (event) =>
            event.type === "agent.approval" &&
            (event.request as { resolved?: boolean }).resolved !== true,
        ),
      (event) => event !== undefined,
    );
    const pendingId = (asked as { pendingId: string }).pendingId;
    await until(
      () => getAgentStatus(core!.core.database, nodeId)?.state,
      (state) => state === "waiting",
    );
    const switched = await core.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "terminal" },
    );
    expect(switched.status).toBe(409);
    expect(switched.body).toMatchObject({ code: "awaiting_approval" });
    const cancel = await core.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/cancel`,
    );
    expect(cancel.status).toBe(204);
    const row = await until(
      () =>
        core!.core.database
          .prepare(
            "SELECT answer, answered_by FROM agent_approvals WHERE id = ?",
          )
          .get(pendingId) as { answer: string | null; answered_by: string },
      (value) => value.answer !== null,
    );
    expect(row).toEqual({ answer: "cancelled", answered_by: "core" });
  });
});
