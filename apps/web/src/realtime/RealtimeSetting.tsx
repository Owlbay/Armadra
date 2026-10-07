import { completionSettingsSchema } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { useAccess } from "@/app/use-access";
import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { useRuntimeSettings } from "@/panels/settings/use-runtime-settings";
import { Switch } from "@/ui/switch";

/**
 * 设置里的「实时协同」开关（`collab.realtime`，缺省开；补全架构 §14 Q2）。
 * 关掉之后新板留在租约 + CAS；已经是实时板的在没人连着时退回租约模式
 * （契约 §16.2）。全局设置，只有 owner 能改，成员不显示。
 */
export function RealtimeSetting() {
  // 成员读不到设置文档（`GET /api/settings` 是 403）：连请求都不发。
  const member = useAccess().member;
  return member ? null : <RealtimeSettingRow />;
}

function RealtimeSettingRow() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const enabled = settings.data
    ? completionSettingsSchema.parse(settings.data).collab.realtime
    : true;
  return (
    <SettingsGroup>
      <SettingsRow label={t("realtime.setting")}>
        <Switch
          checked={enabled}
          disabled={!settings.data || save.isPending}
          aria-label={t("realtime.setting")}
          onCheckedChange={(next) =>
            save.mutate({ collab: { realtime: next } })
          }
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
