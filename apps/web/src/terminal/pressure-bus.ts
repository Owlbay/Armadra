/**
 * 内存压力事件总线（性能设计 §2.3）。
 *
 * 本地占位：正式实现由内存压力包提供（壳的 `memory:pressure` 与
 * `resource.sample` 两路各记最新档、取最高、同档 20 s 节流），接口与它一致，
 * 合入后以那一版为准。这里只保留最小语义：各来源记最新档，有效档取最高，
 * 有效档变了或是告警档时回调。
 */

export type MemoryPressureLevel = "normal" | "warning" | "critical";
export type MemoryPressureSource = "shell" | "sample";

const RANK: Record<MemoryPressureLevel, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

const listeners = new Set<(level: MemoryPressureLevel) => void>();
const latest: Record<MemoryPressureSource, MemoryPressureLevel> = {
  shell: "normal",
  sample: "normal",
};
let effective: MemoryPressureLevel = "normal";

export function currentMemoryPressure(): MemoryPressureLevel {
  return effective;
}

export function onMemoryPressure(
  listener: (level: MemoryPressureLevel) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitMemoryPressure(
  level: MemoryPressureLevel,
  source: MemoryPressureSource = "shell",
): void {
  latest[source] = level;
  const next =
    RANK[latest.shell] >= RANK[latest.sample] ? latest.shell : latest.sample;
  const changed = next !== effective;
  effective = next;
  if (next === "normal" && !changed) return;
  for (const listener of [...listeners]) listener(next);
}
