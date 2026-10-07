import { appendFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { coalesce, readMirrorEntries } from "../history/acp-mirror";
import { locateHistory, readHistoryEntries } from "../history/registry";
import { tempDir } from "../testing/temp-dir";
import { AcpMirror, IMAGE_LIMIT, mirrorPath } from "./mirror";

/**
 * 镜像（ACP 设计 §5.7）：逐块写、读时合并；连线读取经 `history/registry` 先认
 * 后缀；目录 0700、文件 0600。
 */

const NODE = "11111111-2222-4333-8444-555555555555";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function mirror(id = "s-1"): AcpMirror {
  const dir = tempDir("armadra-acp-mirror-");
  dirs.push(dir);
  return new AcpMirror(mirrorPath(dir, NODE, id));
}

describe("the ACP mirror", () => {
  it("records prompts, replies, tool calls and their final results", () => {
    const m = mirror();
    expect(m.empty).toBe(true);
    m.prompt("do it");
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "on " },
    });
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "it" },
    });
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "npm test" },
    });
    // 进行中不记，终态记一次。
    expect(
      m.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "in_progress",
      }),
    ).toBe(false);
    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(
      m.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
      }),
    ).toBe(false);
    // 活回合里的用户回显、计划与思考不进镜像。
    expect(
      m.update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "do it" },
      }),
    ).toBe(false);
    expect(m.update({ sessionUpdate: "plan", entries: [] })).toBe(false);

    const { entries, endOffset } = m.read();
    expect(entries.map((entry) => [entry.role, entry.blocks[0]?.type])).toEqual(
      [
        ["user", "text"],
        ["assistant", "text"],
        ["assistant", "tool_use"],
        ["user", "tool_result"],
      ],
    );
    // 逐块写下的那段回复读回来是一条。
    expect(entries[1]?.blocks[0]).toEqual({ type: "text", text: "on it" });
    expect(entries[3]?.blocks[0]).toEqual({
      type: "tool_result",
      id: "c1",
      content: "ok",
    });
    expect(endOffset).toBe(m.size);
    expect(m.capture(2)).toContain("ok");

    if (process.platform !== "win32") {
      expect(statSync(m.path).mode & 0o777).toBe(0o600);
      expect(statSync(m.path.replace(/\/[^/]+$/, "")).mode & 0o777).toBe(0o700);
    }
  });

  it("reads a range from a record boundary and leaves a half-written line for later", () => {
    const m = mirror();
    m.prompt("one");
    const first = m.size;
    m.prompt("two");
    appendFileSync(m.path, '{"role":"assistant","blocks":[{"type":"te');
    const range = readMirrorEntries(m.path, first, 1 << 20);
    expect(range.entries).toHaveLength(1);
    expect(range.startOffset).toBe(first);
    expect(range.endOffset).toBeLessThan(m.size);
    // 落在行中间的偏移：跳过半行。
    expect(readMirrorEntries(m.path, first + 3, 1 << 20).entries).toHaveLength(
      0,
    );
  });

  it("merges only adjacent text replies", () => {
    const merged = coalesce([
      {
        role: "assistant",
        blocks: [{ type: "text", text: "a" }],
        endOffset: 1,
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "b" }],
        endOffset: 2,
      },
      { role: "user", blocks: [{ type: "text", text: "c" }], endOffset: 3 },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "d" }],
        endOffset: 4,
      },
    ]);
    expect(merged.map((entry) => entry.endOffset)).toEqual([2, 3, 4]);
  });

  it("is what the context-link readers get for a node whose transcript is the mirror", () => {
    const m = mirror("copilot-session");
    m.prompt("summarise");
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    });
    // Claude 有自己的历史适配器；镜像的后缀先认，不交给它。
    const located = locateHistory({
      agentId: "claude",
      transcriptPath: m.path,
    });
    expect(located?.path).toBe(m.path);
    const range = readHistoryEntries("claude", located!, 0, 1 << 20);
    expect(range.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("keeps images, resource links and diffs for the session view only (§49)", () => {
    const m = mirror();
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", mimeType: "image/png", data: "aGk=" },
    });
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        mimeType: "image/png",
        data: "x".repeat(IMAGE_LIMIT + 1),
      },
    });
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "file:///w/src/a.ts",
        name: "a.ts",
        mimeType: "text/x-typescript",
      },
    });
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource",
        resource: { uri: "file:///w/b.md", text: "inline body" },
      },
    });
    m.update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource",
        resource: { uri: "file:///w/c%20d.bin", blob: "AAAA" },
      },
    });
    m.update({
      sessionUpdate: "tool_call",
      toolCallId: "e1",
      title: "Edit a.ts",
      kind: "edit",
      locations: [{ path: "/w/src/a.ts", line: 3 }],
      content: [
        { type: "diff", path: "/w/src/a.ts", oldText: "a", newText: "b" },
      ],
    });
    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "e1",
      status: "completed",
    });

    m.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "x1",
      status: "failed",
    });

    const rich = m.read().entries.flatMap((entry) => entry.blocks);
    expect(rich).toEqual([
      { type: "image", mimeType: "image/png", data: "aGk=" },
      { type: "image", mimeType: "image/png", dropped: true },
      {
        type: "resource_link",
        uri: "file:///w/src/a.ts",
        name: "a.ts",
        mimeType: "text/x-typescript",
      },
      { type: "text", text: "inline body" },
      { type: "resource_link", uri: "file:///w/c%20d.bin", name: "c d.bin" },
      {
        type: "tool_use",
        name: "Edit a.ts",
        id: "e1",
        kind: "edit",
        locations: [{ path: "/w/src/a.ts", line: 3 }],
      },
      {
        type: "tool_result",
        id: "e1",
        content: { status: "completed" },
        diffs: [{ path: "/w/src/a.ts", oldText: "a", newText: "b" }],
      },
      {
        type: "tool_result",
        id: "x1",
        content: { status: "failed" },
        status: "failed",
      },
    ]);

    // 连线读取看不到图片、链接与差异：只有文字与工具块。
    const plain = readMirrorEntries(m.path, 0, 1 << 22).entries.flatMap(
      (entry) => entry.blocks,
    );
    expect(plain.map((block) => block.type)).toEqual([
      "text",
      "tool_use",
      "tool_result",
      "tool_result",
    ]);
    expect(plain[1]).not.toHaveProperty("locations");
    expect(plain[2]).not.toHaveProperty("diffs");
    expect(plain[3]).not.toHaveProperty("status");
  });

  it("keeps the session id out of the path's directories", () => {
    expect(mirrorPath("/d", NODE, "../../etc/passwd")).toBe(
      join("/d", "acp", NODE, ".._.._etc_passwd.acp.jsonl"),
    );
  });
});
