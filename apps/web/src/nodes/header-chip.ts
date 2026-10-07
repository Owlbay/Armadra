/**
 * 节点头胶囊的统一外观（设计系统 §4 节点头）。
 *
 * 胶囊簇里的每一枚——内存、账号、交接、依赖、驱动、排队、上下文读取——都用
 * `Badge` 加这一条：18px 高、caption 字号、`px-1.5`、等宽数字。可点的胶囊是
 * `Badge asChild` 包一枚 `Button`，外观仍走这条，所以同一行里不会一枚高一枚矮。
 */
export const HEADER_CHIP_CLASS =
  "h-[18px] px-1.5 text-[length:var(--text-caption)] tabular-nums";
