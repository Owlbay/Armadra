/**
 * 把 `value` 夹进 `[min, max]`。非有限值（NaN、±Infinity）一律回到 `min`：
 * 输入框里能打出任何东西，越界与非数字都在这里收敛成一个可用的值。
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 同 `clamp`，结果取整（边界为整数时先夹后取整与先取整后夹等价）。 */
export function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}
