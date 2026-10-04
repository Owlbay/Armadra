import { afterEach, describe, expect, it } from "vitest";

import { getAgentStatus } from "../agent/status";
import type { WorkspaceEvent } from "../bus";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";

/**
 * `/api/acp/*`（契约 §14.2–§14.4），对着真管理器与假 ACP Agent（真子进程）。
 * 每条断言都落在**同一套** core 语义上：会话是 `terminal_sessions` 的一行，
 * 状态进 `agent_status`（来源 `acp`），审批进 `agent_approvals`，提示走人类
 * 租约。
 */

let open: AcpCore | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

function events(core: AcpCore): WorkspaceEvent[] {
  const seen: WorkspaceEvent[] = [];
  core.core.bus.on("workspace.event", ({ event }) => {
    seen.push(event);
  });
  return seen;
}

async function session(core: AcpCore, nodeId: string, prompt?: string) {
  const created = await core.core.call("POST", "/api/acp/sessions", {
    workspaceId: core.workspaceId,
    nodeId,
    cwd: core.core.directory,
    agentId: FAKE_AGENT,
    ...(prompt === undefined ? {} : { prompt }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as {
    id: string;
    backend: string;
    generation: number;
    status: string;
  };
}

describe("the ACP session routes", () => {
  it("opens a session as a terminal row, runs a turn and mirrors it", async () => {
    open = await acpCore();
    const seen = events(open);
    const nodeId = await open.node();
    const row = await session(open, nodeId, "hello there");
    expect(row).toMatchObject({ backend: "acp", status: "running" });

    // 回合结束：`acp.turn` 一帧，状态 done、来源 acp。
    await until(
      () => seen.filter((event) => event.type === "acp.turn"),
      (turns) => turns.length > 0,
    );
    const turn = seen.find((event) => event.type === "acp.turn");
    expect(turn).toMatchObject({
      sessionId: row.id,
      nodeId,
      stopReason: "end_turn",
    });
    const status = getAgentStatus(open.core.database, nodeId);
    expect(status).toMatchObject({ state: "done", stateSource: "acp" });
    expect(status?.sessionId).toMatch(/^fake-/);

    // 镜像先于事件：页面读到的就是那一轮。
    const log = await open.core.call("GET", `/api/acp/sessions/${row.id}/log`);
    expect(log.status).toBe(200);
    const body = log.body as {
      entries: { role: string; blocks: { type: string; text?: string }[] }[];
      endOffset: number;
      modes: { currentModeId: string } | null;
      pending: unknown[];
    };
    expect(body.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(body.entries[1]?.blocks[0]?.text).toBe("echo: hello there");
    expect(body.endOffset).toBeGreaterThan(0);
    expect(body.modes?.currentModeId).toBe("default");
    expect(body.pending).toEqual([]);

    // 增量读：从末尾读什么都没有。
    const after = await open.core.call(
      "GET",
      `/api/acp/sessions/${row.id}/log?after=${body.endOffset}`,
    );
    expect((after.body as { entries: unknown[] }).entries).toEqual([]);

    // 一个节点只有一个活会话：再起一次答同一行。
    const again = await session(open, nodeId);
    expect(again.id).toBe(row.id);

    // 没有 PTY 可附着。
    const update = seen.find((event) => event.type === "acp.update");
    expect(update).toMatchObject({ sessionId: row.id, nodeId });
  });

  it("asks for permission through agent_approvals and answers with the chosen option", async () => {
    open = await acpCore();
    const seen = events(open);
    const nodeId = await open.node();
    const row = await session(open, nodeId);
    const prompt = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/prompt`,
      { text: "write it [permission]" },
    );
    expect(prompt.status, JSON.stringify(prompt.body)).toBe(200);
    expect((prompt.body as { turnId: string }).turnId).not.toBe("");

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
    expect(getAgentStatus(open.core.database, nodeId)).toMatchObject({
      state: "blocked",
      pendingId,
    });
    const request = (asked as { request: { request: unknown } }).request
      .request as { protocol: string; options: { optionId: string }[] };
    expect(request.protocol).toBe("acp");
    expect(request.options.map((option) => option.optionId)).toEqual([
      "allow",
      "always",
      "reject",
      "never",
    ]);

    // 重载：`…/log` 带着这张卡。
    const log = (await open.core.call("GET", `/api/acp/sessions/${row.id}/log`))
      .body as { pending: { pendingId: string }[] };
    expect(log.pending.map((item) => item.pendingId)).toEqual([pendingId]);

    // 选项与决定不符：400，什么都没记。
    const mismatch = await open.core.call(
      "POST",
      `/api/approvals/${pendingId}/answer`,
      { decision: "allow", optionId: "reject" },
    );
    expect(mismatch.status).toBe(400);

    const answered = await open.core.call(
      "POST",
      `/api/approvals/${pendingId}/answer`,
      { decision: "deny", optionId: "reject" },
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body).toMatchObject({ answer: "deny", route: "acp" });

    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    const mirror = (
      await open.core.call("GET", `/api/acp/sessions/${row.id}/log`)
    ).body as { entries: { blocks: { type: string; text?: string }[] }[] };
    const texts = mirror.entries.flatMap((entry) =>
      entry.blocks.map((block) => block.text ?? block.type),
    );
    expect(texts).toContain("write rejected");
  });

  it("answers the header's plain allow with the first allow option", async () => {
    open = await acpCore();
    const seen = events(open);
    const nodeId = await open.node();
    const row = await session(open, nodeId, "[permission]");
    const asked = await until(
      () => seen.find((event) => event.type === "agent.approval"),
      (event) => event !== undefined,
    );
    const pendingId = (asked as { pendingId: string }).pendingId;
    const answered = await open.core.call(
      "POST",
      `/api/approvals/${pendingId}/answer`,
      { decision: "allow" },
    );
    expect(answered.body).toMatchObject({ route: "acp" });
    await until(
      () => seen.filter((event) => event.type === "acp.turn").length,
      (count) => count > 0,
    );
    const log = (await open.core.call("GET", `/api/acp/sessions/${row.id}/log`))
      .body as { entries: { blocks: { text?: string }[] }[] };
    expect(
      log.entries.flatMap((entry) => entry.blocks.map((block) => block.text)),
    ).toContain("wrote note.txt");
  });

  it("cancels a turn and settles its pending approval as cancelled by core", async () => {
    open = await acpCore();
    const seen = events(open);
    const nodeId = await open.node();
    const row = await session(open, nodeId, "[permission]");
    const asked = await until(
      () => seen.find((event) => event.type === "agent.approval"),
      (event) => event !== undefined,
    );
    const pendingId = (asked as { pendingId: string }).pendingId;
    const cancelled = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/cancel`,
    );
    expect(cancelled.status).toBe(204);
    const turn = await until(
      () => seen.find((event) => event.type === "acp.turn"),
      (event) => event !== undefined,
    );
    expect(turn).toMatchObject({ stopReason: "cancelled" });
    const approval = open.core.database
      .prepare("SELECT answer, answered_by FROM agent_approvals WHERE id = ?")
      .get(pendingId);
    expect(approval).toEqual({ answer: "cancelled", answered_by: "core" });
    expect(getAgentStatus(open.core.database, nodeId)).toMatchObject({
      state: "done",
      interrupted: true,
    });
    // 已经结束的审批不能再答。
    const late = await open.core.call(
      "POST",
      `/api/approvals/${pendingId}/answer`,
      { decision: "allow" },
    );
    expect(late.status).toBe(409);
  });

  it("switches the mode, refuses raw keystrokes and refuses to attach", async () => {
    open = await acpCore();
    const nodeId = await open.node();
    const row = await session(open, nodeId);
    const mode = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/mode`,
      { modeId: "plan" },
    );
    expect(mode.status).toBe(204);
    const missing = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/mode`,
      { modeId: "nope" },
    );
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ code: "acp_mode_unavailable" });
    const log = (await open.core.call("GET", `/api/acp/sessions/${row.id}/log`))
      .body as { modes: { currentModeId: string } };
    expect(log.modes.currentModeId).toBe("plan");

    const paste = await open.core.call(
      "POST",
      `/api/terminals/${row.id}/paste`,
      { text: "half a line", enter: false },
    );
    expect(paste.status).toBe(409);
    expect(paste.body).toMatchObject({ code: "acp_no_raw_write" });
  });

  it("opens a session for a node the canvas has not saved yet (the new-agent wizard)", async () => {
    open = await acpCore();
    const seen = events(open);
    const nodeId = "99999999-2222-4333-8444-555555555555";
    const row = await session(open, nodeId, "first task");
    expect(row).toMatchObject({ backend: "acp", status: "running" });
    await until(
      () => seen.filter((event) => event.type === "acp.turn").length,
      (count) => count > 0,
    );
    expect(getAgentStatus(open.core.database, nodeId)).toMatchObject({
      state: "done",
      stateSource: "acp",
      workspaceId: open.workspaceId,
    });
  });

  it("refuses an agent without an ACP entry point", async () => {
    open = await acpCore();
    const nodeId = await open.node();
    const refused = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: "custom:nobody",
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "acp_unsupported" });
  });

  it("brings an ended session back on the same row with the same ACP session", async () => {
    open = await acpCore();
    const nodeId = await open.node();
    const row = await session(open, nodeId, "first");
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    const sessionId = getAgentStatus(open.core.database, nodeId)?.sessionId;
    // 像 core 重启之后那样：行结束了，进程没了。
    await open.terminal.manager.terminate(row.id, "session");
    const prompt = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/prompt`,
      { text: "second" },
    );
    expect(prompt.status, JSON.stringify(prompt.body)).toBe(200);
    const revived = (await open.core.call("GET", `/api/terminals/${row.id}`))
      .body as { status: string; generation: number };
    expect(revived).toMatchObject({ status: "running", generation: 2 });
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    expect(getAgentStatus(open.core.database, nodeId)?.sessionId).toBe(
      sessionId,
    );
    const log = (await open.core.call("GET", `/api/acp/sessions/${row.id}/log`))
      .body as { entries: { role: string }[] };
    // 同一份镜像：两轮都在，回放（session/load）没有重复写进去。
    expect(log.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("has no model choice while the client lacks configOptions (§26.2)", async () => {
    // `@armadra/agent` 0.6.7 的客户端不自报 `configOptions`：与之前一样，没有
    // 目录、改不了模型，日志里也没有挂起的 elicitation。
    open = await acpCore();
    const nodeId = await open.node();
    const row = await session(open, nodeId);
    const log = await open.core.call("GET", `/api/acp/sessions/${row.id}/log`);
    expect(log.body).toMatchObject({ models: null, elicitations: [] });
    const set = await open.core.call(
      "PUT",
      `/api/acp/sessions/${row.id}/model`,
      { modelId: "anything" },
    );
    expect(set.status).toBe(409);
    expect(set.body).toMatchObject({ code: "acp_model_unavailable" });
  });
});
