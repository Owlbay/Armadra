/**
 * What the adapter adds to ama's system prompt (the `host` section, last).
 *
 * The canvas rules and the full skill come through the profile
 * (`instructions.md`, `skills/armadra/SKILL.md`), written by the core in the
 * same words every CLI gets. They name `armadra-hook canvas …` commands; in
 * ama those verbs are tools, so this says which tool is which — and repeats
 * the trust rule, from the one text the core uses too
 * (docs/design/coordinator-agent.md §3, §6).
 */

import type { HostApi } from "@armadra/agent/host";
import { TRUST_RULE } from "../../hook-client/trust-rule.js";

export const INSTRUCTIONS_NAME = "armadra-canvas";

export function canvasToolNote(): string {
  return `## Armadra 画布工具 / Armadra canvas tools

画布规则里的 \`armadra-hook canvas <动词>\`、\`armadra-hook context <动词>\`、\`armadra-hook browser <动词>\` 在这里是工具：\`canvas_<动词>\`、\`context_<动词>\`、\`browser_<动词>\`（动词里的 \`-\` 写成 \`_\`，如 \`canvas_open_agent\`）。直接调工具，不要在 shell 里跑 \`armadra-hook\`；参数名与命令行旗标相同。
The \`armadra-hook canvas|context|browser <verb>\` commands in the canvas rules are tools here: \`canvas_<verb>\`, \`context_<verb>\`, \`browser_<verb>\` (\`-\` becomes \`_\`, e.g. \`canvas_open_agent\`). Call the tools instead of running \`armadra-hook\` in a shell; argument names are the flag names.

拆任务给别的 Agent：\`canvas_team\` 或 \`canvas_open_agent\`；成员的结论用 \`canvas_inbox\` 读、\`canvas_ack\` 确认；汇总写进 \`canvas_sticky\`。
To split work, use \`canvas_team\` / \`canvas_open_agent\`; read members' results with \`canvas_inbox\`, acknowledge with \`canvas_ack\`, and write the summary with \`canvas_sticky\`.

${TRUST_RULE}`;
}

export function addInstructions(api: Pick<HostApi, "instructions">): void {
  api.instructions.add({
    kind: "text",
    name: INSTRUCTIONS_NAME,
    text: canvasToolNote(),
  });
}
