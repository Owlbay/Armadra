// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blankComments,
  featureSources,
  posix,
  readSource,
} from "../lib/scan-source";

/**
 * 对话框一律经 `panels/ResponsiveDialog.tsx`（≤767 贴底、按钮全宽），生成的
 * `ui/dialog` 只有它自己可以 import；确认框的同款守卫见
 * `no-raw-alert-dialog.test.ts`。
 *
 * `ui/sheet` 另有一类正当用法：从右侧滑出的抽屉与面板（它们不是对话框）。
 * 这些文件列在下面的名单里，名单只减不增：新增的抽屉要先确认确实是抽屉，
 * 再来加一行；不再 import sheet 的文件必须同时从名单里划掉。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const DIALOG_ALLOWED = ["panels/ResponsiveDialog.tsx"];

const SHEET_ALLOWED = [
  "coordinator/DispatchDrawer.tsx",
  "panels/ExplorerDrawer.tsx",
  "panels/ResourceDrawer.tsx",
  "panels/ResponsiveDialog.tsx",
  "panels/UsageDashboard.tsx",
  "panels/WorkPanelSheet.tsx",
  "panels/automation/AutomationDrawer.tsx",
  "panels/github/GithubDrawer.tsx",
  "panels/handoff/HandoffHistoryDrawer.tsx",
  "panels/problems/ProblemsPanel.tsx",
  "panels/references/ReferencesPanel.tsx",
  "realtime/comments/CommentLayer.tsx",
  "shell/LeftSidebar.tsx",
  "showcase/sections/components.tsx",
  "workflow/WorkflowPanel.tsx",
];

function importsUi(source: string, name: "dialog" | "sheet"): boolean {
  return new RegExp(`from\\s+["'][^"']*ui/${name}["']`).test(
    blankComments(source),
  );
}

function importers(name: "dialog" | "sheet"): string[] {
  return featureSources(SRC)
    .filter((file) => importsUi(readSource(file), name))
    .map((file) => posix(SRC, file))
    .sort();
}

describe("对话框与抽屉的统一入口", () => {
  it("除 ResponsiveDialog 外没有直接 import ui/dialog 的", () => {
    expect(
      importers("dialog").filter((file) => !DIALOG_ALLOWED.includes(file)),
    ).toEqual([]);
  });

  it("直接 import ui/sheet 的只有名单里的抽屉", () => {
    expect(
      importers("sheet").filter((file) => !SHEET_ALLOWED.includes(file)),
    ).toEqual([]);
  });

  it("名单里的文件都还在 import（不再用就划掉）", () => {
    expect(
      DIALOG_ALLOWED.filter((file) => !importers("dialog").includes(file)),
    ).toEqual([]);
    expect(
      SHEET_ALLOWED.filter((file) => !importers("sheet").includes(file)),
    ).toEqual([]);
  });
});

describe("扫描器真的扫得到违规", () => {
  it("抓得到单行与多行的 import", () => {
    expect(importsUi('import { Dialog } from "@/ui/dialog";', "dialog")).toBe(
      true,
    );
    expect(
      importsUi(
        'import {\n  Sheet,\n  SheetContent,\n} from "../../ui/sheet";',
        "sheet",
      ),
    ).toBe(true);
  });

  it("不误伤 alert-dialog、ResponsiveDialog 与注释", () => {
    expect(importsUi('import { A } from "@/ui/alert-dialog";', "dialog")).toBe(
      false,
    );
    expect(
      importsUi('import { R } from "@/panels/ResponsiveDialog";', "dialog"),
    ).toBe(false);
    expect(importsUi('// import { D } from "@/ui/dialog";', "dialog")).toBe(
      false,
    );
  });
});
