import { afterEach, describe, expect, it } from "vitest";

import { collab } from "../agent";
import { getAgentStatus } from "../agent/status";
import type { WorkspaceEvent } from "../bus";
import { agentActor } from "../drive/lease";
import { submittedText } from "./bridge";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";

/**
 * 终端桥的 ACP 实现（ACP 设计 §5.6）：协作域、调度、依赖编排写的都是
 * `TerminalBridge`，所以 `send` 的门链、租约、回执一行不改——这里断言每个原语
 * 在 ACP 会话上落到了协议的哪一步。
 */

let open: AcpCore | undefined;

afterEach(async () => {
  await open?.stop();
  open = undefined;
});

async function started(core: AcpCore) {
  const nodeId = await core.node();
  const created = await core.core.call("POST", "/api/acp/sessions", {
    workspaceId: core.workspaceId,
    nodeId,
    cwd: core.core.directory,
    agentId: FAKE_AGENT,
  });
  const row = created.body as { id: string; generation: number };
  return { nodeId, row };
}

describe("submittedText", () => {
  it("reads the bracketed paste a writeSubmit writes, and nothing else", () => {
    expect(submittedText("\u001b[200~hi\nthere\u001b[201~\r")).toBe(
      "hi\nthere",
    );
    expect(submittedText("hi\r")).toBeUndefined();
    expect(submittedText("\u001b[200~hi\u001b[201~")).toBeUndefined();
  });
});

describe("the ACP terminal bridge", () => {
  it("turns writeSubmit into a prompt, ESC into a cancel and capture into the mirror", async () => {
    open = await acpCore();
    const seen: WorkspaceEvent[] = [];
    open.core.bus.on("workspace.event", ({ event }) => seen.push(event));
    const { nodeId, row } = await started(open);
    const bridge = collab()?.terminals;
    expect(bridge).toBeDefined();

    // 门链问的那一句：活着的会话、代次、五态。
    expect(bridge!.generation(row.id)).toBe(row.generation);
    expect(
      await bridge!.isCurrentNodeSession(nodeId, row.id, row.generation),
    ).toBe(true);
    // 前台门：适配器在前，它驱动的 CLI 以门认得的名字列在下面。
    expect(await bridge!.foreground(row.id)).toMatchObject({
      command: process.execPath,
      children: ["opencode"],
    });

    // `send` 的投递：Agent 身份的 writeSubmit = 一次 session/prompt，信封原样。
    const envelope = "--- ARMADRA MESSAGE ---\nfrom a peer\n---";
    await bridge!.writeSubmit!(
      row.id,
      row.generation,
      envelope,
      agentActor("source-node", "source-session", "Peer"),
    );
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    const capture = await bridge!.capture(row.id, 20, false);
    expect(capture.data).toContain("from a peer");
    expect(capture.data).toContain("echo: --- ARMADRA MESSAGE ---");

    // ESC：打断这一轮（`interrupt` 动词、节点头按钮、send --interrupt）。
    await bridge!.writeSubmit!(row.id, row.generation, "wait [slow]");
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "working",
    );
    await bridge!.write(row.id, row.generation, "\u001b");
    await until(
      () => getAgentStatus(open!.core.database, nodeId),
      (status) => status?.state === "done" && status.interrupted === true,
    );

    // 半截输入在 ACP 下不存在。
    await expect(
      bridge!.write(row.id, row.generation, "y\r"),
    ).rejects.toMatchObject({ code: "acp_no_raw_write" });

    // 五态投影：跑完一轮之后空闲，来源是上报。
    expect(bridge!.driveTarget!(nodeId)).toMatchObject({
      sessionId: row.id,
      state: "idle",
      stateSource: "acp",
    });
  });

  it("keeps an agent out while a person holds the session", async () => {
    open = await acpCore();
    const { nodeId, row } = await started(open);
    const bridge = collab()?.terminals;
    // 会话视图的输入框聚焦 = 接管（PromptBox 调的就是这条路由）。
    const taken = await open.core.call(
      "POST",
      `/api/terminals/${row.id}/drive`,
      { action: "takeover" },
    );
    expect(taken.status).toBe(200);
    expect(bridge!.driveTarget!(nodeId).lease.holder?.kind).toBe("human");
    await expect(
      bridge!.writeSubmit!(
        row.id,
        row.generation,
        "should queue",
        agentActor("source-node", "source-session", "Peer"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    // 人自己发的照样进去（人在自己的会话里打字永不被拒）。
    const prompt = await open.core.call(
      "POST",
      `/api/acp/sessions/${row.id}/prompt`,
      { text: "mine" },
    );
    expect(prompt.status).toBe(200);
    await open.core.call("POST", `/api/terminals/${row.id}/drive`, {
      action: "release",
    });
    await until(
      () => getAgentStatus(open!.core.database, nodeId)?.state,
      (state) => state === "done",
    );
    expect(bridge!.driveTarget!(nodeId).lease.state).toBe("free");
  });
});
