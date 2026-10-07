import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { hasInvitationFragment } from "../api/accounts";
import {
  hasPairingFragment,
  onIdentitySessionChange,
  resumeIdentity,
  type IdentitySession,
} from "../api/identity";
import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import {
  hasOAuthFragment,
  hasPasswordResetFragment,
  takePasswordResetToken,
} from "../api/security";
import { ResetPassword } from "../session/ResetPassword";
import { SignIn } from "../session/SignIn";
import { useCanvasStore } from "../store/canvas-store";
import { ACCESS_QUERY_KEY } from "./use-access";
import { usePreferencesStore } from "./preferences-store";

let pendingReset: string | null = null;

/**
 * 地址栏里的重置令牌只取一次（取走即抹掉片段）。放在模块里而不是 state 初值：
 * StrictMode 会把初值函数跑两遍，第二遍已经读不到片段了。
 */
function takeResetOnce(): string {
  pendingReset ??= takePasswordResetToken();
  return pendingReset;
}

/** 测试用：忘掉上一次取走的令牌。 */
export function forgetPendingReset(): void {
  pendingReset = null;
}

/**
 * 服务器壳 / Gateway 来源的整页入口（设计系统 §5.9，G5-03）。
 *
 *  - 地址栏带 `#reset=<令牌>`：整页「设置新口令」，设好后转到登录。
 *  - 没有会话：整页登录，没有侧栏也没有画布——没登录时它们的每个请求都是 401。
 *  - 带着邀请、配对或 OAuth 回调的片段：照旧进壳，由设置里那几页接手（兑换邀请
 *    就是注册，OAuth 第二步在安全页）。
 *  - 问不到会话（离线、core 旧）：照旧进壳，不挡路。
 *
 * 桌面窗口与原生 App 不经过这里：前者「已登录」是进程内的事实，后者的入口在
 * `mobile/entry.ts`。
 */
export function IdentityGate({
  children,
  server = RUNTIME_VIA_SERVER_SHELL,
}: {
  children: React.ReactNode;
  server?: boolean;
}) {
  const client = useQueryClient();
  const [reset, setReset] = React.useState(() =>
    server ? takeResetOnce() : "",
  );
  const [account, setAccount] = React.useState("");
  const [linked] = React.useState(
    () =>
      server &&
      (hasInvitationFragment() || hasPairingFragment() || hasOAuthFragment()),
  );
  const gated = server && !linked;

  // 同一个标签页里贴进重置链接只改了片段、不重载页面：在这里接住。
  React.useEffect(() => {
    if (!server) return;
    const onHash = () => {
      if (!hasPasswordResetFragment()) return;
      pendingReset = takePasswordResetToken();
      setReset(pendingReset);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [server]);

  // 登出、换会话都会广播：没有会话时整页登录要接得住，有了要退出登录页。
  React.useEffect(() => {
    if (!gated) return;
    return onIdentitySessionChange(
      () => void client.invalidateQueries({ queryKey: ACCESS_QUERY_KEY }),
    );
  }, [client, gated]);

  const session = useQuery({
    queryKey: ACCESS_QUERY_KEY,
    queryFn: () => resumeIdentity(),
    enabled: gated && reset === "",
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  if (server && reset !== "") {
    return (
      <FullPage>
        <ResetPassword
          token={reset}
          onSignIn={(principalId) => {
            pendingReset = "";
            setAccount(principalId);
            setReset("");
          }}
        />
      </FullPage>
    );
  }
  if (!gated) return <>{children}</>;
  if (session.isPending) return null;
  if (session.isError || session.data !== null) return <>{children}</>;
  return (
    <FullPage>
      <SignIn
        {...(account ? { initial: { account, step: "password" } } : {})}
        onSignedIn={(next: IdentitySession, mfaEnrollmentRequired) => {
          client.setQueryData(ACCESS_QUERY_KEY, next);
          void client.invalidateQueries();
          // 策略要求第二因素而还没登记：进壳后直接打开「安全」去登记（§18.3）。
          if (mfaEnrollmentRequired) {
            usePreferencesStore.getState().setLastSettingsSection("security");
            useCanvasStore.getState().setPanel("settings", true);
          }
        }}
      />
    </FullPage>
  );
}

/** 整页：没有侧栏，内容在视口里居中，窄屏可滚。 */
function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="identity-page"
      className="flex h-full overflow-y-auto bg-background pt-[var(--safe-top)] pr-[calc(1.5rem+var(--safe-right))] pb-[var(--safe-bottom)] pl-[calc(1.5rem+var(--safe-left))]"
    >
      <div className="m-auto w-full">{children}</div>
    </div>
  );
}
