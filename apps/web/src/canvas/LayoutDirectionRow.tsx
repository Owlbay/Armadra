import {
  LAYOUT_DIRECTION_CHOICES,
  type LayoutDirection,
} from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import { CONTROL_WIDTH } from "@/panels/settings/pages/GeneralPage";
import { useRuntimeSettings } from "@/panels/settings/use-runtime-settings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { layoutDirectionOf } from "./layout-direction";

/**
 * 设置 → 画布的「布局方向」一行（契约 §50）。值存在主机设置里：core 的放置也
 * 读它，同一块画布在手机与桌面上排法一致。存好后画布经同一个设置查询同步。
 */
export function LayoutDirectionRow() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const value = layoutDirectionOf(settings.data);
  return (
    <SettingsRow label={t("canvas.layoutDirection")}>
      <Select
        value={value}
        disabled={!settings.data || save.isPending}
        onValueChange={(next) =>
          save.mutate({
            canvas: { layoutDirection: next as LayoutDirection },
          })
        }
      >
        <SelectTrigger
          aria-label={t("canvas.layoutDirection")}
          size="sm"
          className={CONTROL_WIDTH}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {LAYOUT_DIRECTION_CHOICES.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`canvas.layoutDirection.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
