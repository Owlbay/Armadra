import { digest } from "../usage/cost-buckets";
import type { AbsorbContext } from "./types";

/**
 * 逐行成本来源共用的三个小件，从 `usage/cost-sources.ts` 搬来：各家适配器的
 * `absorb` 都要它们。
 */

export function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 一行重复了就返回 true，同时把它记进去。没有 id 的行一律算新的。 */
export function duplicate(
  context: AbsorbContext,
  identity: string | undefined,
): boolean {
  if (identity === undefined) return false;
  const key = digest(identity);
  if (context.seen.has(key)) return true;
  context.seen.add(key);
  return false;
}
