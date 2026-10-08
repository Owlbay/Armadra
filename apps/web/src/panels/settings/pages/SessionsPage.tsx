import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { runtimeApi } from "../../../api/client";
import {
  CONVERSATION_SCOPES,
  type ConversationScope,
} from "../../../api/settings";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { ScopeBadge } from "../scope-badge";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** 数据目录信息的查询键：本机服务页的「数据」组读同一份。 */
export const DATA_INFO_KEY = ["data-info"] as const;

/**
 * 设置 → 会话（§2.1）：自动命名（本设备）与会话索引——索引范围、条数、重建。
 */
export function SessionsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { settings, save } = useRuntimeSettings();
  const autoTitle = usePreferencesStore((state) => state.autoTitle);
  const setAutoTitle = usePreferencesStore((state) => state.setAutoTitle);
  const info = useQuery({
    queryKey: DATA_INFO_KEY,
    queryFn: runtimeApi.dataInfo,
    retry: false,
  });
  const rebuild = useMutation({
    mutationFn: runtimeApi.refreshConversations,
    onSuccess: (report) => {
      void queryClient.invalidateQueries({ queryKey: DATA_INFO_KEY });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast.success(t("settings.rebuild.done", { value: report.total }));
    },
    onError: (cause: Error) =>
      toast.error(t("settings.saveFailed"), { description: cause.message }),
  });

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label={t("settings.autoTitle.label")}
          footnote={t("settings.autoTitle.note")}
        >
          <ScopeBadge scope="device" />
          <Switch
            checked={autoTitle}
            aria-label={t("settings.autoTitle.label")}
            onCheckedChange={setAutoTitle}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("settings.conversations")}>
        <SettingsRow
          label={t("settings.conversations.scope")}
          footnote={t("settings.conversations.scopeNote")}
        >
          <Select
            value={settings.data?.conversations?.scope ?? "workspaces"}
            disabled={!settings.data}
            onValueChange={(value) =>
              save.mutate({
                conversations: { scope: value as ConversationScope },
              })
            }
          >
            <SelectTrigger
              aria-label={t("settings.conversations.scope")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {CONVERSATION_SCOPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {t(`settings.conversations.scope.${scope}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t("agents.sessions.indexed")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {info.data
              ? t("settings.conversationCount", {
                  value: info.data.conversations,
                })
              : "—"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            {t("settings.rebuild")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
