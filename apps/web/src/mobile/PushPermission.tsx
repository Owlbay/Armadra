import * as React from "react";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import {
  pushConfigSchema,
  pushDeviceResponseSchema,
  type PushConfig,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "../app/preferences-store";
import { json, request } from "../api/request";
import { useCompactLayout } from "../platform/layout";
import { useCanvasStore } from "../store/canvas-store";
import { subscribeToPush } from "../push/service-worker";
import { Button } from "@/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/ui/item";
import { nativeBridge, type NativeBridge } from "./native-bridge";
import { markNativePushRegistered } from "./push-rotation";

/** 挂在站点根下的 worker（`vite.config.ts` 的 `armadra-service-worker` 产出）。 */
export const SERVICE_WORKER_URL = "/sw.js";

const ASKED_KEY = "armadra.push.asked";

function asked(): boolean {
  try {
    return globalThis.localStorage?.getItem(ASKED_KEY) === "1";
  } catch {
    return true;
  }
}

function markAsked(): void {
  try {
    globalThis.localStorage?.setItem(ASKED_KEY, "1");
  } catch {
    /* 存不下就是下次再问一次。 */
  }
}

/** 浏览器这一侧能不能订阅：安全上下文、有 worker、还没被问过。 */
function webPushAskable(): boolean {
  return (
    globalThis.isSecureContext === true &&
    typeof Notification !== "undefined" &&
    Notification.permission === "default" &&
    "serviceWorker" in (globalThis.navigator ?? {})
  );
}

/**
 * 该不该问：问过就不问；原生 App 只要 core 答得出推送配置；浏览器还要
 * Web Push 开着、权限没定过。配置要登录才取得到，所以没登录时自然不出。
 */
export function shouldAsk(
  config: PushConfig,
  bridge: Pick<NativeBridge, "available">,
  askable: boolean,
): boolean {
  if (bridge.available) return true;
  return askable && config.webpush.enabled && config.webpush.publicKey !== null;
}

/**
 * 开启：浏览器走 Web Push（`subscribeToPush`），原生 App 向插件要令牌与设备
 * 密钥再登记（契约 §19.2）。返回是否成功。
 */
export async function enablePush(
  locale: "zh-CN" | "en",
  bridge: NativeBridge = nativeBridge(),
  subscribe: typeof subscribeToPush = subscribeToPush,
): Promise<"ok" | "denied" | "failed"> {
  if (bridge.available) {
    const registration = await bridge.pushRegistration();
    if (registration === null) return "failed";
    try {
      await request("/api/push/devices", pushDeviceResponseSchema, {
        method: "PUT",
        ...json({ ...registration, locale }),
      });
      // 之后令牌换了由 `push-rotation.ts` 自己重新登记（R-54）。
      markNativePushRegistered();
      await bridge.ackPushRotation?.().catch(() => undefined);
      return "ok";
    } catch {
      return "failed";
    }
  }
  const result = await subscribe(SERVICE_WORKER_URL, locale);
  if (result.ok) return "ok";
  return result.reason === "denied" ? "denied" : "failed";
}

/** 提示条本身（展示页与容器共用）。 */
export function PushPermissionPrompt({
  busy,
  onEnable,
  onLater,
  className,
}: {
  busy: boolean;
  onEnable: () => void;
  onLater: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <Item
      variant="outline"
      size="sm"
      role="region"
      aria-label={t("mobileConnect.push.title")}
      data-slot="push-permission"
      className={className}
    >
      <ItemMedia variant="icon">
        <Bell />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t("mobileConnect.push.title")}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onLater}>
          {t("mobileConnect.push.later")}
        </Button>
        <Button size="sm" disabled={busy} onClick={onEnable}>
          {t("mobileConnect.push.enable")}
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * 推送权限提示（架构 §10「手机网页细节」）：手机布局或原生 App 里、登录之后
 * 问一次，浮在底部导航之上。不在打开页面的那一刻弹系统权限框——要等人点
 * 「开启」，浏览器也只在用户手势里给权限。
 */
export function PushPermission() {
  const compact = useCompactLayout();
  const locale = usePreferencesStore((state) => state.locale);
  const t = useT();
  const [visible, setVisible] = React.useState(false);
  // 焦点页铺满整屏、底部是输入框，提示条不压在它上面；退回画布再出来。
  const focused = useCanvasStore((state) => state.focusNodeId !== null);
  const [busy, setBusy] = React.useState(false);
  const bridge = React.useMemo(() => nativeBridge(), []);
  const eligible = (compact || bridge.available) && !asked();

  React.useEffect(() => {
    if (!eligible) return;
    let live = true;
    request("/api/push/config", pushConfigSchema)
      .then((config) => {
        if (live && shouldAsk(config, bridge, webPushAskable()))
          setVisible(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [eligible, bridge]);

  if (!visible || focused || !(compact || bridge.available)) return null;

  const close = () => {
    markAsked();
    setVisible(false);
  };

  return (
    <PushPermissionDock>
      <PushPermissionPrompt
        busy={busy}
        onLater={close}
        onEnable={() => {
          setBusy(true);
          void enablePush(locale, bridge).then((result) => {
            setBusy(false);
            if (result === "failed")
              toast.error(t("mobileConnect.push.failed"));
            close();
          });
        }}
      />
    </PushPermissionDock>
  );
}

/** 提示条的位置：浮在底部导航（56 + 安全区）之上 8px。 */
export function PushPermissionDock({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-2 bottom-[calc(var(--mobile-nav-h)+env(safe-area-inset-bottom)+8px)] z-[var(--z-toast)] flex justify-center [&>*]:pointer-events-auto [&>*]:w-full [&>*]:max-w-md [&>*]:bg-popover [&>*]:shadow-[var(--shadow-overlay)]">
      {children}
    </div>
  );
}
