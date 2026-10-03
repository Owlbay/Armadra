/**
 * `acp` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用；消息正文、文件名
 * 是数据不是界面文案，允许中文（`i18n.test.ts` 排除了本目录）。
 */
import type { AcpModeState } from "@armadra/shared";

import type { AcpItem, AcpPermissionView } from "@/acp/store";

export const ACP_NODE_ID = "5a7d2c1e-3b4f-4e6a-9c8d-0f1e2d3c4b5a";
export const ACP_SESSION_ID = "c0dex-7f3e-4a21-9b1c-session";

export const ACP_ITEMS: AcpItem[] = [
  {
    kind: "message",
    id: "m0",
    role: "user",
    text: "给 parseConfig 补上空文件的处理，再画一下加载流程",
    turn: 1,
  },
  {
    kind: "message",
    id: "m1",
    role: "thought",
    text: "先读 src/config.ts，看空串在哪一步抛错。",
    turn: 1,
  },
  {
    kind: "tool",
    id: "t1",
    turn: 1,
    call: {
      toolCallId: "1",
      title: "读取 src/config.ts",
      kind: "read",
      status: "completed",
      content: [],
      rawInput: { path: "src/config.ts" },
    },
  },
  {
    kind: "tool",
    id: "t2",
    turn: 1,
    call: {
      toolCallId: "2",
      title: "编辑 src/config.ts",
      kind: "edit",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "src/config.ts",
          oldText:
            "export function parseConfig(text: string) {\n  return JSON.parse(text);\n}\n",
          newText:
            'export function parseConfig(text: string) {\n  if (text.trim() === "") return {};\n  return JSON.parse(text);\n}\n',
        },
      ],
    },
  },
  {
    kind: "tool",
    id: "t3",
    turn: 1,
    call: {
      toolCallId: "3",
      title: "运行 pnpm test config",
      kind: "execute",
      status: "failed",
      content: [],
      rawInput: { command: "pnpm test config" },
      rawOutput: "1 failed: parseConfig > rejects BOM",
    },
  },
  {
    kind: "message",
    id: "m2",
    role: "assistant",
    text: '空文件现在返回 `{}`，BOM 那条用例还没过。\n\n```ts\nexport function parseConfig(text: string) {\n  if (text.trim() === "") return {};\n  return JSON.parse(text);\n}\n```\n\n```mermaid\ngraph LR\n  A[读取文件] --> B{为空?}\n  B -- 是 --> C[返回默认]\n  B -- 否 --> D[JSON.parse]\n```',
    turn: 1,
  },
];

export const ACP_STREAMING_ITEMS: AcpItem[] = [
  {
    kind: "message",
    id: "m0",
    role: "user",
    text: "解释一下这个仓库",
    turn: 1,
  },
  {
    kind: "message",
    id: "m1",
    role: "assistant",
    text: "这是一个画布式的多 Agent 工作台，主要分三层：",
    turn: 1,
  },
];

export const ACP_PERMISSION: AcpPermissionView = {
  pendingId: "p1",
  toolCall: {
    toolCallId: "4",
    title: "运行 pnpm test",
    kind: "execute",
  },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};

export const ACP_MODES: AcpModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
    { id: "acceptEdits", name: "Accept edits" },
  ],
};
