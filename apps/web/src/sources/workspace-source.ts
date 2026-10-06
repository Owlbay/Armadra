import { currentSource, type Source } from "../api/source";
import { useCanvasStore } from "../store/canvas-store";
import { useSource } from "./context";

/** 画布当前这个工作空间所在的源；源表里找不到时退回当前源。 */
export function useWorkspaceSource(): Source {
  const sourceId = useCanvasStore((state) => state.sourceId);
  return useSource(sourceId)?.source ?? currentSource();
}
