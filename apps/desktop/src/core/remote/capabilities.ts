/**
 * 远端 Worker 的能力名，单独一个没有依赖的模块：操作表、Worker 入口与 Worker
 * 舰队（`fleet.ts`）都要读它，而后两者不该为几串常量把整张操作表（连同语言
 * 服务）拉进自己的依赖图。
 */

import { REMOTE_CAPABILITY } from "./handshake";

/** 远端握手里声明的能力组；缺哪组，控制端对那组答 501 并写明能力名。 */
export const FILES_CAPABILITY = "remote.files.v1";
export const GIT_CAPABILITY = "remote.git.v1";
/** 长操作队列、集成状态、工作树绑定与 AI 提交信息的采集。 */
export const GIT_OPERATIONS_CAPABILITY = "remote.git.operations.v1";
/** Worker 侧文件监听，变化主动推送。 */
export const WATCH_CAPABILITY = "remote.watch.v1";
/** 远端主机总览与会话进程树的一轮读取。 */
export const RESOURCES_CAPABILITY = "remote.resources.v1";

/**
 * 画布注入的产物同步与 Hook 中继；SSH 节点的 ACP 也用它（`agents.probe` 问
 * 适配器装没装，画布工具经同一条中继）。
 */
export const INTEGRATION_CAPABILITY = "remote.integration.v1";
/**
 * 同一组动作的第二版：`integration.sync` 不再接受 `codexCommand`、不再写
 * Codex 信任，并一次性清掉旧版写过的那些。不门控任何动作——控制端只要 v1
 * 就能同步，缺 v2 只是提示升级（docs/design/canvas-launcher.md §8.4）。
 */
export const INTEGRATION_V2_CAPABILITY = "remote.integration.v2";

/** 比一帧大的字节：分块上传、续传与分块下载。 */
export const TRANSFER_CAPABILITY = "remote.transfer.v1";
/** 白板图片资产与画布导出落在执行主机上。 */
export const ASSETS_CAPABILITY = "remote.assets.v1";

/** 交接材料在执行主机上的采集。 */
export const HANDOFF_CAPABILITY = "remote.handoff.v1";

/** 这个构建的 Worker（控制连接）声明的能力。 */
export const WORKER_CAPABILITIES: readonly string[] = [
  REMOTE_CAPABILITY,
  FILES_CAPABILITY,
  GIT_CAPABILITY,
  GIT_OPERATIONS_CAPABILITY,
  WATCH_CAPABILITY,
  RESOURCES_CAPABILITY,
  INTEGRATION_CAPABILITY,
  INTEGRATION_V2_CAPABILITY,
  HANDOFF_CAPABILITY,
  TRANSFER_CAPABILITY,
  ASSETS_CAPABILITY,
];
