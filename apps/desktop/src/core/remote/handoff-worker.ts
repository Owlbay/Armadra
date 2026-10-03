/**
 * Worker 侧的交接采集：`handoff.capture`（契约 §21.1）。
 *
 * 与控制端读本机工作空间时调的是同一个 {@link capture}——同一套文件指纹、同一个
 * Git 指纹、同一段经历史适配器归一化的转录尾巴。两种用法：
 *
 *  * **工作空间在这台主机上**：文件引用、Git 指纹，以及（来源 Agent 的 SSH 终端
 *    也在这台主机时）转录尾巴，一次读完；
 *  * **只要转录**（`transcriptOnly`）：工作空间在别处，只有来源 Agent 的 SSH 终端
 *    在这台主机上。这时不碰文件也不碰仓库——`root` 只是帧要求的一个绝对路径，
 *    这台主机上那个路径与工作空间毫无关系。
 *
 * 旧 Worker 不认 `transcriptOnly`：它照常对 `root`（控制端发 `/`）做一次没有
 * 路径、没有执行授权的采集，Git 指纹是 `unavailable`，转录照样读——控制端只取
 * 转录，所以答复一样可用。
 */

import { UNAVAILABLE } from "../git/fingerprint";
import {
  type Captured,
  capture,
  captureArgs,
  readTranscriptTail,
} from "../handoff/capture";

export function handoffCapture(
  root: string,
  args: Record<string, unknown>,
): Captured {
  const request = captureArgs(args);
  if (args.transcriptOnly !== true) return capture(root, request);
  return {
    files: [],
    git: UNAVAILABLE,
    ...(request.transcript === undefined
      ? {}
      : { transcript: readTranscriptTail(request.transcript) }),
  };
}
