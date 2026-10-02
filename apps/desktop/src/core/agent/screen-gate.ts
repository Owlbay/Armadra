/**
 * 投递前看一眼终端画面：是不是停在 CLI 自己的对话框上（设计
 * `agent-delivery.md` §4.3「画面门」）。
 *
 * 纯函数，没有 I/O：画面由调用方经终端桥的 `capture` 取来（tmux 读真屏幕，
 * direct 后端读回放缓冲重放出来的屏幕，`terminal/replay-screen.ts`），这里只
 * 判。
 *
 * 为什么要有它：状态通道说的是「这一轮结束了 / 会话开场了」，不是「输入框在
 * 前台」。2026-10-02 实测（Claude Code 2.1.286，用户缺省权限为
 * `bypassPermissions`）：Claude 一起来就弹「Make auto mode your default
 * permission mode?」，缺省选项是「是」；Hook 照样报了开场，首投放行门把对端
 * `send` 的正文加回车打了进去——回车替人确认了那个对话框，改写了真实的
 * `~/.claude/settings.json`。
 *
 * 范围刻意收窄（§12 第 3 条的例外只开这么大）：
 *
 *   1. 只认**已知的**对话框。每家 CLI 一张特征表，特征是对话框里独有的标题
 *      或选项文字（取自 CLI 安装包里的字符串或本机实际画面），不做通用的屏
 *      幕理解。没认出来的画面一律当作「不是对话框」。
 *   2. 「画面上没有输入提示符」只在**首投**时才拦——会话起来 / 恢复之后、
 *      按首投放行门（`silentStartIdle` / `sessionStartIdle`）放行的那一次。
 *      那一次放行凭的是「会话够老」，不是任何一条说「输入框在前台」的事实，
 *      所以要求画面上看得见提示符。只有给出了提示符特征的 CLI 才做这一条，
 *      其余几家没有核实过的提示符，拦了就是永远投不进去。
 *
 * 判据只看画面的最后 {@link SCREEN_GATE_LINES} 行，并且按位置判：对话框的特征
 * 出现在最后一处提示符**之后**才算「此刻停在对话框上」。direct 后端的
 * capture 带着滚出屏幕的历史，一个答过的对话框的字还留在上面；tmux 读的是
 * 真屏幕，没有这个问题，但同一条规矩对它也成立。
 */

/** 取画面的行数。与 `agent/routes.ts` 取标题时的 40 行同量级，多留一点给高的节点。 */
export const SCREEN_GATE_LINES = 60;

export interface DialogSignature {
  /** 稳定的标识，进追溯与日志：`<cli>.<对话框>`。 */
  readonly id: string;
  /** 对话框里某一行独有的文字。逐行匹配。 */
  readonly pattern: RegExp;
}

export interface ScreenProfile {
  readonly dialogs: readonly DialogSignature[];
  /**
   * 输入提示符所在的那一行（或紧贴它的页脚）的特征，逐行匹配。缺席表示这家
   * CLI 的提示符没有核实过：首投时不要求看得见提示符，只拦已知对话框。
   */
  readonly prompt?: RegExp;
}

/**
 * 各家的画面特征。键是注册表里的基础 Agent id（自定义 Agent 按 base 查）。
 *
 * 来源逐条写明，界面改版时从这里改：
 *
 *   * Claude Code 2.1.286：三个对话框的文字取自安装包里的字符串；提示符取自
 *     本机实际画面——输入框里只有一个 `❯`，页脚是 `? for shortcuts` 或权限
 *     模式那一行（`… (shift+tab to cycle)`）。对话框里的选项也用 `❯` 标当前
 *     项，但后面跟着编号，所以只认「单独一个 `❯`」。
 *   * Codex 0.159.3：两个对话框取自本机实际画面（升级提示、目录信任）；提示
 *     符是 `›` 加占位文字，对话框的选项也用 `›`，后面跟编号。
 *   * Copilot CLI：目录信任对话框的文字取自官方文档，未在本机核实；提示符未
 *     核实，不给。
 *   * Pi、OMP、OpenCode：没有已知会挡住输入的启动对话框，不登记。
 */
export const SCREEN_PROFILES: Readonly<Record<string, ScreenProfile>> = {
  claude: {
    dialogs: [
      {
        id: "claude.workspace-trust",
        pattern:
          /Is this a project you created or one you trust\?|Yes, I trust this folder/i,
      },
      {
        id: "claude.bypass-permissions-warning",
        pattern: /Claude Code running in Bypass Permissions mode/i,
      },
      {
        id: "claude.auto-mode-default",
        pattern:
          /Make auto mode your default permission mode\?|Yes, set auto mode as my default permission mode/i,
      },
    ],
    prompt:
      /^\s*[│|]?\s*[❯>]\s*[│|]?\s*$|\? for shortcuts|\(shift\+tab to cycle\)/,
  },
  codex: {
    dialogs: [
      {
        id: "codex.folder-trust",
        pattern: /Trust this folder\?|\bTrust and continue\b/,
      },
      {
        id: "codex.update",
        pattern: /Update available\b|Update now \(runs|Skip until next version/,
      },
    ],
    prompt: /^\s*›(?!\s*\d+\.)/,
  },
  copilot: {
    dialogs: [
      {
        id: "copilot.folder-trust",
        pattern:
          /Confirm folder trust|Do you trust the files in this folder\?/i,
      },
    ],
  },
};

/** 这家 CLI 有没有画面特征；没有就整条门不跑，连 capture 都不取。 */
export function screenProfile(baseAgentId: string): ScreenProfile | undefined {
  return SCREEN_PROFILES[baseAgentId];
}

export type ScreenVerdict =
  | { readonly kind: "clear" }
  /** 停在一个已知对话框上。 */
  | { readonly kind: "dialog"; readonly dialog: string }
  /** 首投时画面上看不见输入提示符。 */
  | { readonly kind: "no-prompt" };

/**
 * 判一块画面。`first` 是「这一次是不是首投」（见文件头第 2 条）。
 *
 * 画面取不到时调用方传 `undefined`：首投且这家有提示符特征就当作「看不见提
 * 示符」（宁可排队），否则放过——取画面失败不该让一条平常的投递从此投不进去。
 */
export function judgeScreen(
  profile: ScreenProfile,
  screen: string | undefined,
  first: boolean,
): ScreenVerdict {
  if (screen === undefined) {
    return first && profile.prompt !== undefined
      ? { kind: "no-prompt" }
      : { kind: "clear" };
  }
  const lines = screen.split("\n").slice(-SCREEN_GATE_LINES);
  let lastPrompt = -1;
  let lastDialog = -1;
  let dialog = "";
  for (const [index, line] of lines.entries()) {
    if (profile.prompt?.test(line) === true) lastPrompt = index;
    const hit = profile.dialogs.find((entry) => entry.pattern.test(line));
    if (hit !== undefined) {
      lastDialog = index;
      dialog = hit.id;
    }
  }
  if (lastDialog >= 0 && lastDialog > lastPrompt) {
    return { kind: "dialog", dialog };
  }
  if (first && profile.prompt !== undefined && lastPrompt < 0) {
    return { kind: "no-prompt" };
  }
  return { kind: "clear" };
}
