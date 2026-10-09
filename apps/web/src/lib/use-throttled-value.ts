import * as React from "react";

/**
 * 节流后的值：变化时最多每 `ms` 毫秒跟一次，最后一次变化一定会跟上（尾沿）。
 *
 * 给「输入每帧都在变、重算不便宜」的派生用，例如拖动节点时小地图的连线。
 */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [throttled, setThrottled] = React.useState(value);
  const last = React.useRef(0);

  React.useEffect(() => {
    const wait = ms - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      setThrottled(() => value);
      return;
    }
    // 还在冷却：排一次尾沿。值再变时清掉重排，所以跟上的总是最新的那个。
    const timer = setTimeout(() => {
      last.current = Date.now();
      setThrottled(() => value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);

  return throttled;
}
