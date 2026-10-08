import { useCallback, useEffect, useRef, useState } from "react";

import {
  hasPairingFragment,
  type IdentitySession,
} from "../../../api/identity";
import { useT } from "../../../app/preferences-store";
import { useHostConnection } from "../../../host/use-host-connection";
import { Alert, AlertAction, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { HostIdentityPanel } from "./HostIdentityPanel";
import { PageCaGuide } from "./gateway/CaInstallGuide";
import {
  GatewayDevicesSection,
  type GatewayIdentity,
} from "./gateway/GatewaySection";
import { LoginSessions } from "./security/LoginSessions";

/** 带着配对票时检查失败的自动重试：次数与间隔。 */
const AUTO_RETRIES = 2;
const AUTO_RETRY_MS = 1_000;

/**
 * 设置 → 设备与会话（§2.1）：这台设备的登录（配对）、已配对设备、登录会话。
 *
 * 设备登录要先确认服务身份（`hello`）才会取走配对票，所以这一页打开就查一次
 * 连接。配对链接 `…/#pair=<票>` 由 `use-link-fragments` 打开到这一页；页面开着
 * 时地址栏才换上一张新票（同一标签页再贴一次配对链接只改片段、不重载）也要
 * 接住。经 Gateway 打开时顶上多一个 CA 安装引导。
 */
export function DevicesPage() {
  const t = useT();
  const { state, check } = useHostConnection();
  // 设备表只有一份；「设备登录」报上这台设备是谁、能不能管理。撤销了自己就
  // 让「设备登录」重新取一次会话（得到的是已退出）。
  const [identity, setIdentity] = useState<GatewayIdentity | null>(null);
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const onSession = useCallback((session: IdentitySession | null) => {
    setIdentity(
      session
        ? {
            deviceId: session.device.deviceId,
            canManage: session.scopes.some(
              (scope) => scope.permission === "identity:manage",
            ),
          }
        : null,
    );
  }, []);
  const autoRetries = useRef(0);
  useEffect(() => {
    void check();
    const onLink = () => {
      if (!hasPairingFragment()) return;
      autoRetries.current = 0;
      void check();
    };
    window.addEventListener("hashchange", onLink);
    return () => window.removeEventListener("hashchange", onLink);
  }, [check]);
  // 带着票却没检查成功（服务刚起、第一次握手慢）：票还在地址栏里，隔一秒再
  // 试，最多两次。
  useEffect(() => {
    if (state.status !== "error" || !hasPairingFragment()) return;
    if (autoRetries.current >= AUTO_RETRIES) return;
    autoRetries.current += 1;
    const timer = setTimeout(() => void check(), AUTO_RETRY_MS);
    return () => clearTimeout(timer);
  }, [state, check]);

  return (
    <>
      <PageCaGuide />
      {state.status === "connected" ? (
        <HostIdentityPanel
          key={identityEpoch}
          hello={state.hello}
          onSession={onSession}
        />
      ) : state.status === "error" ? (
        <Alert variant="destructive" role="status" aria-live="polite">
          <AlertTitle className="font-normal break-words">
            {t(state.messageKey)}
          </AlertTitle>
          <AlertAction>
            <Button size="sm" variant="secondary" onClick={() => void check()}>
              {t("host.check")}
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
      <GatewayDevicesSection
        identity={identity}
        onCurrentRevoked={() => setIdentityEpoch((epoch) => epoch + 1)}
      />
      <LoginSessions />
    </>
  );
}
