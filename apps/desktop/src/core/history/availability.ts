import { statSync } from "node:fs";
import {
  type AgentSettings,
  baseAgent,
  hasCapability,
} from "../agent/registry";
import { historyAdapter } from "./registry";

/**
 * 本机有没有这家 CLI 的历史数据（设计 `cli-collaboration.md` §5，契约 §12.2）。
 *
 * `GET /api/agents` 每一行都要算一次，所以只 stat 根目录、不扫描文件：根在不在
 * 就够回答「有没有」，有多少是会话索引与成本扫描的事。
 *
 * 判断全部从 {@link historyAdapter} 派生，注册表加一行，这里的答案跟着变。
 */
export type HistoryState =
  | "available"
  | "not-found"
  | "unsupported"
  | "disabled";

export interface HistoryAvailability {
  /** 会话索引。 */
  readonly index: HistoryState;
  /** 本地成本。 */
  readonly cost: HistoryState;
  /** 连线读取的转录。 */
  readonly transcript: HistoryState;
}

/**
 * 依次：没有适配器 → 三项 `unsupported`；适配器没有成本来源 → `cost`
 * `unsupported`；关掉了 `contextLink` → `transcript` `disabled`；根目录一个都不
 * 存在 → 其余 `not-found`；否则 `available`。
 *
 * 自定义条目按它的 base 找适配器：记录是那个 CLI 写的，不是用户起的标签写的。
 */
export function availabilityOf(
  agentId: string,
  settings: AgentSettings,
  env: NodeJS.ProcessEnv = process.env,
): HistoryAvailability {
  const adapter = historyAdapter(baseAgent(settings, agentId));
  if (adapter === undefined) {
    return {
      index: "unsupported",
      cost: "unsupported",
      transcript: "unsupported",
    };
  }
  const found: HistoryState = adapter.roots(env).some(exists)
    ? "available"
    : "not-found";
  return {
    index: found,
    cost: adapter.cost === undefined ? "unsupported" : found,
    transcript: hasCapability(settings, agentId, "contextLink")
      ? found
      : "disabled",
  };
}

/** 根可以是目录，也可以是一个库文件；stat 得到就算在。 */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
