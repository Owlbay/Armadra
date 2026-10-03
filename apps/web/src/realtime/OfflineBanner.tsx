import type { ReactNode } from "react";
import { CloudOff } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { useRealtimeOffline } from "./session";

/**
 * 「离线编辑」通知条（补全架构 §6.4）：实时板的连接断了，本地照常编辑，重连
 * 后 step1 / step2 自动补齐。状态自己会消失，所以不给关闭钮；也没有动作——
 * 重连是自动的。
 *
 * 只给出内容，由顶部通知条堆栈（`shell/Banners`）画，和其余几条共用位置与
 * 让位规则，不会互相压住。
 */
export function useOfflineBanner(): { icon: ReactNode; text: string } | null {
  const t = useT();
  const offline = useRealtimeOffline();
  if (!offline) return null;
  return { icon: <CloudOff />, text: t("realtime.offline") };
}
