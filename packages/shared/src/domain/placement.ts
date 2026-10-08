import type { LAYOUT_DIRECTION_CHOICES } from "../completion-settings.js";
import type { Position, Size } from "./nodes.js";

/**
 * 派发出来的从放在哪（契约 §50，ui-wave2 §4.4）。纯函数，core 的控制动词
 * （`open-agent` / `team`）与页面的「派生」共用这一条规矩。
 *
 * - `vertical`：从排在主**下面一行**——`y = 主底 + 48`；`x` 接在主已有的从里
 *   最右那个的右边（隔 60），没有从时与主左对齐。
 * - `horizontal`：从排在主**右侧一列**——`x = 主右 + 60`；`y` 接在已有的从里
 *   最下那个的下面（隔 48），没有从时与主顶对齐。
 *
 * 落点和任何已有的盒子相交（包围盒，贴边不算）就沿同一行 / 列再让一格；
 * 让 64 次还不行就放到所有盒子的下面（纵向）或右边（横向）。已有节点一个不动：
 * 居中只在整理时做。
 *
 * 盒子要和主在同一个坐标系里：主在分组里时只传同组的兄弟（坐标相对分组）。
 */

export type LayoutDirection = (typeof LAYOUT_DIRECTION_CHOICES)[number];

export const DEFAULT_LAYOUT_DIRECTION: LayoutDirection = "vertical";

/** 行距（纵向的层距、横向的兄弟间距），与整理的 `ROW_GAP` 同值。 */
export const PLACEMENT_ROW_GAP = 48;
/** 列距（横向的层距、纵向的兄弟间距），与整理的 `COLUMN_GAP` 同值。 */
export const PLACEMENT_COLUMN_GAP = 60;
/** 沿行 / 列最多让几格。 */
export const PLACEMENT_ATTEMPTS = 64;

export interface PlacementBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: PlacementBox, at: Position, size: Size): boolean {
  return (
    a.x < at.x + size.width &&
    at.x < a.x + a.width &&
    a.y < at.y + size.height &&
    at.y < a.y + a.height
  );
}

/**
 * 新从的左上角。`childIds` 是主已有的从（`role: "supervises"` 边的另一端）；
 * 主不在 `boxes` 里时返回 `null`，由调用方退回自己的缺省落点。
 */
export function dispatchPlacement(
  boxes: readonly PlacementBox[],
  parentId: string,
  size: Size,
  direction: LayoutDirection,
  childIds: readonly string[] = [],
): Position | null {
  const parent = boxes.find((box) => box.id === parentId);
  if (parent === undefined) return null;
  const wanted = new Set(childIds);
  const children = boxes.filter(
    (box) => box.id !== parentId && wanted.has(box.id),
  );
  const vertical = direction === "vertical";

  let at: Position = vertical
    ? {
        x:
          children.length > 0
            ? Math.max(...children.map((box) => box.x + box.width)) +
              PLACEMENT_COLUMN_GAP
            : parent.x,
        y: parent.y + parent.height + PLACEMENT_ROW_GAP,
      }
    : {
        x: parent.x + parent.width + PLACEMENT_COLUMN_GAP,
        y:
          children.length > 0
            ? Math.max(...children.map((box) => box.y + box.height)) +
              PLACEMENT_ROW_GAP
            : parent.y,
      };

  const taken = () => boxes.some((box) => intersects(box, at, size));
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && taken(); attempt += 1) {
    at = vertical
      ? { x: at.x + size.width + PLACEMENT_COLUMN_GAP, y: at.y }
      : { x: at.x, y: at.y + size.height + PLACEMENT_ROW_GAP };
  }
  if (taken()) {
    at = vertical
      ? {
          x: parent.x,
          y:
            Math.max(...boxes.map((box) => box.y + box.height)) +
            PLACEMENT_ROW_GAP,
        }
      : {
          x:
            Math.max(...boxes.map((box) => box.x + box.width)) +
            PLACEMENT_COLUMN_GAP,
          y: parent.y,
        };
  }
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  return at;
}
