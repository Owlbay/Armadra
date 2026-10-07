import { requestCenterOnNode } from "@/canvas/flow/flow-context";
import { nodeDropPosition } from "@/canvas/placement";
import { openFileInEditor } from "@/files/open-editor";
import { isDesktop, openExternal } from "@/platform";
import { useCanvasStore } from "@/store/canvas-store";
import { workspaceRelative } from "./DiffBlock";

/**
 * 会话里一个资源链接能怎么打开（ACP 会话视图 §5.2）：`file://` 且落在工作区
 * 根下 → 编辑器节点（工作区相对路径）；`http(s)` → 网页；其余只能复制。
 * 远端执行主机上工作区根就是那台机器的路径，同一条规则照样成立（§5.4）。
 */
export type LinkTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "web"; readonly url: string };

/** `file:///C:/x` → `C:/x`；`file:///w/a%20b` → `/w/a b`。 */
function filePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

export function linkTarget(
  uri: string,
  root: string | undefined,
): LinkTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { kind: "web", url: url.href };
  }
  if (url.protocol === "file:") {
    let path: string;
    try {
      path = filePath(url);
    } catch {
      return null;
    }
    const relative = workspaceRelative(path, root);
    return relative ? { kind: "file", path: relative } : null;
  }
  return null;
}

/** 打开：编辑器节点，或网页（桌面壳里是浏览器节点，别处交给系统）。 */
export function openLink(target: LinkTarget, line?: number): void {
  if (target.kind === "file") {
    openFileInEditor(target.path, line === undefined ? {} : { line });
    return;
  }
  if (!isDesktop()) {
    void openExternal(target.url);
    return;
  }
  const store = useCanvasStore.getState();
  const id = store.addNode("browser", {
    position: nodeDropPosition("browser"),
    data: { kind: "browser", url: target.url },
  });
  if (id) requestCenterOnNode(id);
}
