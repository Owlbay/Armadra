import { useEffect } from "react";
import { toast } from "sonner";

import { CLOSE_REVOKED, closeMessageKey, onControlClosed } from "../api/ws";
import { t } from "./preferences-store";

/**
 * 控制面停下了（契约 §35.2）：版本不兼容（4409）或订阅数到顶（4429）时重连只会
 * 撞上同一堵墙，用一句话说明怎么办。授权收回（4403）由
 * `use-access-lost.ts` 按工作空间说，这里不重复。
 */
export function useControlNotices(): void {
  useEffect(
    () =>
      onControlClosed((code) => {
        if (code === CLOSE_REVOKED) return;
        const key = closeMessageKey(code);
        if (key === undefined) return;
        toast.error(t(key), { id: `control-closed-${code}` });
      }),
    [],
  );
}
