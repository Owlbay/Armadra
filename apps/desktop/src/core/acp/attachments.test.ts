import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceEvent } from "../bus";
import { type StoredUpload, storeUpload } from "../files/uploads";
import { attachmentBlocks } from "./attachments";
import { AcpError } from "./client";
import { type AcpCore, FAKE_AGENT, acpCore, until } from "./fixture";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function upload(
  name: string,
  mimeType: string,
  bytes: number,
  path = `/data/agent-uploads/w/0/${name}`,
): StoredUpload {
  return { id: "0".repeat(32), name, path, mimeType, bytes };
}

describe("attachmentBlocks (§55)", () => {
  const read = (path: string) =>
    path.endsWith(".png") ? PNG : Buffer.from("const a = 1;\n");

  it("sends an image as an image block when the agent takes images", () => {
    const shot = upload("shot.png", "image/png", PNG.byteLength);
    const { blocks, links } = attachmentBlocks(
      [shot],
      { image: true, embeddedContext: false },
      false,
      read,
    );
    expect(blocks).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: PNG.toString("base64"),
        uri: pathToFileURL(shot.path).href,
      },
    ]);
    // 镜像与事件里只有链接，没有正文。
    expect(links).toEqual([
      {
        type: "resource_link",
        uri: pathToFileURL(shot.path).href,
        name: "shot.png",
        mimeType: "image/png",
      },
    ]);
    expect(JSON.stringify(links)).not.toContain(PNG.toString("base64"));
  });

  it("refuses an image the agent did not declare it can take", () => {
    const shot = upload("shot.png", "image/png", PNG.byteLength);
    for (const capabilities of [
      null,
      { image: false, embeddedContext: true },
    ]) {
      expect(() => attachmentBlocks([shot], capabilities, false, read)).toThrow(
        expect.objectContaining({ code: "acp_image_unsupported" }),
      );
    }
    const big = upload("big.png", "image/png", 9 * 1024 * 1024);
    expect(() =>
      attachmentBlocks([big], { image: true, embeddedContext: true }, false),
    ).toThrow(AcpError);
  });

  it("embeds a small text file when the agent takes embedded context", () => {
    const code = upload("a.ts", "video/mp2t", 13);
    const text = upload("notes.txt", "text/plain", 13);
    const { blocks } = attachmentBlocks(
      [text, code],
      { image: false, embeddedContext: true },
      false,
      read,
    );
    expect(blocks[0]).toEqual({
      type: "resource",
      resource: {
        uri: pathToFileURL(text.path).href,
        text: "const a = 1;\n",
        mimeType: "text/plain",
      },
    });
    // 不是文本的类型落到链接。
    expect(blocks[1]).toMatchObject({ type: "resource_link", name: "a.ts" });
  });

  it("links any other file, and refuses a link on an SSH node", () => {
    const pdf = upload("spec.pdf", "application/pdf", 2048);
    const { blocks } = attachmentBlocks(
      [pdf],
      { image: false, embeddedContext: false },
      false,
      read,
    );
    expect(blocks).toEqual([
      {
        type: "resource_link",
        uri: pathToFileURL(pdf.path).href,
        name: "spec.pdf",
        mimeType: "application/pdf",
        size: 2048,
      },
    ]);
    expect(() =>
      attachmentBlocks(
        [pdf],
        { image: true, embeddedContext: true },
        true,
        read,
      ),
    ).toThrow(expect.objectContaining({ code: "acp_attachment_unsupported" }));
    // SSH 节点上图片照样内嵌，只是不带本机路径。
    const shot = upload("shot.png", "image/png", PNG.byteLength);
    const remote = attachmentBlocks(
      [shot],
      { image: true, embeddedContext: false },
      true,
      read,
    );
    expect(remote.blocks[0]).not.toHaveProperty("uri");
  });
});

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

describe("acp.prompt with attachments (§55)", () => {
  it("sends uploads with the prompt and mirrors only their links", async () => {
    open = await acpCore();
    const seen = events(open);
    const nodeId = await open.node();
    const created = await open.core.call("POST", "/api/acp/sessions", {
      workspaceId: open.workspaceId,
      nodeId,
      cwd: open.core.directory,
      agentId: FAKE_AGENT,
    });
    expect(created.status).toBe(200);
    const rowId = (created.body as { id: string }).id;
    await until(
      () => open!.core.call("GET", `/api/acp/sessions/${rowId}/log`),
      (log) =>
        (log.body as { promptCapabilities?: unknown }).promptCapabilities !==
        undefined,
    );
    const log = await open.core.call("GET", `/api/acp/sessions/${rowId}/log`);
    // 假 Agent 声明不收图片、不收内嵌正文。
    expect(
      (log.body as { promptCapabilities: unknown }).promptCapabilities,
    ).toEqual({ image: false, embeddedContext: false });

    const file = storeUpload(
      open.core.directory,
      open.workspaceId,
      "notes.txt",
      "text/plain",
      Buffer.from("secret body"),
    );
    const sent = await open.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "look", attachments: [{ uploadId: file.id }] },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await until(
      () => seen.filter((event) => event.type === "acp.turn"),
      (turns) => turns.length > 0,
    );
    const after = await open.core.call("GET", `/api/acp/sessions/${rowId}/log`);
    const entries = (
      after.body as {
        entries: { role: string; blocks: Record<string, unknown>[] }[];
      }
    ).entries;
    expect(entries[0]).toMatchObject({
      role: "user",
      blocks: [
        { type: "text", text: "look" },
        { type: "resource_link", name: "notes.txt", mimeType: "text/plain" },
      ],
    });
    // 假 Agent 把非文本块回显成 `[类型]`：链接到了。
    expect(entries[1]?.blocks[0]).toMatchObject({
      text: "echo: look[resource_link]",
    });
    // 正文不进镜像与事件。
    expect(JSON.stringify(after.body)).not.toContain("secret body");
    expect(JSON.stringify(seen)).not.toContain("secret body");

    // 图片：这家没声明，拒绝且不投递。
    const shot = storeUpload(
      open.core.directory,
      open.workspaceId,
      "shot.png",
      "image/png",
      PNG,
    );
    const refused = await open.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "see", attachments: [{ uploadId: shot.id }] },
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "acp_image_unsupported" });

    // 只有附件、没有文字也可以；坏的 id 答 400，别处的 id 答 404。
    const only = await open.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "", attachments: [{ uploadId: file.id }] },
    );
    expect(only.status, JSON.stringify(only.body)).toBe(200);
    const bad = await open.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "x", attachments: [{ uploadId: "../etc" }] },
    );
    expect(bad.status).toBe(400);
    const missing = await open.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "x", attachments: [{ uploadId: "f".repeat(32) }] },
    );
    expect(missing.status).toBe(404);
    const empty = await open.core.call(
      "POST",
      `/api/acp/sessions/${rowId}/prompt`,
      { text: "  " },
    );
    expect(empty.status).toBe(400);
    expect(readFileSync(file.path, "utf8")).toBe("secret body");
  });
});
