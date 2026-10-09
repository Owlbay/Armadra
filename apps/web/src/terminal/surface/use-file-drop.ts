import { scoped } from "../../sources/scope";
import * as React from "react";
import { toast } from "sonner";

import { MAX_AGENT_UPLOAD_BYTES } from "@armadra/shared";

import { runtimeApi } from "@/api/client";
import { RuntimeRequestError } from "@/api/request";
import { LOCAL_SOURCE_ID, currentSource } from "@/api/source";
import { localFilePath } from "@/platform";
import { t as translate } from "@/app/preferences-store";
import { useAgentStatusStore } from "@/agent/status-store";
import {
  disarmPendingLaunch,
  usePendingLaunchStore,
} from "@/agent/pending-launch";
import { useCanvasStore } from "@/store/canvas-store";
import {
  FileDragError,
  WORKSPACE_FILE_DROP_EVENT,
  fileDragMessage,
  readWorkspaceFileDrag,
  type WorkspaceFileDrag,
  type WorkspaceFileDropDetail,
} from "@/files/workspace-drag";
import {
  automaticInputBlocksFileDrop,
  pasteWorkspaceFilePaths,
} from "../file-drop";
import { pasteFilesIntoTerminal } from "../file-paste";
import type { SurfaceRefs } from "./refs";

/**
 * 把拖进来的工作区文件路径粘到终端里。返回的回调也给 `onDrop` 用，所以
 * 自动启动行的那一组守卫在两条路上是同一份判断。
 */
export function useFileDropPaste(
  refs: SurfaceRefs,
  nodeId: string,
): (drag: WorkspaceFileDrag) => void {
  const pasteDroppedFiles = React.useCallback(
    (drag: WorkspaceFileDrag) => {
      const store = useCanvasStore.getState();
      const workspace = store.workspace;
      const boardId = store.document?.board.id;
      const terminal = refs.terminalRef.current;
      const transport = refs.transportRef.current;
      const session = refs.sessionIdRef.current;
      if (
        !workspace ||
        !boardId ||
        !terminal ||
        !transport ||
        transport.state !== "live" ||
        refs.statusRef.current.connection !== "live" ||
        transport.generation === null ||
        !session
      ) {
        toast.error(translate("fileDrag.destinationChanged"));
        return;
      }
      const inputState = () => {
        const node = useCanvasStore
          .getState()
          .document?.nodes.find((entry) => entry.id === nodeId);
        const agent =
          node?.data.kind === "terminal"
            ? node.data.agent
            : refs.dataRef.current.agent;
        return {
          nodePending: Boolean(agent?.pendingLaunch),
          launchArmed: refs.launchPhaseRef.current === "armed",
          launchTimer: refs.launchTimerRef.current !== null,
          promptTimer: refs.promptTimerRef.current !== null,
          creating: refs.creatingRef.current,
          pendingPhase: usePendingLaunchStore.getState().entries[nodeId]?.phase,
          acknowledged: Boolean(
            agent?.sessionId ||
              useAgentStatusStore.getState().statuses[scoped(nodeId)],
          ),
        };
      };
      if (automaticInputBlocksFileDrop(inputState())) {
        toast.error(translate("fileDrag.launchPending"));
        return;
      }
      const target = {
        runtimeUrl: currentSource().httpBase,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        sessionId: session,
        generation: transport.generation,
        ssh: Boolean(refs.dataRef.current.ssh),
        agentId: refs.dataRef.current.agent?.id,
      };
      const active = () => {
        const current = useCanvasStore.getState();
        const node = current.document?.nodes.find(
          (entry) => entry.id === nodeId,
        );
        return (
          current.workspace?.id === target.workspaceId &&
          current.workspace.rootPath === target.workspaceRoot &&
          current.document?.board.id === boardId &&
          node?.data.kind === "terminal" &&
          node.data.sessionId === session &&
          !node.data.ssh &&
          node.data.agent?.id === target.agentId &&
          refs.terminalRef.current === terminal &&
          refs.transportRef.current === transport &&
          refs.statusRef.current.connection === "live" &&
          !automaticInputBlocksFileDrop(inputState()) &&
          transport.state === "live" &&
          transport.generation === target.generation &&
          refs.sessionIdRef.current === session
        );
      };
      refs.fileDropQueue.current = refs.fileDropQueue.current
        .catch(() => {})
        .then(() =>
          pasteWorkspaceFilePaths(drag, target, runtimeApi, active, (text) => {
            // A confirmed DAG launch no longer needs its automatic retry. Only settle
            // it after every file/session check succeeds, immediately before pasting.
            const input = inputState();
            if (input.pendingPhase === "sent" && input.acknowledged)
              disarmPendingLaunch(nodeId);
            // xterm adds bracketed-paste framing and onData uses the current WS
            // generation. It does not append Enter or issue an unguarded HTTP write.
            terminal.paste(text);
            terminal.focus();
          }),
        )
        .catch((error: unknown) => {
          toast.error(translate(fileDragMessage(error)));
        });
    },
    [nodeId],
  );

  React.useEffect(() => {
    const body = refs.bodyRef.current;
    if (!body) return;
    const dropped = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        const detail = (event as CustomEvent<WorkspaceFileDropDetail>).detail;
        pasteDroppedFiles(
          readWorkspaceFileDrag({
            getData: () => JSON.stringify(detail?.drag),
          }),
        );
      } catch (error) {
        toast.error(translate(fileDragMessage(error)));
      }
    };
    body.addEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
    return () => body.removeEventListener(WORKSPACE_FILE_DROP_EVENT, dropped);
  }, [pasteDroppedFiles]);

  return pasteDroppedFiles;
}

/**
 * 粘贴或拖进来的外部文件（截图、系统文件管理器里的文件；契约 §55）：上传到会话
 * 所在的 core，把路径粘进终端（`../file-paste.ts`）。守卫与拖工作区文件同一组，
 * 外加「Agent 正等人回答时不粘」。
 */
export function useExternalFilePaste(
  refs: SurfaceRefs,
  nodeId: string,
): (files: readonly File[]) => void {
  return React.useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const store = useCanvasStore.getState();
      const workspace = store.workspace;
      const boardId = store.document?.board.id;
      const terminal = refs.terminalRef.current;
      const transport = refs.transportRef.current;
      const session = refs.sessionIdRef.current;
      if (
        !workspace ||
        !boardId ||
        !terminal ||
        !transport ||
        transport.state !== "live" ||
        refs.statusRef.current.connection !== "live" ||
        transport.generation === null ||
        !session
      ) {
        toast.error(translate("fileDrag.destinationChanged"));
        return;
      }
      const source = currentSource();
      const status = () =>
        useAgentStatusStore.getState().statuses[scoped(nodeId)];
      const pending = () => {
        const node = useCanvasStore
          .getState()
          .document?.nodes.find((entry) => entry.id === nodeId);
        const agent =
          node?.data.kind === "terminal"
            ? node.data.agent
            : refs.dataRef.current.agent;
        return automaticInputBlocksFileDrop({
          nodePending: Boolean(agent?.pendingLaunch),
          launchArmed: refs.launchPhaseRef.current === "armed",
          launchTimer: refs.launchTimerRef.current !== null,
          promptTimer: refs.promptTimerRef.current !== null,
          creating: refs.creatingRef.current,
          pendingPhase: usePendingLaunchStore.getState().entries[nodeId]?.phase,
          acknowledged: Boolean(agent?.sessionId || status()),
        });
      };
      const awaiting = () => {
        const current = status();
        return Boolean(current?.pendingId) || current?.state === "blocked";
      };
      const generation = transport.generation;
      const target = {
        workspaceId: workspace.id,
        sessionId: session,
        generation,
        ssh: Boolean(refs.dataRef.current.ssh),
        agentId: refs.dataRef.current.agent?.id,
        automaticInputPending: pending(),
        awaitingAnswer: awaiting(),
      };
      const active = () => {
        const current = useCanvasStore.getState();
        return (
          current.workspace?.id === target.workspaceId &&
          current.document?.board.id === boardId &&
          currentSource() === source &&
          refs.terminalRef.current === terminal &&
          refs.transportRef.current === transport &&
          refs.statusRef.current.connection === "live" &&
          transport.state === "live" &&
          transport.generation === generation &&
          refs.sessionIdRef.current === session &&
          !pending() &&
          !awaiting()
        );
      };
      const toastId = toast.loading(translate("fileDrag.uploading"));
      refs.fileDropQueue.current = refs.fileDropQueue.current
        .catch(() => {})
        .then(() =>
          pasteFilesIntoTerminal(
            files,
            target,
            {
              getTerminal: (id) => runtimeApi.getTerminal(id),
              upload: (file) =>
                runtimeApi.uploadAgentFile(
                  target.workspaceId,
                  file,
                  file.name,
                  source,
                ),
              localPath: (file) =>
                source.sourceId === LOCAL_SOURCE_ID ? localFilePath(file) : "",
            },
            active,
            (text) => {
              // 与拖工作区文件同一条路：xterm 按 2004 加括号粘贴，经当前代次的
              // WS 发出；不加回车。
              terminal.paste(text);
              terminal.focus();
            },
          ),
        )
        .then(() => {
          toast.dismiss(toastId);
        })
        .catch((error: unknown) => {
          toast.dismiss(toastId);
          toast.error(externalFileMessage(error));
        });
    },
    [nodeId],
  );
}

function externalFileMessage(error: unknown): string {
  if (error instanceof FileDragError) {
    return translate(error.messageKey, {
      size: `${MAX_AGENT_UPLOAD_BYTES / 1024 / 1024} MB`,
    });
  }
  if (error instanceof RuntimeRequestError) {
    return error.status === 413
      ? translate("fileDrag.tooLarge", {
          size: `${MAX_AGENT_UPLOAD_BYTES / 1024 / 1024} MB`,
        })
      : error.message;
  }
  return translate("fileDrag.uploadFailed");
}

export { FileDragError, fileDragMessage, readWorkspaceFileDrag };
