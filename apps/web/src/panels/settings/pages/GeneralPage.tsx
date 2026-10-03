import { useEffect, useState } from "react";

import { useAccess } from "../../../app/use-access";
import {
  THEME_PREFERENCES,
  usePreferencesStore,
  useT,
  type ThemePreference,
} from "../../../app/preferences-store";
import { LOCALES, type Locale } from "../../../i18n";
import { useCanvasStore } from "../../../store/canvas-store";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Switch } from "@/ui/switch";

/** 右侧控件统一宽度，让一页里的 Select 右边缘对齐（§24.2 的 8pt 网格）。 */
export const CONTROL_WIDTH = "w-[168px]";

/**
 * 设置 → 通用（§24.1）：主题、语言、侧栏、用量、恢复上次工作空间、
 * 系统文件、开屏动画；最后一组是诊断（可选崩溃上报，外部服务 §11.2）。
 */
export function GeneralPage() {
  const t = useT();
  const { member } = useAccess();
  const theme = usePreferencesStore((state) => state.theme);
  const setTheme = usePreferencesStore((state) => state.setTheme);
  const locale = usePreferencesStore((state) => state.locale);
  const setLocale = usePreferencesStore((state) => state.setLocale);
  const showUsage = usePreferencesStore((state) => state.showUsage);
  const setShowUsage = usePreferencesStore((state) => state.setShowUsage);
  const restore = usePreferencesStore((state) => state.restoreLastWorkspace);
  const setRestore = usePreferencesStore(
    (state) => state.setRestoreLastWorkspace,
  );
  const splash = usePreferencesStore((state) => state.splashAnimation);
  const setSplash = usePreferencesStore((state) => state.setSplashAnimation);
  const systemFiles = usePreferencesStore((state) => state.showSystemFiles);
  const setSystemFiles = usePreferencesStore(
    (state) => state.setShowSystemFiles,
  );
  // 侧栏与 ⌘⇧L / 控制簇按钮共用同一个面板状态；`setPanel` 自己会把
  // 「展开与否」写进偏好，所以这里改的既是当前状态也是下次打开的默认。
  const sidebarOpen =
    useCanvasStore((state) => state.panels.sidebar) === "open";
  const setPanel = useCanvasStore((state) => state.setPanel);

  return (
    <>
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

      <SettingsGroup>
        <SettingsRow label={t("settings.sidebar")}>
          <Switch
            checked={sidebarOpen}
            aria-label={t("settings.sidebar")}
            onCheckedChange={(next) =>
              setPanel("sidebar", next ? "open" : "collapsed")
            }
          />
        </SettingsRow>

        <SettingsRow label={t("settings.showUsage")}>
          <Switch
            checked={showUsage}
            aria-label={t("settings.showUsage")}
            onCheckedChange={setShowUsage}
          />
        </SettingsRow>

        <SettingsRow
          label={t("settings.restoreWorkspace")}
          footnote={t("settings.restoreWorkspace.note")}
        >
          <Switch
            checked={restore}
            aria-label={t("settings.restoreWorkspace")}
            onCheckedChange={setRestore}
          />
        </SettingsRow>

        <SettingsRow
          label={t("settings.showSystemFiles")}
          footnote={t("settings.showSystemFiles.note")}
        >
          <Switch
            checked={systemFiles}
            aria-label={t("settings.showSystemFiles")}
            onCheckedChange={setSystemFiles}
          />
        </SettingsRow>

        <SettingsRow
          label={t("settings.splashAnimation")}
          footnote={t("settings.splashAnimation.note")}
        >
          <Switch
            checked={splash}
            aria-label={t("settings.splashAnimation")}
            onCheckedChange={setSplash}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* 设置文档只有 owner 读得到：成员这里不摆、也不去问（否则就是一次 403）。 */}
      {member ? null : <DiagnosticsGroup />}
    </>
  );
}

/**
 * 与 core / 壳的 `parseDsn` 同一条规则：`http(s)://<公钥>@<主机>/<项目>`。
 * 页面只用它决定存不存；壳那边还会再校验一次。
 */
export function isCrashReportDsn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 512) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username === "" || url.hostname === "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  const project = url.pathname.split("/").filter(Boolean).pop();
  return project !== undefined && /^[A-Za-z0-9_-]+$/.test(project);
}

/**
 * 诊断：崩溃上报默认关。打开后填 DSN 才真的开始发（`diagnostics.crashReportDsn`
 * 非空）；关掉即把 DSN 清空。
 */
function DiagnosticsGroup() {
  const t = useT();
  const { settings, save } = useRuntimeSettings();
  const saved = settings.data?.diagnostics?.crashReportDsn ?? "";
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  if (!settings.data) return null;

  const enabled = saved !== "" || opened;
  const trimmed = draft.trim();
  const invalid = trimmed !== "" && !isCrashReportDsn(trimmed);
  const commit = () => {
    if (invalid || trimmed === "" || trimmed === saved) return;
    save.mutate({ diagnostics: { crashReportDsn: trimmed } });
  };

  return (
    <SettingsGroup>
      <SettingsRow
        label={t("settings.diagnostics.crashReports")}
        footnote={t("settings.diagnostics.crashReports.note")}
      >
        <Switch
          checked={enabled}
          aria-label={t("settings.diagnostics.crashReports")}
          onCheckedChange={(next) => {
            setOpened(next);
            if (next) return;
            setDraft("");
            if (saved !== "")
              save.mutate({ diagnostics: { crashReportDsn: "" } });
          }}
        />
      </SettingsRow>
      {enabled && (
        <SettingsRow
          label={t("settings.diagnostics.dsn")}
          footnote={invalid ? t("settings.diagnostics.dsnInvalid") : undefined}
        >
          <Input
            aria-label={t("settings.diagnostics.dsn")}
            aria-invalid={invalid || undefined}
            type="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={512}
            placeholder="https://key@host/1"
            className={`h-8 text-xs ${CONTROL_WIDTH}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
