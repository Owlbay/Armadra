import { workflowDomain } from "../../workflow/registry";
import { DomainError } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { type Args, Refusal, Refused } from "../refusals";
import type { CollabContext } from "../service";
import { type Outcome, result } from "./outcome";

/**
 * `workflow-propose`（协调 Agent §5.2，契约 §15.1）：把一次协作沉淀成一份
 * **草案**。协调者只出草案，存、改、确认是人的事：这里校验、写一行
 * `workflow_drafts`、推 `workflow.draft`，页面出一张草案卡。
 *
 * `--draft` 是草案 JSON：经 `armadra-hook` 的 JSON 调用时是一个对象，从命令行来
 * 时是一段 JSON 字符串，两种都收。
 */
export function workflowPropose(
  _context: CollabContext,
  caller: Caller,
  args: Args,
): Outcome {
  const domain = workflowDomain();
  if (domain === undefined) {
    throw new Refused(503, "internal_error", "工作流域还没有装配好。");
  }
  const raw = args.value("draft");
  if (raw === undefined) {
    throw Refusal.badRequest("workflow-propose 需要 --draft <草案 JSON>。");
  }
  if (args.flag("dry-run")) {
    return result("（演练）草案会交给人确认。", { dryRun: true });
  }
  let row;
  try {
    row = domain.service.propose(
      {
        workspaceId: caller.node.workspaceId,
        boardId: caller.node.boardId,
        nodeId: caller.node.id,
      },
      raw,
    );
  } catch (error) {
    if (error instanceof DomainError) {
      throw new Refused(error.status, error.code, error.message);
    }
    throw error;
  }
  return result(
    `草案「${row.draft.title}」已经交上去了，画布上会出现一张草案卡，等人确认后存为模板。`,
    { draftId: row.id, status: row.status, title: row.draft.title },
  );
}
