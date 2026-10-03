import { afterEach, describe, expect, it } from "vitest";

import { collab } from "../agent";
import { getAgentStatus } from "../agent/status";
import type { WorkspaceEvent } from "../bus";
import { hibernatedSession } from "../terminal/hibernate";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";

/**
 * 同一个节点、两种驱动（ACP 设计 §4.2）与 Eco 休眠的 ACP 分支（§5.3）。
 *
 * 切换与休眠是同一件事的两种用法：结束当前进程，在**同一行**上起下一代，用
 * CLI 自己的会话 id 接回。所以两边断言的都是行 id 不变、代次加一、
 * `agent_status.session_id` 不变。
 */

const unix = process.platform !== "win32";
const describeUnix = unix ? describe : describe.skip;

let open: AcpCore | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

async function firstTurn(core: AcpCore, nodeId: string) {
  const created = await core.core.call("POST", "/api/acp/sessions", {
    workspaceId: core.workspaceId,
    nodeId,
    cwd: core.core.directory,
    agentId: FAKE_AGENT,
    prompt: "remember me",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await until(
    () => getAgentStatus(core.core.database, nodeId)?.state,
    (state) => state === "done",
  );
  return created.body as { id: string; generation: number };
}

describeUnix("switching a node's driver", () => {
  it("ends one driver and resumes the same CLI session under the other, on the same row", async () => {
    open = await acpCore();
    const seen: WorkspaceEvent[] = [];
    open.core.bus.on("workspace.event", ({ event }) => seen.push(event));
    const nodeId = await open.node();
    const row = await firstTurn(open, nodeId);
    const cliSession = getAgentStatus(open.core.database, nodeId)?.sessionId;
    expect(cliSession).toBeDefined();

    // ACP → 终端：适配器收掉，同一行上起 PTY 并敲恢复行。
    const toTerminal = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "terminal" },
    );
    expect(toTerminal.status, JSON.stringify(toTerminal.body)).toBe(200);
    expect(toTerminal.body).toMatchObject({ sessionId: row.id });
    const asTerminal = (await open.core.call("GET", `/api/terminals/${row.id}`))
      .body as { backend: string; generation: number; status: string };
    expect(asTerminal).toMatchObject({
      backend: "direct",
      generation: row.generation + 1,
      status: "running",
    });
    expect(seen.find((event) => event.type === "acp.driver")).toMatchObject({
      nodeId,
      driver: "terminal",
      sessionId: row.id,
    });

    // 终端 → ACP：接回同一个 CLI 会话，镜像还在。
    const toAcp = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "acp" },
    );
    expect(toAcp.status, JSON.stringify(toAcp.body)).toBe(200);
    expect(toAcp.body).toEqual({ sessionId: row.id, resumed: true });
    const asAcp = (await open.core.call("GET", `/api/terminals/${row.id}`))
      .body as { backend: string; generation: number };
    expect(asAcp).toMatchObject({
      backend: "acp",
      generation: row.generation + 2,
    });
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.sessionId,
      (id) => id === cliSession,
    );
    const log = (await open.core.call("GET", `/api/acp/sessions/${row.id}/log`))
      .body as { entries: { blocks: { text?: string }[] }[] };
    expect(
      log.entries.flatMap((entry) => entry.blocks.map((block) => block.text)),
    ).toContain("echo: remember me");

    // 已经是这个驱动：什么都不动。
    const same = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "acp" },
    );
    expect(same.body).toEqual({ sessionId: row.id, resumed: true });
    expect(
      (
        (await open.core.call("GET", `/api/terminals/${row.id}`)).body as {
          generation: number;
        }
      ).generation,
    ).toBe(row.generation + 2);
  });

  it("refuses to switch while an approval is pending", async () => {
    open = await acpCore();
    const nodeId = await open.node();
    await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
      prompt: "[permission]",
    });
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "blocked",
    );
    const refused = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "terminal" },
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "awaiting_approval" });
  });

  it("starts fresh and says so when the CLI session cannot be resumed", async () => {
    open = await acpCore({ minimal: true });
    const nodeId = await open.node({ driver: "terminal" });
    // 一个从没跑过的节点没有 CLI 会话 id：新开，`resumed: false`。
    const switched = await open.core.call(
      "POST",
      `/api/acp/nodes/${nodeId}/driver`,
      { driver: "acp" },
    );
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect(switched.body).toMatchObject({ resumed: false });
  });
});

describeUnix("Eco hibernation of an ACP session", () => {
  it("hibernates an idle session and wakes it on the same row and CLI session", async () => {
    open = await acpCore();
    const nodeId = await open.node();
    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
    });
    const row = created.body as { id: string; generation: number };
    // Agent 身份不碰人类租约：一个人刚发过提示的会话十秒内不睡。
    await collab()!.terminals!.writeSubmit!(
      row.id,
      row.generation,
      "idle soon",
    );
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    const cliSession = getAgentStatus(open.core.database, nodeId)?.sessionId;
    const hibernator = open.terminal.hibernator;
    const record = open.terminal.manager
      .liveRecords()
      .find((candidate) => candidate.id === row.id);
    expect(record?.kind).toBe("acp");
    expect(
      await hibernator.blockers(record!, { enabled: true, idleMinutes: 0 }),
    ).toEqual([]);
    expect(await hibernator.hibernate(record!)).toBe(true);
    expect(hibernatedSession(open.core.database, nodeId)?.sessionId).toBe(
      row.id,
    );
    expect(open.terminal.manager.isAlive(row.id)).toBe(false);

    const woke = await hibernator.wake(nodeId, "delivery");
    expect(woke).toEqual({
      sessionId: row.id,
      generation: row.generation + 1,
    });
    expect(open.terminal.manager.isAlive(row.id)).toBe(true);
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.sessionId,
      (id) => id === cliSession,
    );
    const log = (await open.core.call("GET", `/api/acp/sessions/${row.id}/log`))
      .body as { entries: unknown[] };
    // 回放（session/load）没进镜像第二遍。
    expect(log.entries).toHaveLength(2);
  });
});
