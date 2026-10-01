/**
 * `history.test.ts` 用的转录样本：自编的小样本，覆盖 Claude、Codex、OpenAI 三种
 * 形状，以及拆分之前渲染与摘要两边各自宽容的那些边角。期望值从拆分之前的实现
 * 固化下来，见 `history.test.ts`。
 */

function jsonl(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

const LONG = "长".repeat(3_000);

export const TEXT_FIXTURES: Readonly<Record<string, string>> = {
  roles: [
    JSON.stringify({ type: "user", message: { content: "ask" } }),
    JSON.stringify({ type: "assistant", message: { content: "answer" } }),
    JSON.stringify({ type: "system", content: "note" }),
    JSON.stringify({ type: "summary", content: "ignored" }),
    "not json",
    "",
  ].join("\n"),
  codex: jsonl([
    {
      timestamp: "2026-09-20T09:00:00Z",
      type: "session_meta",
      payload: { id: "0199", cwd: "/work" },
    },
    {
      timestamp: "2026-09-20T09:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "fix   the bug" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        arguments: '{"command":"ls"}',
        call_id: "c1",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    { type: "event_msg", payload: { type: "user_message", message: "x" } },
  ]),
  claude: jsonl([
    {
      type: "user",
      timestamp: "2026-09-20T09:00:00Z",
      message: { role: "user", content: "  please  read a.ts " },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Reading." },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: "ls -la" },
          },
          { type: "thinking", text: "hmm" },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t2", content: "line1\nline2" },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "nested  text" }],
          },
        ],
      },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "   " }] },
    },
    { role: "tool", content: "tool says" },
    {
      role: "user",
      content: [
        "bare",
        { type: "text", text: "typed" },
        ["nested", { type: "tool_use", name: "Edit", input: { path: "n.ts" } }],
      ],
    },
    { type: "user", message: { content: 42 } },
    { type: "user", message: { content: [] } },
    {
      type: "assistant",
      message: { content: { type: "text", text: "object content" } },
    },
    {
      role: "assistant",
      content: [
        {
          type: "function_call",
          name: "apply",
          arguments: '{"path":"p.ts"}',
          call_id: "c9",
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "function_call_output", call_id: "c9", output: "ok" }],
    },
    { type: "assistant", message: { content: LONG } },
    { type: "assistant", message: { content: [{ type: "tool_use" }] } },
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Odd", input: { a: 1, b: [2] } }],
      },
    },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Empty", input: {} }] },
    },
    { type: "user", text: "text field" },
    { type: "user", message: { content: "我在 中文 里" } },
  ]),
  document: JSON.stringify({
    messages: [{ role: "user", content: "from a document" }],
  }),
  array: JSON.stringify([
    { role: "user", content: "array" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
  ]),
  emptyDocument: JSON.stringify([{ role: "user", content: "" }]),
  singleLine: JSON.stringify({
    type: "user",
    message: { content: "one line" },
  }),
  prettyDocument: `${JSON.stringify(
    { messages: [{ role: "user", content: "pretty" }] },
    null,
    2,
  )}\n`,
  files: jsonl(
    Array.from({ length: 25 }, (_, index) => ({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input:
              index % 2 === 0
                ? { file_path: `f${index}.ts` }
                : JSON.stringify({ path: ` g${index}.ts ` }),
          },
        ],
      },
    })),
  ),
};

/** `transcript.test.ts` 里直接喂给 `renderEntry` 的四条。 */
export const ENTRY_FIXTURES: readonly unknown[] = [
  {
    type: "response_item",
    payload: { role: "user", content: [{ type: "input_text", text: "hi" }] },
  },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "a.ts", extra: 1 },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [{ type: "tool_result", content: "  lots  of  output " }],
    },
  },
  {
    type: "assistant",
    message: { content: [{ type: "thinking", text: "hmm" }] },
  },
];

/** `context transcript` 缺省那一档。 */
export const BRIEF = { maxLineChars: 60, briefToolResults: true } as const;
