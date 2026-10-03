// agent-e2e 的脚本化模型服务（场景 11）。单放一个文件：lib.mjs 已到仓库的单文件
// 行数上限。
import { once } from "node:events";
import { createServer } from "node:http";

import { cleanups } from "./lib.mjs";

/**
 * 本地的 OpenAI 兼容脚本化模型服务（协调 Agent §8 第 1 步）：`POST
 * …/chat/completions` 每来一次请求，按 `script(request, index)` 的答复回一轮——
 * `{ text }` 是一段正文，`{ toolCalls: [{ name, arguments }] }` 是工具调用。流式
 * （SSE，`stream: true`）与非流式都答；`GET …/models` 答一个空列表。
 *
 * 不需要真实密钥、不出本机：协调逻辑的验收对象是画布动词与状态，不是模型质量。
 * 每次请求的请求体都记在 `requests` 里，场景据此断言工具表与对话。
 */
export async function mockModelServer(script) {
  const requests = [];
  let calls = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      if (request.method === "GET" && /\/models$/.test(request.url ?? "")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (!/\/chat\/completions$/.test(request.url ?? "")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {}
      const index = calls;
      calls += 1;
      requests.push(body);
      let reply;
      try {
        reply = (await script(body, index)) ?? { text: "ok" };
      } catch (error) {
        reply = { text: `script error: ${error?.message ?? error}` };
      }
      const id = `chatcmpl-mock-${index}`;
      const model = body.model ?? "mock";
      const toolCalls = (reply.toolCalls ?? []).map((call, position) => ({
        index: position,
        id: `call_${index}_${position}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        },
      }));
      const finish = toolCalls.length > 0 ? "tool_calls" : "stop";
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                finish_reason: finish,
                message: {
                  role: "assistant",
                  content: reply.text ?? null,
                  ...(toolCalls.length > 0
                    ? {
                        tool_calls: toolCalls.map(
                          ({ index: _, ...call }) => call,
                        ),
                      }
                    : {}),
                },
              },
            ],
            usage,
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const chunk = (delta, finishReason = null, extra = {}) =>
        response.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...extra,
          })}\n\n`,
        );
      chunk({ role: "assistant", content: reply.text ?? "" });
      if (toolCalls.length > 0) chunk({ tool_calls: toolCalls });
      chunk({}, finish);
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  cleanups.push(() => server.close());
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  };
}
