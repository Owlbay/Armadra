// 探针用的假 ACP Agent（契约 §55）：声明收图片与内嵌正文，把收到的每个内容块
// 概括成一句回给页面——不回显正文，只回类型、名字与大小。零依赖、不联网、不碰
// 文件系统；stdin 结束即退出。
//
//   node tools/probes/fixtures/fake-acp-attach.mjs
//
// 回复形如 `got: text:look | image:image/png:68 | resource:notes.txt:11 | link:a.pdf`。
import { createInterface } from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const nameOf = (uri) => decodeURIComponent(String(uri).split("/").at(-1) ?? "");

function describe(block) {
  switch (block?.type) {
    case "text":
      return `text:${block.text}`;
    case "image":
      return `image:${block.mimeType}:${Buffer.from(block.data ?? "", "base64").length}`;
    case "resource":
      return `resource:${nameOf(block.resource?.uri)}:${(block.resource?.text ?? "").length}`;
    case "resource_link":
      return `link:${block.name}`;
    default:
      return `other:${block?.type}`;
  }
}

let sessions = 0;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // 通知（`session/cancel`）与对我方请求的答复：这里不发请求，都不用管。
  if (message.id === undefined || message.method === undefined) return;
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "fake-acp-attach", version: "1.0.0" },
        },
      });
      return;
    case "session/new":
      sessions += 1;
      send({ id, result: { sessionId: `attach-${sessions}` } });
      return;
    case "session/prompt": {
      const blocks = Array.isArray(params.prompt) ? params.prompt : [];
      send({
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `got: ${blocks.map(describe).join(" | ")}`,
            },
          },
        },
      });
      send({ id, result: { stopReason: "end_turn" } });
      return;
    }
    default:
      send({
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
  }
});
lines.on("close", () => process.exit(0));
