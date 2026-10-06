import * as React from "react";

import { useSourceRegistry } from "../sources";
import {
  clearJoinOpen,
  onJoinIntent,
  pendingJoinOpen,
} from "../sources/join-intent";
import { useCanvasStore } from "../store/canvas-store";
import { useOpenWorkspace } from "./workspace-actions";
import { useWorkspaces } from "./workspaces-query";

/** 等那个源连上、列出工作空间的上限；过了就不再自动打开。 */
const GIVE_UP_MS = 60_000;

/**
 * 按分享链接加入之后打开那个源的工作空间（客户端包 §6：从链接到画布可见）。
 * 只在有一项待办时挂上 {@link OpenJoined}，平时不多发查询。
 */
export function JoinedSourceOpener() {
  const [target, setTarget] = React.useState(pendingJoinOpen);
  React.useEffect(() => onJoinIntent(() => setTarget(pendingJoinOpen())), []);
  const done = React.useCallback(() => {
    clearJoinOpen();
    setTarget(null);
  }, []);
  if (target === null) return null;
  return <OpenJoined sourceId={target} onDone={done} />;
}

function OpenJoined({
  sourceId,
  onDone,
}: {
  sourceId: string;
  onDone(): void;
}) {
  const workspaces = useWorkspaces();
  const registry = useSourceRegistry();
  const openWorkspace = useOpenWorkspace();
  const found = workspaces.data.find((one) => one.sourceId === sourceId);

  React.useEffect(() => {
    const timer = setTimeout(onDone, GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  React.useEffect(() => {
    if (found === undefined) return;
    onDone();
    // 先切当前源：打开、事件流与不带源前缀的查询都跟着它走（同侧栏分组）。
    registry.setCurrent(sourceId);
    openWorkspace(found.workspace as never, sourceId);
    useCanvasStore.getState().setPanel("settings", false);
  }, [found, onDone, openWorkspace, registry, sourceId]);

  return null;
}
