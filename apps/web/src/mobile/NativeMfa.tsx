import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useT, usePreferencesStore } from "../app/preferences-store";
import { SignIn } from "../session/SignIn";
import { useCanvasStore } from "../store/canvas-store";
import { Button } from "@/ui/button";

/**
 * 原生 App 没有会话时 OAuth 登录的第二步（契约 §18.5 的 `mfa`，G5-22 残项）。
 *
 * 与网页登录同一个组件、同一条 `mfa/verify`：`SignIn` 带着中间票直接停在第二
 * 步，码对了就换出会话（原生传输上会话密钥进钥匙串），然后进画布。策略要求
 * 第二因素而还没登记时与 `IdentityGate` 一样，进画布后打开「安全」。中间票过期
 * 时 `SignIn` 自己回到账号步，可以改用口令或通行密钥登录。
 *
 * 还在 `App` 之外（没有它的 QueryClient），所以自带一个。
 */
export function NativeMfa({
  challengeId,
  onSignedIn,
  onBack,
}: {
  challengeId: string;
  onSignedIn(): void;
  onBack(): void;
}) {
  const t = useT();
  const [client] = React.useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <main
        data-slot="native-mfa"
        className="flex min-h-[100dvh] w-full flex-col items-center overflow-y-auto bg-background px-6 pt-[max(env(safe-area-inset-top),15vh)] pb-[max(env(safe-area-inset-bottom),24px)]"
      >
        <div className="flex w-full max-w-sm flex-col gap-2">
          <SignIn
            initial={{ step: "mfa", challengeId }}
            onSignedIn={(_session, mfaEnrollmentRequired) => {
              if (mfaEnrollmentRequired) {
                usePreferencesStore
                  .getState()
                  .setLastSettingsSection("security");
                useCanvasStore.getState().setPanel("settings", true);
              }
              onSignedIn();
            }}
          />
          <Button
            type="button"
            size="lg"
            variant="ghost"
            className="h-11 w-full"
            onClick={onBack}
          >
            {t("mobileConnect.backToConnect")}
          </Button>
        </div>
      </main>
    </QueryClientProvider>
  );
}
