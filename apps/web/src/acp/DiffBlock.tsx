import * as React from "react";
import { FilePlus2 } from "lucide-react";
import type { ContentSource } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { openFileInEditor } from "@/files/open-editor";
import { unifiedLineDiff } from "@/lib/line-diff";
import { PatchBody } from "@/nodes/DiffNode";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { exportDiff } from "./export-to-board";
import { Action, ActionBar, CopyAction } from "./MessageActions";

/** 补丁超过这么多行先折起来，只画前 {@link DIFF_PREVIEW_LINES} 行。 */
export const DIFF_FOLD_LINES = 200;
export const DIFF_PREVIEW_LINES = 60;

/**
 * 工具调用里的文件差异（ACP 设计 §6）：只渲染 ACP 给的 `oldText / newText`，
 * 不去读磁盘；行着色复用变更节点的 `PatchBody`。
 *
 * ACP 的路径是绝对路径，编辑器节点认的是工作区相对路径：不在工作区里的文件
 * 没有「打开」与「落为变更节点」，路径照样能复制。远端执行主机上的工作区根
 * 是那台机器的路径，这条规则不变（ACP 会话视图 §5.4）。
 */
export function workspaceRelative(
  path: string,
  root: string | undefined,
): string | null {
  if (!root) return null;
  const base = root.replace(/[\\/]+$/, "");
  if (path === base) return null;
  for (const separator of ["/", "\\"]) {
    if (path.startsWith(base + separator))
      return path.slice(base.length + 1).replace(/\\/g, "/");
  }
  return null;
}

export function DiffBlock({
  path,
  oldText,
  newText,
  source,
}: {
  path: string;
  oldText: string;
  newText: string;
  /** 给了才有「落为变更节点」（连回这个 Agent 节点）。 */
  source?: ContentSource | undefined;
}) {
  const t = useT();
  const root = useCanvasStore((state) => state.workspace?.rootPath);
  const relative = workspaceRelative(path, root);
  const [all, setAll] = React.useState(false);
  const patch = React.useMemo(
    () => unifiedLineDiff(oldText, newText),
    [oldText, newText],
  );
  const { additions, deletions, lines } = React.useMemo(() => {
    let additions = 0;
    let deletions = 0;
    const lines = patch.split("\n");
    for (const line of lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    return { additions, deletions, lines };
  }, [patch]);
  const folded = !all && lines.length > DIFF_FOLD_LINES;
  const shown = folded ? lines.slice(0, DIFF_PREVIEW_LINES).join("\n") : patch;

  return (
    <Card className="gap-0 overflow-hidden py-0" data-slot="acp-diff">
      <div className="group/act flex h-7 items-center gap-2 border-b border-[var(--border)] px-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px]"
          title={path}
        >
          {relative ?? path}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--text-caption)] text-[var(--success)] tabular-nums">
          +{additions}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--text-caption)] text-[var(--danger-text)] tabular-nums">
          −{deletions}
        </span>
        <ActionBar>
          <CopyAction text={patch} label={t("acp.diff.copy")} />
          <CopyAction text={path} label={t("acp.diff.copyPath")} />
          {relative && source && (
            <Action
              label={t("acp.diff.toNode")}
              onClick={() => exportDiff(relative, source)}
            >
              <FilePlus2 />
            </Action>
          )}
        </ActionBar>
        {relative && (
          <Button
            variant="ghost"
            size="xs"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => openFileInEditor(relative)}
          >
            {t("acp.diff.open")}
          </Button>
        )}
      </div>
      <div className="bg-[var(--surface-sunken)] py-1">
        <PatchBody patch={shown} />
      </div>
      {folded && (
        <Button
          variant="ghost"
          size="xs"
          className="m-1 self-start"
          onClick={() => setAll(true)}
        >
          {t("acp.tool.showAll")}
        </Button>
      )}
    </Card>
  );
}
