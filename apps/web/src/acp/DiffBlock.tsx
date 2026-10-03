import * as React from "react";

import { useT } from "@/app/preferences-store";
import { openFileInEditor } from "@/files/open-editor";
import { unifiedLineDiff } from "@/lib/line-diff";
import { PatchBody } from "@/nodes/DiffNode";
import { useCanvasStore } from "@/store/canvas-store";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";

/**
 * 工具调用里的文件差异（ACP 设计 §6）：只渲染 ACP 给的 `oldText / newText`，
 * 不去读磁盘；行着色复用变更节点的 `PatchBody`。
 *
 * ACP 的路径是绝对路径，编辑器节点认的是工作区相对路径：不在工作区里的文件
 * 没有「打开」。
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
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const t = useT();
  const root = useCanvasStore((state) => state.workspace?.rootPath);
  const relative = workspaceRelative(path, root);
  const patch = React.useMemo(
    () => unifiedLineDiff(oldText, newText),
    [oldText, newText],
  );
  const { additions, deletions } = React.useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    return { additions, deletions };
  }, [patch]);

  return (
    <Card className="gap-0 overflow-hidden py-0" data-slot="acp-diff">
      <div className="flex h-7 items-center gap-2 border-b border-[var(--border)] px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {relative ?? path}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--text-caption)] text-[var(--success)]">
          +{additions}
        </span>
        <span className="shrink-0 font-mono text-[length:var(--text-caption)] text-[var(--danger-text)]">
          −{deletions}
        </span>
        {relative && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => openFileInEditor(relative)}
          >
            {t("acp.diff.open")}
          </Button>
        )}
      </div>
      <div className="bg-[var(--surface-sunken)] py-1">
        <PatchBody patch={patch} />
      </div>
    </Card>
  );
}
