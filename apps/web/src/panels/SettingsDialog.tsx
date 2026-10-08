import * as React from "react";
import { ChevronLeft, X } from "lucide-react";

import { RUNTIME_VIA_SERVER_SHELL } from "../api/request";
import { usePreferencesStore, useT } from "../app/preferences-store";
import { useAccess } from "../app/use-access";
import { useCanvasStore } from "../store/canvas-store";
import { SECTION_PAGES } from "./settings/pages";
import { ScopeBadge } from "./settings/scope-badge";
import { useRemoteAccess } from "./settings/remote-access";
import { subpageTitleKey } from "./settings/subpage";
import {
  activeSectionId,
  groupSections,
  settingsSection,
  visibleSettingsSections,
  type SettingsSection,
} from "./settings/nav";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
} from "@/panels/ResponsiveDialog";
import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { useCompactLayout } from "@/platform/layout";

/**
 * 弹窗尺寸（设计系统 §2.7）。桌面按视口比例取 `--settings-dialog-w/h`（不封顶，
 * 屏越大弹窗越大），再夹进视口减 48px 与安全区；平板（768–1023）满宽减 32、
 * 满高减 48。
 */
export const SETTINGS_DIALOG_CLASS = cn(
  "h-[var(--settings-dialog-h)] w-[var(--settings-dialog-w)]",
  "max-h-[calc(100dvh-48px-var(--safe-top)-var(--safe-bottom))]",
  "max-w-[calc(100vw-48px-var(--safe-left)-var(--safe-right))] sm:max-w-[calc(100vw-48px-var(--safe-left)-var(--safe-right))]",
  "max-lg:h-[calc(100dvh-48px-var(--safe-top)-var(--safe-bottom))] max-lg:w-[calc(100vw-32px)]",
  "max-lg:max-w-[calc(100vw-32px)] max-lg:sm:max-w-[calc(100vw-32px)]",
);

/**
 * 手机底部 Sheet 取整高：有左导航，`auto` 高度会让导航与正文抢高度。带
 * `data-[side=bottom]:` 是为了压过 Sheet 自己那条同变体的 `h-auto`。
 */
export const SETTINGS_SHEET_CLASS =
  "data-[side=bottom]:h-[calc(100dvh-48px-var(--safe-top))]";

/**
 * 设置（⌘,，§24.1）。
 *
 * 分栏设置：居中对话框，左侧导航（`clamp(176px, 16%, 240px)`），右侧是**当前
 * 分区独立的一页**——切分区整页替换，没有跨分区滚动，也没有搜索框与 scroll-spy。
 * 子页（SSH 主机、自定义 Agent）在同一右栏里推入，页头换成「← 子页名」，
 * 不叠第二层对话框。
 */
export function SettingsDialog() {
  const t = useT();
  const compact = useCompactLayout();
  const open = useCanvasStore((state) => state.panels.settings);
  const setPanel = useCanvasStore((state) => state.setPanel);
  const closeSubpage = usePreferencesStore((state) => state.setSettingsSubpage);

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        // 关掉设置就丢掉子页：重开时该回到分区页，而不是停在一张表单上。
        if (!next) closeSubpage(null);
        setPanel("settings", next);
      }}
    >
      <ResponsiveDialogContent
        showCloseButton={false}
        data-testid="settings-dialog"
        className={cn(
          "z-[var(--z-dialog)] gap-0 overflow-hidden rounded-[14px] p-0",
          compact ? SETTINGS_SHEET_CLASS : SETTINGS_DIALOG_CLASS,
        )}
      >
        <ResponsiveDialogTitle className="sr-only">
          {t("settings.title")}
        </ResponsiveDialogTitle>
        <SettingsBody onClose={() => setPanel("settings", false)} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const t = useT();
  const stored = usePreferencesStore((state) => state.lastSettingsSection);
  const remember = usePreferencesStore((state) => state.setLastSettingsSection);
  const subpage = usePreferencesStore((state) => state.settingsSubpage);
  const setSubpage = usePreferencesStore((state) => state.setSettingsSubpage);

  // 成员看不到本机管理的那几页（`nav.ts` 的 `ownerOnly`）；上次停在其中一页
  // 的，回到第一页。
  const { member } = useAccess();
  // 设置作用的 core 不在眼前（经中继、直连远端源、当前源是远程源）：只对本机
  // 有意义的那几页不列（`nav.ts` 的 `localOnly`）。
  const { remote } = useRemoteAccess();
  // 存着的可能是上一版的分区 id（`LEGACY_SECTION_IDS`）：先映射再判断。
  const active = activeSectionId(stored, member, remote);
  const section = settingsSection(active);
  const Page = SECTION_PAGES[active] ?? SECTION_PAGES.defaults!;
  const groups = React.useMemo(
    () =>
      groupSections(
        visibleSettingsSections(RUNTIME_VIA_SERVER_SHELL, member, remote),
      ),
    [member, remote],
  );

  return (
    <div className="settings-layout flex h-full min-h-0 flex-row">
      <nav
        aria-label={t("settings.title")}
        className="settings-navigation flex h-full w-[clamp(176px,16%,240px)] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-panel p-3"
      >
        {groups.map((group) => (
          <div key={group.groupKey} className="flex flex-col gap-0.5">
            <div className="settings-nav-group px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              {t(group.groupKey)}
            </div>
            {group.sections.map((item) => (
              <NavItem
                key={item.id}
                section={item}
                active={item.id === active}
                onSelect={remember}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border/60 px-6">
          {subpage && (
            <IconButton
              size="cluster"
              label={t("settings.back")}
              onClick={() => setSubpage(null)}
            >
              <ChevronLeft />
            </IconButton>
          )}
          <h2
            data-testid="settings-heading"
            className="min-w-0 flex-1 truncate text-[17px] font-semibold"
          >
            {t(subpage ? subpageTitleKey(subpage) : section.labelKey)}
          </h2>
          <ScopeBadge scope={section.scope} pinnedLocal={section.pinnedLocal} />
          <IconButton size="cluster" label={t("tab.close")} onClick={onClose}>
            <X />
          </IconButton>
        </header>

        <div
          key={subpage ?? active}
          data-testid="settings-page"
          data-section={active}
          className="settings-page flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-8 duration-150 animate-in fade-in motion-reduce:animate-none"
        >
          {/* 正文列随弹窗变宽：表格页（远程机器、快捷键、设备）天然受益。 */}
          <div
            data-slot="settings-column"
            className="flex w-full flex-col gap-6"
          >
            <Page />
          </div>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const Icon = section.icon;
  return (
    <Button
      variant="ghost"
      size="xs"
      type="button"
      data-active={active}
      aria-current={active ? "page" : undefined}
      title={t(section.labelKey)}
      aria-label={t(section.labelKey)}
      className={cn(
        "flex h-8 w-full items-center justify-start gap-2 rounded-lg px-2 text-left text-[13px] font-normal text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground",
        "data-[active=true]:bg-raised data-[active=true]:text-foreground",
      )}
      onClick={() => onSelect(section.id)}
    >
      <Icon className="size-4 shrink-0" strokeWidth={1.5} />
      <span className="settings-nav-label truncate">{t(section.labelKey)}</span>
    </Button>
  );
}
