/**
 * 每个 agent 的本地采集适配器。
 *
 * 加一家 agent 只有一条路径：在它的本地历史适配器（`history/`）上声明
 * `cost: { kind: "jsonl", source }`，在 `history/registry.ts` 里注册那个适配器——
 * `summarize()`、线上形状和界面一行都不用改。
 *
 * 映射里**只有**在本机留下可解析记录的 agent。没有本地来源的那几家不在这里，于是
 * 它们在汇总里是 `source: "none"` 的零，而不是一个编出来的数字。
 *
 * 快照式来源（`kind: "snapshot"`，给没有逐行文件的 CLI）不进这张表：逐行扫描器
 * 认不得它们，扫描状态里的快照分支见设计 `cli-collaboration.md` §9 H2。
 */

import type { AgentId } from "../agent/registry";
import { HISTORY_ADAPTERS } from "../history/registry";
import type { AgentCostSource } from "../history/types";

export type { AbsorbContext, AgentCostSource } from "../history/types";

/** 从注册表派生：每个声明了逐行成本来源的适配器一项，按注册表顺序。 */
export const COST_SOURCES: Partial<Record<AgentId, AgentCostSource>> =
  Object.fromEntries(
    HISTORY_ADAPTERS.flatMap((adapter) =>
      adapter.cost?.kind === "jsonl"
        ? [[adapter.agentId, adapter.cost.source] as const]
        : [],
    ),
  );

export function costSource(agentId: string): AgentCostSource | undefined {
  return COST_SOURCES[agentId as AgentId];
}
