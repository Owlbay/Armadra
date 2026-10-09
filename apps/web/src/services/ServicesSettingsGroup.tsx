import { usePreferencesStore, useT } from "../app/preferences-store";
import { activeConnection } from "../mobile/connections";
import { isNativeApp } from "../mobile/native-bridge";
import { SettingsGroup } from "../panels/settings/SettingsGroup";
import { SettingsRow } from "../panels/settings/SettingsRow";
import { useCurrentSource } from "../sources/context";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { serviceRowOf } from "./rows";
import { switchService } from "./switcher";

/**
 * 设置里的「服务」一组（A7-1，多端入口设计 §1.4）：当前服务与「切换服务」；原生
 * App 另有「启动时直接进入上次的服务」。手机放在设置首页顶部，桌面与服务器壳
 * 放在远程访问页顶部。「退出登录」在账号页，不与它混在一起。
 */
export function ServicesSettingsGroup() {
  const t = useT();
  const current = useCurrentSource();
  const native = isNativeApp();
  const autoEnter = usePreferencesStore((state) => state.servicesAutoEnter);
  const setAutoEnter = usePreferencesStore(
    (state) => state.setServicesAutoEnter,
  );
  // 原生 App 里选中的连接装成了本机源：名字与到达方式取连接表里那一行。
  const descriptor =
    native && current.descriptor.kind === "local"
      ? (activeConnection() ?? current.descriptor)
      : current.descriptor;
  const row = serviceRowOf(descriptor);
  const name = row.name || t("remote.kind.local");
  const via = row.routes
    .map((route) =>
      route.via === "direct"
        ? t("services.via.direct")
        : t("services.via.relay", { name: route.serviceName }),
    )
    .join(" · ");
  return (
    <SettingsGroup title={t("services.group")}>
      <SettingsRow
        label={t("services.current")}
        {...(via !== ""
          ? { footnote: `${name} · ${via}` }
          : { footnote: name })}
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-action="switch-service"
          onClick={switchService}
        >
          {t("services.switch")}
        </Button>
      </SettingsRow>
      {native && (
        <SettingsRow label={t("services.autoEnter")}>
          <Switch
            checked={autoEnter}
            aria-label={t("services.autoEnter")}
            onCheckedChange={setAutoEnter}
          />
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
