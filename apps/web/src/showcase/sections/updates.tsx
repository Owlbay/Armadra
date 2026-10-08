import { SettingsGroup } from "@/panels/settings/SettingsGroup";
import { SettingsRow } from "@/panels/settings/SettingsRow";
import {
  UpdateStatusNotes,
  UpdateStatusRows,
} from "@/panels/settings/pages/AboutPage";
import { useT } from "@/app/preferences-store";
import { mergeUpdatesState } from "@/updates/state";
import { INSTALLED, UPDATE_STATES } from "../fixtures/updates";

const noop = () => undefined;

/**
 * `updates` 分区（设计展示页 §2.1，设计系统 §5.14）：更新页的十一种状态并排。
 * 每一格是真的 `mergeUpdatesState` 合并结果交给真的 `UpdateStatusRows` /
 * `UpdateStatusNotes`——与设置页同一份渲染，只是不连 store。
 */
export default function UpdatesSection() {
  const t = useT();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {UPDATE_STATES.map(({ id, host, shell }) => {
        const view = mergeUpdatesState(host, shell);
        return (
          <div
            key={id}
            data-update-state={id}
            className="flex min-w-0 flex-col gap-2"
          >
            <SettingsGroup>
              <SettingsRow label={t("updates.version")}>
                <span className="text-[13px] tabular-nums text-muted-foreground">
                  {INSTALLED}
                </span>
              </SettingsRow>
              <UpdateStatusRows
                view={view}
                installed={INSTALLED}
                busy={view.state === "checking"}
                notesUrl={view.offer?.notesUrl || view.release?.notesUrl || ""}
                onAction={noop}
              />
            </SettingsGroup>
            <UpdateStatusNotes view={view} />
          </div>
        );
      })}
    </div>
  );
}
