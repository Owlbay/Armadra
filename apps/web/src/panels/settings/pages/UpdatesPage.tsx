import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { runtimeApi } from "../../../api/client";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import { useCanvasStore } from "../../../store/canvas-store";
import { openExternal } from "../../../platform";
import {
  formatProgress,
  mergeUpdatesState,
  type UpdatesAction,
  type UpdatesView,
} from "../../../updates/state";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  useUpdateState,
} from "../../../updates/use-update-state";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { useRuntimeSettings } from "../use-runtime-settings";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Progress } from "@/ui/progress";
import { Switch } from "@/ui/switch";

/** The channels a person may ask for; a local build is not one of them. */
const CHANNELS = ["stable", "beta"] as const;

/**
 * 设置 → 更新（S03 / docs/design/updates-and-service-install.md §4）。
 *
 * 两个来源：发布侧判断「有没有可用发布」，桌面壳判断「能不能装」。桌面上「检查」
 * 由壳经 `updates:check` 自己问发布索引，壳的答复就是发布侧；浏览器里没有壳，
 * 不问。
 * 合并规则全在 `updates/state.ts` 的纯函数里，这里只负责把它渲染成行——
 * 包括那条最重要的：任何一边没回答，都不写「已是最新」。
 */
export function UpdatesPage() {
  const t = useT();
  const setPanel = useCanvasStore((state) => state.setPanel);
  const { settings, save } = useRuntimeSettings();

  const host = useUpdateState((store) => store.host);
  const shell = useUpdateState((store) => store.shell);
  const restart = useUpdateState((store) => store.restart);
  const start = useUpdateState((store) => store.start);
  const check = useUpdateState((store) => store.check);
  const refresh = useUpdateState((store) => store.refresh);
  const download = useUpdateState((store) => store.download);
  const install = useUpdateState((store) => store.install);
  const dismiss = useUpdateState((store) => store.dismiss);
  const cancel = useUpdateState((store) => store.cancel);
  const acknowledgeRestart = useUpdateState(
    (store) => store.acknowledgeRestart,
  );

  const health = useQuery({
    queryKey: ["health"],
    queryFn: runtimeApi.health,
    retry: false,
  });
  const installed = health.data?.version ?? "";

  const preferences = settings.data?.updates;
  const channel = preferences?.channel ?? "stable";
  const autoCheck = preferences?.autoCheck ?? true;
  const autoDownload = preferences?.autoDownload ?? false;
  const notify = preferences?.notify ?? true;

  React.useEffect(() => start(), [start]);

  const runCheck = React.useCallback(() => {
    void check();
  }, [check]);

  // Design §2.1: 30 seconds after start, then every six hours. The shell runs
  // the check itself on its own schedule (and honours the same switch); the
  // page only reads its answer back. Off means off.
  const runRefresh = React.useCallback(() => {
    void refresh();
  }, [refresh]);
  React.useEffect(() => {
    if (!autoCheck || !installed) return;
    const first = setTimeout(runRefresh, FIRST_CHECK_DELAY_MS);
    const repeat = setInterval(runRefresh, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [autoCheck, installed, runRefresh]);

  const view = mergeUpdatesState(host, shell);

  // `autoDownload` fetches without being asked; installing still never happens
  // without a person (design §2.4, S03 acceptance).
  React.useEffect(() => {
    if (autoDownload && view.state === "available") void download();
  }, [autoDownload, download, view.state]);

  const busy = view.state === "checking";
  const notesUrl = view.offer?.notesUrl || view.release?.notesUrl || "";

  function perform(action: UpdatesAction) {
    switch (action) {
      case "check":
        return runCheck();
      case "cancel":
        return void cancel();
      case "download":
        return void download();
      case "skip":
        return void dismiss();
      case "restart":
        return void install();
      case "retry":
        return void download();
      case "notes":
        return void (notesUrl && openExternal(notesUrl));
      case "openHostSettings":
        usePreferencesStore.getState().setLastSettingsSection("host");
        return setPanel("settings", true);
    }
  }

  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        {t("updates.note")}
      </p>

      {restart && (
        <SettingsGroup title={t("updates.nav")}>
          <SettingsRow
            label={
              restart.outcome === "completed"
                ? t("updates.restart.completed", { value: restart.version })
                : t("updates.restart.incomplete", {
                    value: restart.mismatched
                      .map((part) => t(`updates.component.${part}`))
                      .join(t("updates.listSeparator")),
                  })
            }
          >
            <Button size="sm" variant="secondary" onClick={acknowledgeRestart}>
              {t("updates.restart.dismiss")}
            </Button>
          </SettingsRow>
          {restart.outcome === "incomplete" && restart.previousPackageUrl && (
            <SettingsRow label={t("updates.restart.previous")}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openExternal(restart.previousPackageUrl)}
              >
                {restart.previousVersion}
              </Button>
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      <SettingsGroup>
        <SettingsRow label={t("updates.version")}>
          <span className="text-[13px] tabular-nums text-muted-foreground">
            {installed || t("updates.version.unknown")}
          </span>
        </SettingsRow>

        <SettingsRow label={t("updates.channel")}>
          <Select
            value={channel}
            onValueChange={(value) =>
              save.mutate({
                updates: { channel: value as (typeof CHANNELS)[number] },
              })
            }
          >
            <SelectTrigger
              aria-label={t("updates.channel")}
              size="sm"
              className="w-[160px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {CHANNELS.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {t(`updates.channel.${entry}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("updates.autoCheck")}>
          <Switch
            checked={autoCheck}
            aria-label={t("updates.autoCheck")}
            onCheckedChange={(next) =>
              save.mutate({ updates: { autoCheck: next } })
            }
          />
        </SettingsRow>

        <SettingsRow
          label={t("updates.autoDownload")}
          footnote={t("updates.autoDownload.note")}
        >
          <Switch
            checked={autoDownload}
            aria-label={t("updates.autoDownload")}
            onCheckedChange={(next) =>
              save.mutate({ updates: { autoDownload: next } })
            }
          />
        </SettingsRow>

        <SettingsRow
          label={t("updates.notify")}
          footnote={t("updates.notify.note")}
        >
          <Switch
            checked={notify}
            aria-label={t("updates.notify")}
            onCheckedChange={(next) =>
              save.mutate({ updates: { notify: next } })
            }
          />
        </SettingsRow>

        <UpdateStatusRows
          view={view}
          installed={installed}
          busy={busy}
          notesUrl={notesUrl}
          onAction={perform}
        />
      </SettingsGroup>

      <UpdateStatusNotes view={view} />

      {view.release && (
        <SettingsGroup title={t("updates.release")}>
          <SettingsRow label={view.release.version}>
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
              {t(`updates.channel.${view.release.channel}`)}
            </Badge>
          </SettingsRow>
          {view.release.signature !== "unknown" && (
            <SettingsRow
              label={t("updates.signature")}
              footnote={t(`updates.signature.${view.release.signature}`)}
            />
          )}
        </SettingsGroup>
      )}
    </>
  );
}

/**
 * 状态、进度与动作三行（设计系统 §5.14）：一行文字 + 一个按钮表达状态；下载中
 * 是 `Progress` + 「取消」。只读 `view`，不碰 store——展示页把十一种状态并排
 * 画出来用的就是它。
 */
export function UpdateStatusRows({
  view,
  installed,
  busy,
  notesUrl,
  onAction,
}: {
  view: UpdatesView;
  installed: string;
  busy: boolean;
  notesUrl: string;
  onAction(action: UpdatesAction): void;
}) {
  const t = useT();
  const progress = view.progress;
  return (
    <>
      <SettingsRow label={t("updates.status")}>
        <span
          role="status"
          aria-live="polite"
          className="text-right text-[13px] text-muted-foreground"
        >
          {t(view.statusKey)}
        </span>
      </SettingsRow>

      {progress && (
        <SettingsRow label={t("updates.progress")}>
          <div className="flex w-[200px] max-w-full flex-col items-end gap-1">
            <Progress
              aria-label={t("updates.progress")}
              value={
                progress.totalBytes > 0
                  ? Math.min(
                      100,
                      (progress.receivedBytes / progress.totalBytes) * 100,
                    )
                  : null
              }
            />
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {formatProgress(progress.receivedBytes, progress.totalBytes)}
            </span>
          </div>
        </SettingsRow>
      )}

      {view.actions.length > 0 && (
        <SettingsRow label={null}>
          <div className="flex flex-wrap gap-2">
            {view.actions.map((action, index) => (
              <Button
                key={action}
                size="sm"
                className="min-h-10"
                variant={index === 0 ? "default" : "secondary"}
                disabled={
                  (busy && action !== "cancel") ||
                  (action === "check" && !installed) ||
                  (action === "notes" && !notesUrl)
                }
                onClick={() => onAction(action)}
              >
                {t(
                  action === "check"
                    ? busy
                      ? "updates.checking"
                      : "updates.check"
                    : action === "openHostSettings"
                      ? "updates.blocked.action"
                      : `updates.action.${action}`,
                )}
              </Button>
            ))}
          </div>
        </SettingsRow>
      )}
    </>
  );
}

/**
 * 分组下面的补充句子。失败时它们是错误本身，放进 `Alert destructive`（设计系统
 * §5.14 / §5.16）；其余状态仍是一行灰字。
 */
export function UpdateStatusNotes({ view }: { view: UpdatesView }) {
  const t = useT();
  const failed = view.state === "failed";
  return (
    <>
      {failed && view.detailKeys.length > 0 ? (
        <Alert variant="destructive" data-slot="updates-failed">
          <AlertTitle className="font-normal">{t(view.statusKey)}</AlertTitle>
          {view.detailKeys.map((key) => (
            <AlertDescription key={key}>{t(key)}</AlertDescription>
          ))}
        </Alert>
      ) : (
        view.detailKeys.map((key) => (
          <p key={key} className="text-[13px] leading-5 text-muted-foreground">
            {t(key)}
          </p>
        ))
      )}

      {view.partial && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(`updates.partial.${view.partial}`)}
        </p>
      )}

      {view.retryAfterMs > 0 && (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t("updates.retryAfter", {
            value: Math.ceil(view.retryAfterMs / 60_000),
          })}
        </p>
      )}
    </>
  );
}
