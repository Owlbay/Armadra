import { type AgentSettings, baseAgent } from "../agent/registry";
import {
  SCREEN_GATE_LINES,
  type ScreenVerdict,
  judgeScreen,
  screenProfile,
} from "../agent/screen-gate";
import type { TerminalBridge } from "./service";

/**
 * 画面门的「取画面 → 判定 → 退回理由」（设计 `agent-delivery.md` §4.3「画面
 * 门」）。判据本身在纯函数 `agent/screen-gate.ts`；这里只管经终端桥取画面，
 * 并把结论翻成投递方认的理由码。`send`（`collab/control/send.ts`）与计划投递
 * （`schedule/dispatch.ts`）共用这一份，所以「终端停在 CLI 的对话框上」只有
 * 一个定义。
 */

/** 停在对话框上、或首投时看不见提示符时退回的理由码（契约 §22）。 */
export const TARGET_NOT_AT_PROMPT = "TARGET_NOT_AT_PROMPT";

export interface ScreenCheck {
  /** 终端桥；没有时按「画面取不到」判。 */
  readonly terminals: TerminalBridge | undefined;
  /** 解析自定义 Agent 的 base。 */
  readonly settings: AgentSettings;
  /** 节点上的 Agent；裸终端（`null`）不判。 */
  readonly agentId: string | null;
  readonly sessionId: string;
  /** 这一次是不是首投（会话起来 / 恢复之后、按首投放行门放行的那一次）。 */
  readonly first: boolean;
}

export type ScreenGateResult =
  | { readonly kind: "clear" }
  | {
      readonly kind: "dialog" | "no-prompt";
      readonly reason: typeof TARGET_NOT_AT_PROMPT;
      /** 认出来的对话框 id（`<cli>.<对话框>`），只在 `dialog` 时有。 */
      readonly dialog?: string;
    };

/**
 * 看一眼目标的画面。这家 CLI 没有画面特征就不取（裸终端、没有已知对话框的几
 * 家），平常的投递一次 capture 也不多花。
 *
 * capture 失败不抛：首投按「看不见提示符」退回，平常的投递放过——取画面失败
 * 不该让一条本来能投的消息从此投不进去。
 */
export async function checkScreen(
  check: ScreenCheck,
): Promise<ScreenGateResult> {
  if (check.agentId === null) return { kind: "clear" };
  const profile = screenProfile(baseAgent(check.settings, check.agentId));
  if (profile === undefined) return { kind: "clear" };
  let screen: string | undefined;
  if (check.terminals !== undefined) {
    try {
      const captured = await check.terminals.capture(
        check.sessionId,
        SCREEN_GATE_LINES,
        false,
      );
      screen = captured.data;
    } catch {
      screen = undefined;
    }
  }
  return refusalOf(judgeScreen(profile, screen, check.first));
}

function refusalOf(verdict: ScreenVerdict): ScreenGateResult {
  switch (verdict.kind) {
    case "clear":
      return verdict;
    case "dialog":
      return {
        kind: "dialog",
        reason: TARGET_NOT_AT_PROMPT,
        dialog: verdict.dialog,
      };
    case "no-prompt":
      return { kind: "no-prompt", reason: TARGET_NOT_AT_PROMPT };
  }
}
