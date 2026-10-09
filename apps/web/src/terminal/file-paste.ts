import {
  MAX_AGENT_UPLOAD_BYTES,
  type AgentUploadResponse,
  type TerminalSession,
} from "@armadra/shared";

import { assertSafePathText, FileDragError } from "../files/workspace-drag";
import { quoteTerminalPath } from "./file-drop";

/**
 * 粘贴或拖进终端节点的外部文件（截图、Finder / 资源管理器里的文件；契约 §56）。
 *
 * 各家 CLI 收图片的方式不一样，但有一条是共同的：**括号粘贴进来的一段文字若是
 * 一个图片文件的路径，就当作附图**——Claude Code 去掉引号与反斜杠转义后认
 * `.png/.jpg/.jpeg/.gif/.webp` 结尾的路径，Codex 认得出粘贴进来的图片路径并
 * 附上。它们各自的「剪贴板图片」（Ctrl+V 读系统剪贴板）只在 CLI 与剪贴板同一台
 * 机器、且装了读剪贴板的工具时有用，远端源上读到的是那台机器的剪贴板。所以这里
 * 统一走路径：
 *
 *   1. 文件先上传到**会话所在的 core**（`agent-uploads`，数据目录里按工作空间
 *      隔离、有大小上限）——经中继的远程源，字节落在远端；桌面壳的本机源、
 *      拖进来的是磁盘上的文件时，直接用它的原路径，不复制；
 *   2. 路径经 xterm 的 `paste()` 插入：应用开了 2004 就带括号粘贴；**不加回车**，
 *      不替人提交，一个文件一段（Codex 只把整段恰好是一个路径的粘贴当图片）；
 *   3. Agent 正在等人回答（权限提示、对话框）时不粘：一段文字可能被当成选项。
 */

export interface TerminalFileTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly ssh: boolean;
  /** 节点上记的 Agent；没有就是普通 shell。 */
  readonly agentId?: string;
  /** 启动输入还没送完（与拖工作区文件同一组守卫）。 */
  readonly automaticInputPending?: boolean;
  /** Agent 正挂着一个要人回答的提示。 */
  readonly awaitingAnswer?: boolean;
}

export interface FilePasteServices {
  getTerminal: (id: string) => Promise<TerminalSession>;
  upload: (file: File) => Promise<Pick<AgentUploadResponse, "path">>;
  /** 桌面壳本机源：拖进来的文件在磁盘上的路径；拿不到答空串。 */
  localPath?: (file: File) => string;
}

const BARE = /^[A-Za-z0-9_./:@+=,~-]+$/;

/**
 * 给 Agent 的 TUI 看的路径：Windows 路径换成正斜杠（Claude Code 会把反斜杠当
 * 转义去掉，Node 与 Rust 都认正斜杠），只有安全字符时原样，否则加引号——两家都
 * 先剥掉成对的引号再判断。
 */
export function agentPathText(path: string): string {
  assertSafePathText(path);
  const portable = /^[A-Za-z]:\\/.test(path) ? path.replace(/\\/g, "/") : path;
  if (BARE.test(portable)) return portable;
  if (!portable.includes('"')) return `"${portable}"`;
  if (!portable.includes("'")) return `'${portable}'`;
  throw new FileDragError("fileDrag.invalidPath");
}

/** 剪贴板 / 拖放里真正的文件（不含字符串项）。 */
export function filesOf(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export async function pasteFilesIntoTerminal(
  files: readonly File[],
  target: TerminalFileTarget,
  services: FilePasteServices,
  isActive: () => boolean,
  paste: (text: string) => void,
): Promise<void> {
  if (files.length === 0) return;
  if (target.ssh) throw new FileDragError("fileDrag.executionUnsupported");
  if (target.automaticInputPending)
    throw new FileDragError("fileDrag.launchPending");
  if (target.awaitingAnswer) throw new FileDragError("fileDrag.awaitingAnswer");
  if (!isActive()) throw new FileDragError("fileDrag.destinationChanged");
  const session = await services.getTerminal(target.sessionId);
  if (
    session.id !== target.sessionId ||
    session.workspaceId !== target.workspaceId ||
    session.status !== "running" ||
    session.generation !== target.generation
  )
    throw new FileDragError("fileDrag.destinationChanged");
  const agent = Boolean(target.agentId || session.agentId);
  // 普通 shell 按它自己的引用规则；先试一次，认不得的 shell 在上传之前就拒绝。
  if (!agent) quoteTerminalPath("probe", session.shell);
  const local = files.map((file) => services.localPath?.(file) ?? "");
  files.forEach((file, index) => {
    if (local[index] === "" && file.size > MAX_AGENT_UPLOAD_BYTES)
      throw new FileDragError("fileDrag.tooLarge");
  });
  const paths: string[] = [];
  for (const [index, file] of files.entries()) {
    const known = local[index];
    paths.push(known ? known : (await services.upload(file)).path);
  }
  const texts = paths.map((path) =>
    agent ? agentPathText(path) : quoteTerminalPath(path, session.shell),
  );
  if (!isActive()) throw new FileDragError("fileDrag.destinationChanged");
  // 一个文件一段括号粘贴；没有回车。Agent 那边整段必须恰好是一个路径才当
  // 附件，所以分隔的空格单独一段；shell 照拖工作区文件的样子段尾带空格。
  texts.forEach((text, index) => {
    if (!agent) paste(`${text} `);
    else {
      if (index > 0) paste(" ");
      paste(text);
    }
  });
}
