import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { useT } from "../../../app/preferences-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { Button } from "@/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { ScrollArea } from "@/ui/scroll-area";
import { Spinner } from "@/ui/spinner";

/**
 * 第三方声明全文：仓库根的 `THIRD_PARTY_NOTICES.md`（`tools/notices.mjs` 生成，
 * `pnpm check` 防漂移）在构建时作为单独的 chunk 打进页面，只在打开对话框时
 * 才加载。正文是各包许可证原文，不翻译。
 */
export function loadThirdPartyNotices(): Promise<string> {
  return import("../../../../../../THIRD_PARTY_NOTICES.md?raw").then(
    (module) => module.default,
  );
}

/** 设置 → 关于（§24.1）：版本、检查更新（占位禁用）、开源许可。 */
export function AboutPage() {
  const t = useT();
  const [licenses, setLicenses] = React.useState(false);
  const notices = useQuery({
    queryKey: ["third-party-notices"],
    queryFn: loadThirdPartyNotices,
    enabled: licenses,
    staleTime: Infinity,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });

  return (
    <>
      <SettingsGroup>
        <SettingsRow label={t("settings.version")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {health.data?.version ?? "—"}
          </span>
        </SettingsRow>

        <SettingsRow label={t("settings.checkUpdate")}>
          <Button variant="secondary" size="sm" disabled>
            {t("settings.checkUpdate.run")}
          </Button>
        </SettingsRow>

        <SettingsRow label={t("settings.licenses")}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLicenses(true)}
          >
            {t("settings.licenses.view")}
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <ResponsiveDialog open={licenses} onOpenChange={setLicenses}>
        <ResponsiveDialogContent className="z-[var(--z-dialog)] sm:max-w-[720px]">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t("settings.licenses")}
            </ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          {notices.data === undefined ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner aria-label={t("settings.licenses.loading")} />
            </div>
          ) : (
            <ScrollArea className="h-[60vh]">
              <pre className="whitespace-pre-wrap break-words pr-3 font-mono text-[12px] leading-relaxed text-muted-foreground">
                {notices.data}
              </pre>
            </ScrollArea>
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  );
}
