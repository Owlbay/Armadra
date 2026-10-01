import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { readLocatedEntries, reportedFile } from "./files";
import type { EntryRange, HistoryAdapter, Located, SessionHint } from "./types";

/**
 * 本地历史适配器的注册表（设计 `cli-collaboration.md` §2）。
 *
 * 接入一家 CLI 的本地历史只有一条路径：写一个 {@link HistoryAdapter}，在
 * {@link HISTORY_ADAPTERS} 里加一行。会话索引的 provider 列表、成本来源表、转录
 * 定位与读取都从这里派生，不必再改调用方。顺序就是会话索引扫描与成本表的顺序。
 */
export const HISTORY_ADAPTERS: readonly HistoryAdapter[] = [
  claudeAdapter,
  codexAdapter,
];

/** 这个 agent id 的适配器；自定义条目与还没接入的 CLI 是 `undefined`。 */
export function historyAdapter(agentId: string): HistoryAdapter | undefined {
  return HISTORY_ADAPTERS.find((adapter) => adapter.agentId === agentId);
}

/**
 * 某个节点的记录在哪。
 *
 * CLI 自己报来的转录路径永远先认，不论有没有适配器——Pi、OMP 的扩展会报，自定义
 * 条目借的是基础 agent 的 Hook，也会报。之后才轮到适配器自己的查找。
 */
export function locateHistory(hint: SessionHint): Located | undefined {
  return (
    reportedFile(hint.transcriptPath) ??
    historyAdapter(hint.agentId)?.locate(hint)
  );
}

/**
 * 读一段归一化记录：有适配器经适配器，没有的按 JSONL 文件读（CLI 报来的路径）。
 * I/O 失败照常抛出。
 */
export function readHistoryEntries(
  agentId: string,
  located: Located,
  fromOffset: number,
  maxBytes: number,
): EntryRange {
  const adapter = historyAdapter(agentId);
  return adapter === undefined
    ? readLocatedEntries(located, fromOffset, maxBytes)
    : adapter.readEntries(located, fromOffset, maxBytes);
}
