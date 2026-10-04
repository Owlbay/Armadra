import { create } from "zustand";

/**
 * 「刚落成」的一次光晕：输出到画板建出的节点亮一圈未读光晕（现有的
 * `data-glow="unread"` 样式），一个动画周期后自己熄掉。
 *
 * 不进文档、不进历史：它只是告诉看着画布的人「东西放在这儿了」。别的页面与
 * 刷新之后都看不到，也不该看到。
 */

/** 与 `nodes.css` 里 unread 光晕的一个周期同长。 */
export const NODE_FLASH_MS = 2000;

interface NodeFlashState {
  flashing: Readonly<Record<string, true>>;
}

export const useNodeFlash = create<NodeFlashState>(() => ({ flashing: {} }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function flashNodes(
  ids: readonly string[],
  durationMs = NODE_FLASH_MS,
): void {
  if (ids.length === 0) return;
  useNodeFlash.setState((state) => {
    const flashing = { ...state.flashing };
    for (const id of ids) flashing[id] = true;
    return { flashing };
  });
  for (const id of ids) {
    const previous = timers.get(id);
    if (previous !== undefined) clearTimeout(previous);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        useNodeFlash.setState((state) => {
          const { [id]: _gone, ...rest } = state.flashing;
          void _gone;
          return { flashing: rest };
        });
      }, durationMs),
    );
  }
}

export function useNodeFlashing(id: string): boolean {
  return useNodeFlash((state) => state.flashing[id] === true);
}
