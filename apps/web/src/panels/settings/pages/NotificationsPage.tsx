import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { playStatusSound } from "../../../app/notifications";
import { useAccess } from "../../../app/use-access";
import { useRemoteAccess } from "../remote-access";
import { ScopeBadge } from "../scope-badge";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Button } from "@/ui/button";
import { Slider } from "@/ui/slider";
import { Switch } from "@/ui/switch";

/**
 * 设置 → 通知（§24.1）。
 *
 * 「完成」与「需要你」是两条独立的开关：前者是可以攒着看的，后者是挡住
 * 进度的，用户经常只想要后一条。提示音仍然共用一个开关 + 一个音量。
 *
 * 「更新下载完成」是主机设置（`updates.notify`，从原更新页移来，§2.2）：
 * 行尾一枚作用范围徽标；成员读不到设置文档，远端主机的更新由那台自己的壳
 * 做，这两种情况都不画。
 */
export function NotificationsPage() {
  const t = useT();
  const { member } = useAccess();
  const { remote } = useRemoteAccess();
  const notifyDone = usePreferencesStore((state) => state.notifyDone);
  const setNotifyDone = usePreferencesStore((state) => state.setNotifyDone);
  const notifyNeedsYou = usePreferencesStore((state) => state.notifyNeedsYou);
  const setNotifyNeedsYou = usePreferencesStore(
    (state) => state.setNotifyNeedsYou,
  );
  const sound = usePreferencesStore((state) => state.sound);
  const setSound = usePreferencesStore((state) => state.setSound);
  const volume = usePreferencesStore((state) => state.soundVolume);
  const setVolume = usePreferencesStore((state) => state.setSoundVolume);

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label={t("settings.notifyDone")}
          footnote={t("settings.notify.note")}
        >
          <Switch
            checked={notifyDone}
            aria-label={t("settings.notifyDone")}
            onCheckedChange={setNotifyDone}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.notifyNeedsYou")}>
          <Switch
            checked={notifyNeedsYou}
            aria-label={t("settings.notifyNeedsYou")}
            onCheckedChange={setNotifyNeedsYou}
          />
        </SettingsRow>

        {member || remote ? null : <UpdateNotifyRow />}
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t("settings.sound")}>
          <Switch
            checked={sound}
            aria-label={t("settings.sound")}
            onCheckedChange={setSound}
          />
        </SettingsRow>

        <SettingsRow label={t("settings.soundVolume")}>
          <Slider
            className="w-[168px]"
            aria-label={t("settings.soundVolume")}
            disabled={!sound}
            min={0}
            max={100}
            step={5}
            value={[volume]}
            onValueChange={([next]) => setVolume(next ?? 0)}
          />
          <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground">
            {volume}
          </span>
        </SettingsRow>

        <SettingsRow label={t("settings.soundPreview")}>
          <Button
            variant="secondary"
            size="sm"
            disabled={!sound}
            onClick={() => playStatusSound("done")}
          >
            {t("settings.preview.done")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!sound}
            onClick={() => playStatusSound("attention")}
          >
            {t("settings.preview.attention")}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function UpdateNotifyRow() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  return (
    <SettingsRow
      label={t("updates.notify")}
      footnote={t("updates.notify.note")}
    >
      <ScopeBadge scope="host" />
      <Switch
        checked={settings.data?.updates?.notify ?? true}
        disabled={!settings.data}
        aria-label={t("updates.notify")}
        onCheckedChange={(next) => save.mutate({ updates: { notify: next } })}
      />
    </SettingsRow>
  );
}
