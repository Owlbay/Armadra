import {
  handoffListSchema,
  handoffPrepareSchema,
  handoffViewSchema,
  type HandoffPrepare,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";

/**
 * 对话交接（契约 §39.8，经 `client.agents.*Handoff*`）。答案仍过页面自己的
 * schema，调用点的签名不变。客户端由 `api/client.ts` 交进来（这个模块被它
 * import，反过来 import 它就是一个环）。
 *
 * 四个动词分得很开，是因为它们的授权含义不同（design §7）：
 *
 *  - `prepareHandoff` 只冻结材料并生成预览，不通知任何人；
 *  - `acceptHandoff` 是**唯一**的用户授权，`expectedDigest` 必须是预览里
 *    那一份，core 用它挡住「看到的和批准的不是同一份」；
 *  - `cancelHandoff` 在真正写入目标之前撤回排队中的通知；
 *  - `handoffs` / `handoff` 只读，来源和目标两边都能看到同一个包。
 */
/** 调用的选项：给了 `signal` 才带（中止即断开这次请求）。 */
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : undefined);

export const handoffApiFor = (rpc: () => ArmadraClient) => ({
  handoffs: async (workspaceId: string, nodeId: string, signal?: AbortSignal) =>
    handoffListSchema.parse(
      await rpc().agents.handoffs(
        { workspaceId, sourceNodeId: nodeId },
        withSignal(signal),
      ),
    ),
  /**
   * 整个工作空间的交接历史（自动化设计 §7）。
   *
   * 行里的来源/目标读的是冻结在包里的身份，不重新解析：节点被删掉之后，一条
   * 记录仍然要说清当时发生了什么。
   */
  workspaceHandoffs: async (workspaceId: string, signal?: AbortSignal) =>
    handoffListSchema.parse(
      await rpc().agents.handoffs({ workspaceId }, withSignal(signal)),
    ),
  handoff: async (
    workspaceId: string,
    handoffId: string,
    signal?: AbortSignal,
  ) =>
    handoffViewSchema.parse(
      await rpc().agents.handoff(
        { workspaceId, handoffId },
        withSignal(signal),
      ),
    ),
  prepareHandoff: async (workspaceId: string, value: HandoffPrepare) =>
    handoffViewSchema.parse(
      await rpc().agents.prepareHandoff({
        workspaceId,
        ...handoffPrepareSchema.parse(value),
      }),
    ),
  acceptHandoff: async (
    workspaceId: string,
    handoffId: string,
    digest: string,
  ) =>
    handoffViewSchema.parse(
      await rpc().agents.acceptHandoff({
        workspaceId,
        handoffId,
        expectedDigest: digest,
      }),
    ),
  cancelHandoff: async (
    workspaceId: string,
    handoffId: string,
    digest: string,
  ) =>
    handoffViewSchema.parse(
      await rpc().agents.cancelHandoff({
        workspaceId,
        handoffId,
        expectedDigest: digest,
      }),
    ),
});
