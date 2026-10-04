import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useT } from "../../../app/preferences-store";
import {
  hasPairingFragment,
  type IdentitySession,
} from "../../../api/identity";
import { useHostConnection } from "../../../host/use-host-connection";
import { SettingsGroup } from "../SettingsGroup";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { HostIdentityPanel } from "./HostIdentityPanel";
import { PageCaGuide } from "./gateway/CaInstallGuide";
import { GatewaySection, type GatewayIdentity } from "./gateway/GatewaySection";

/**
 * 设置 → 后台服务。
 *
 * 以前这里有一个服务地址可以填：Runtime 与 Go Host 是两个进程，页面要能被指向
 * 另一台机器上的 Host。单一 core 之后没有第二个地址——桌面壳里端口由壳给，
 * 服务器壳里它就是这张页面的来源——所以这一页说的是「连得上吗」「这台设备
 * 登录了吗」，以及对外服务（Gateway，补全架构 §7）：开关、配对二维码与已配对
 * 设备。经 Gateway 打开时顶上多一个 CA 安装引导。
 */
/** 带着配对票时检查失败的自动重试：次数与间隔。 */
const AUTO_RETRIES = 2;
const AUTO_RETRY_MS = 1_000;

export function HostPage() {
  const t = useT();
  const id = useId();
  const { state, check, cancel } = useHostConnection();
  // 设备表只有一份（对外服务那一块）；「设备登录」报上这台设备是谁、能不能
  // 管理。撤销了自己就让「设备登录」重新取一次会话（得到的是已退出）。
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
  // 从配对链接打开时自己检查一次：身份面要先确认服务身份才会取走票，这一步
  // 让人再点一次「检查连接」只是多一道没人知道的门槛。其余时候照旧等人点。
  // 页面已经开着、地址栏里才换上一张新票（同一标签页再贴一次配对链接只改片
  // 段、不重载）也要接住，否则那张票就停在地址栏里没人取。
  const autoRetries = useRef(0);
  useEffect(() => {
    const onLink = () => {
      if (!hasPairingFragment()) return;
      autoRetries.current = 0;
      void check();
    };
    onLink();
    window.addEventListener("hashchange", onLink);
    return () => window.removeEventListener("hashchange", onLink);
  }, [check]);
  // 带着票却没检查成功（服务刚起、第一次握手慢）：票还在地址栏里，隔一秒再
  // 试，最多两次。人点的检查失败照旧只报错。
  useEffect(() => {
    if (state.status !== "error" || !hasPairingFragment()) return;
    if (autoRetries.current >= AUTO_RETRIES) return;
    autoRetries.current += 1;
    const timer = setTimeout(() => void check(), AUTO_RETRY_MS);
    return () => clearTimeout(timer);
  }, [state, check]);
  const message =
    state.status === "error"
      ? state.messageKey
      : state.status === "idle" && state.cancelled
        ? "host.status.cancelled"
        : `host.status.${state.status}`;

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("host.note")}
      </p>
      <PageCaGuide />
      <SettingsGroup>
        <div className="flex min-w-0 flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-10"
              disabled={state.status === "checking"}
              onClick={() => void check()}
            >
              {state.status === "checking" && (
                // 设计系统 §3.4：加载态是按钮里的 Spinner；状态行另有朗读。
                <Spinner role="presentation" aria-hidden />
              )}
              {t("host.check")}
            </Button>
            {state.status === "checking" && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="min-h-10"
                onClick={cancel}
              >
                {t("host.cancel")}
              </Button>
            )}
          </div>
          {state.status === "error" ? (
            <Alert
              variant="destructive"
              id={`${id}-status`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <AlertTitle className="font-normal break-words">
                {t(message)}
              </AlertTitle>
            </Alert>
          ) : (
            <p
              id={`${id}-status`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="break-words text-[13px] leading-5 text-muted-foreground"
            >
              {t(message)}
            </p>
          )}
        </div>
        {state.status === "connected" && (
          <details className="min-w-0 px-4 py-3">
            <summary className="cursor-pointer rounded-sm text-[13px] focus-visible:outline-2 focus-visible:outline-ring">
              {t("host.details")}
            </summary>
            <dl className="mt-3 grid min-w-0 gap-3 text-[12px]">
              <div className="min-w-0">
                <dt className="text-muted-foreground">{t("host.identity")}</dt>
                <dd className="mt-1 break-all select-text">
                  {state.hello.hostId || t("host.legacy")}
                </dd>
              </div>
              {state.hello.hostInstanceId && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t("host.instance")}
                  </dt>
                  <dd className="mt-1 break-all select-text">
                    {state.hello.hostInstanceId}
                  </dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t("host.capabilities")}
                </dt>
                {state.hello.capabilities.length === 0 ? (
                  <dd className="mt-1 text-muted-foreground">
                    {t("host.capability.none")}
                  </dd>
                ) : (
                  state.hello.capabilities.map((name) => (
                    <dd key={name} className="mt-1 break-all select-text">
                      {name}
                    </dd>
                  ))
                )}
              </div>
            </dl>
          </details>
        )}
      </SettingsGroup>
      <GatewaySection
        identity={identity}
        onCurrentRevoked={() => setIdentityEpoch((epoch) => epoch + 1)}
      />
      <HostIdentityPanel
        key={identityEpoch}
        hello={state.status === "connected" ? state.hello : undefined}
        onSession={onSession}
      />
    </>
  );
}
