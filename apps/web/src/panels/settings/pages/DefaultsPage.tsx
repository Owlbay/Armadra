import * as React from "react";
import {
  AGENT_DRIVERS,
  supportedPermissionModes,
  type AgentDriver,
  type PermissionMode,
} from "@armadra/shared";

import { driverSettingOf } from "@/acp/driver";
import { useSimpleModeStore } from "@/acp/simple-mode";
import { useAccess } from "../../../app/use-access";
import { useAgentsQuery } from "../../../app/use-agents";
import {
  THEME_PREFERENCES,
  usePreferencesStore,
  useT,
  type ThemePreference,
} from "../../../app/preferences-store";
import { LOCALES, type Locale } from "../../../i18n";
import { isNativeApp } from "../../../mobile/native-bridge";
import { ServicesSettingsGroup } from "../../../services/ServicesSettingsGroup";
import { ScopeBadge } from "../scope-badge";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { CONTROL_WIDTH } from "./GeneralPage";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/**
 * 设置 → 默认（§2.1）：新建节点最常动的几项与主题、语言。
 *
 * 整页写本设备；只有「Agent 默认视图」是主机设置（`agents.defaultDriver`），
 * 行尾一枚作用范围徽标说清楚。成员读不到设置文档，这一行对成员不画。
 */
export function DefaultsPage() {
  const { member } = useAccess();
  return (
    <>
      {/* 手机与 iPad：设置首页顶部是「服务」（A7-1）。 */}
      {isNativeApp() && <ServicesSettingsGroup />}
      <SettingsGroup>
        {member ? null : <DefaultDriverRow />}
        <AgentDefaultRows />
      </SettingsGroup>
      <AppearanceGroup />
    </>
  );
}

function DefaultDriverRow() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  return (
    <SettingsRow label={t("acp.settings.defaultDriver")}>
      <ScopeBadge scope="host" />
      <Select
        value={driverSettingOf(settings.data)}
        disabled={!settings.data}
        onValueChange={(value) =>
          save.mutate({ agents: { defaultDriver: value as AgentDriver } })
        }
      >
        <SelectTrigger
          aria-label={t("acp.settings.defaultDriver")}
          size="sm"
          className={CONTROL_WIDTH}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[var(--z-dialog)]">
          {[...AGENT_DRIVERS].reverse().map((driver) => (
            <SelectItem key={driver} value={driver}>
              {t(driver === "acp" ? "acp.view.session" : "acp.view.terminal")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

/** 默认 Agent、默认权限模式、简洁模式：都存在本设备的偏好里。 */
function AgentDefaultRows() {
  const t = useT();
  const agents = useAgentsQuery();
  const defaultAgentId = usePreferencesStore((state) => state.defaultAgentId);
  const setDefaultAgentId = usePreferencesStore(
    (state) => state.setDefaultAgentId,
  );
  const permissionMode = usePreferencesStore(
    (state) => state.defaultPermissionMode,
  );
  const setPermissionMode = usePreferencesStore(
    (state) => state.setDefaultPermissionMode,
  );
  const simpleMode = useSimpleModeStore((state) => state.simpleMode);
  const setSimpleMode = useSimpleModeStore((state) => state.setSimpleMode);

  const list = agents.data ?? [];
  const selectedAgentId = defaultAgentId ?? list[0]?.id ?? "claude";
  const selectedBase =
    list.find((agent) => agent.id === selectedAgentId)?.baseAgent ??
    selectedAgentId;
  const permissionModes = supportedPermissionModes(selectedBase);
  const effectivePermission = permissionModes.includes(permissionMode)
    ? permissionMode
    : "default";

  // 换了一家不支持当前权限模式的 Agent：落回「默认」，不留一个点不中的值。
  React.useEffect(() => {
    if (effectivePermission !== permissionMode)
      setPermissionMode(effectivePermission);
  }, [effectivePermission, permissionMode, setPermissionMode]);

  return (
    <>
      <SettingsRow label={t("settings.defaultAgent")}>
        <Select
          value={selectedAgentId}
          onValueChange={(id) => {
            const base = list.find((agent) => agent.id === id)?.baseAgent ?? id;
            if (!supportedPermissionModes(base).includes(permissionMode))
              setPermissionMode("default");
            setDefaultAgentId(id);
          }}
        >
          <SelectTrigger
            aria-label={t("settings.defaultAgent")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {list.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow label={t("settings.defaultPermission")}>
        <Select
          value={effectivePermission}
          onValueChange={(value) => setPermissionMode(value as PermissionMode)}
        >
          <SelectTrigger
            aria-label={t("settings.defaultPermission")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {permissionModes.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`permission.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow label={t("acp.settings.simpleMode")}>
        <Switch
          checked={simpleMode}
          aria-label={t("acp.settings.simpleMode")}
          onCheckedChange={setSimpleMode}
        />
      </SettingsRow>
    </>
  );
}

function AppearanceGroup() {
  const t = useT();
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const locale = usePreferencesStore((state) => state.locale);
  const setLocale = usePreferencesStore((state) => state.setLocale);
  return (
    <SettingsGroup>
      <SettingsRow label={t("settings.theme")}>
        <Select
          value={theme}
          onValueChange={(value) => setTheme(value as ThemePreference)}
        >
          <SelectTrigger
            aria-label={t("settings.theme")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {THEME_PREFERENCES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`settings.theme.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow label={t("settings.locale")}>
        <Select
          value={locale}
          onValueChange={(value) => setLocale(value as Locale)}
        >
          <SelectTrigger
            aria-label={t("settings.locale")}
            size="sm"
            className={CONTROL_WIDTH}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[var(--z-dialog)]">
            {LOCALES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`settings.locale.${option}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsGroup>
  );
}
