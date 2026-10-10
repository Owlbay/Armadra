import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { runtimeApi } from "../api/client";
import { usePreferencesStore } from "./preferences-store";
import { useAccess } from "./use-access";

/**
 * 把界面语言抄一份给 core 的设备级设置 `ui.locale`（契约 §57.6）。
 *
 * 语言仍以本机 localStorage 为准（`preferences-store.ts`）；core 只拿它生成
 * 终端里 Claude Code mod 需要词的地方，所以这里只做单向镜像：读到的设置文档
 * 与当前语言不一致就写一次，换语言后下一帧再写。写失败不提示，下次再对。
 *
 * 服务器壳上的成员读写不了整台机器的设置（403），不镜像。
 */
export function useLocaleMirror(): void {
  const client = useQueryClient();
  const member = useAccess().member;
  const locale = usePreferencesStore((state) => state.locale);
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: runtimeApi.settings,
    retry: false,
    staleTime: 30_000,
    enabled: !member,
  });
  const stored = settings.data?.ui?.locale;
  const loaded = settings.data !== undefined;
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (member || !loaded || stored === locale) return;
    if (pending.current === locale) return;
    pending.current = locale;
    void runtimeApi
      .updateSettings({ ui: { locale } })
      .then((next) => client.setQueryData(["settings"], next))
      .catch(() => undefined)
      .finally(() => {
        if (pending.current === locale) pending.current = null;
      });
  }, [member, loaded, stored, locale, client]);
}
