import type { useT } from "@/app/preferences-store";

/**
 * core 首次启动时建的工作空间与画布都叫 `Default`（`core/workspaces/table.ts`
 * 的 `DEFAULT_WORKSPACE_NAME` / `DEFAULT_BOARD_NAME`）。库里存的就是这个英文
 * 词，界面上按当前语言显示；用户改过名的照原样显示。
 */
const DEFAULT_NAME = "Default";

export function displayName(name: string, t: ReturnType<typeof useT>): string {
  return name === DEFAULT_NAME ? t("sidebar.defaultName") : name;
}
