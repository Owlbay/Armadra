import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Usage } from "@armadra/shared";

import { runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { t, usePreferencesStore } from "./preferences-store";

/** 提示过一次就记下，之后不再弹。 */
export const USAGE_POLICY_NOTICE_KEY = "armadra.usagePolicyNotice.v1";

/** 快照里因出站政策默认关、而本机看起来在用的那几家。 */
export function policyOffProviders(usage: Usage | undefined): string[] {
  return (usage?.providers ?? [])
    .filter(
      (provider) =>
        provider.status === "unavailable" && provider.reason === "policy_off",
    )
    .map((provider) => provider.id);
}

function noticeShown(): boolean {
  try {
    return localStorage.getItem(USAGE_POLICY_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

function markNoticeShown(): void {
  try {
    localStorage.setItem(USAGE_POLICY_NOTICE_KEY, "1");
  } catch {
    // 存不下就下次再提示一次，不是错误。
  }
}

/**
 * Claude / Copilot 的额度读取改成默认关（外部服务 §9.3）。以前看得到额度的
 * 人升级后胶囊里那一家会消失，所以第一次在快照里看到 `policy_off` 时说一句，
 * 并给一个直达「账号与用量」的按钮；只说一次。
 *
 * 只读用量胶囊已经在轮询的那份缓存（`enabled: false`），自己不发请求。
 */
export function useUsagePolicyNotice(): void {
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: () => runtimeApi.usage(),
    enabled: false,
  });
  const providers = policyOffProviders(usage.data);
  const key = providers.join(",");
  useEffect(() => {
    if (key === "" || noticeShown()) return;
    markNoticeShown();
    const names = key
      .split(",")
      .map((id) => t(`usage.provider.${id}`))
      .join(t("usage.policy.separator"));
    toast.info(t("usage.policy.notice", { providers: names }), {
      action: {
        label: t("usage.policy.open"),
        onClick: () => {
          usePreferencesStore.getState().setLastSettingsSection("account");
          useCanvasStore.getState().setPanel("settings", true);
        },
      },
    });
  }, [key]);
}
