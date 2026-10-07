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
 *      或选项文字（取自 CLI 安装包里的字符串、本机实际画面或官方文档），不
 *      做通用的屏幕理解。唯一的通用判据是「选择菜单」（{@link MENU_CUES}）：
 *      高亮的编号选项或「回车确认 / Esc 取消」一类页脚出现在最后一处提示符
 *      之后，就当作一个没登记的对话框——宁可排队，也不让回车替人选了缺省项。
 *   2. 「画面上没有输入提示符」只在**首投**时才拦——会话起来 / 恢复之后、
 *      按首投放行门（`silentStartIdle` / `sessionStartIdle`）放行的那一次。
 *      那一次放行凭的是「会话够老」，不是任何一条说「输入框在前台」的事实，
 *      所以要求画面上看得见提示符。只有提示符特征核实过的 CLI 才做这一条，
 *      没核实过的提示符认不出来，拦了就是永远投不进去。
 *
 * 判据只看画面的最后 {@link SCREEN_GATE_LINES} 行，并且按位置判：对话框的特征
 * 出现在最后一处提示符**之后**才算「此刻停在对话框上」。direct 后端的
 * capture 带着滚出屏幕的历史，一个答过的对话框的字还留在上面；tmux 读的是
 * 真屏幕，没有这个问题，但同一条规矩对它也成立。
 */

/** 取画面的行数。与 `agent/routes.ts` 取标题时的 40 行同量级，多留一点给高的节点。 */
export const SCREEN_GATE_LINES = 60;

/**
 * 一条特征是怎么来的。`verified` 为真表示对过本机的实物——装好的那一版 CLI
 * 安装包里的字符串，或本机实际画面；为假表示只依据官方文档或同源 CLI 推断，
 * 装机后要回来核实（`source` 写明版本与出处）。
 */
export interface SignatureOrigin {
  readonly verified: boolean;
  readonly source: string;
}

export interface DialogSignature extends SignatureOrigin {
  /** 稳定的标识，进追溯与日志：`<cli>.<对话框>`。 */
  readonly id: string;
  /** 对话框里某一行独有的文字。逐行匹配。 */
  readonly pattern: RegExp;
}

export interface PromptSignature extends SignatureOrigin {
  /** 输入提示符所在的那一行（或紧贴它的页脚）的特征，逐行匹配。 */
  readonly pattern: RegExp;
}

/** 一家 CLI 登记的全部画面特征（含没核实的），见 {@link SCREEN_SIGNATURES}。 */
export interface ScreenSignatures {
  readonly dialogs: readonly DialogSignature[];
  readonly prompt?: PromptSignature;
}

/**
 * 判定实际用到的那一份，由 {@link screenProfile} 从特征表里取出。
 *
 * 对话框不论核实与否都用：认错一个对话框的代价是排队，认漏的代价是替人答题。
 * 提示符只用核实过的：要求看得见一个没核实过的提示符，认不出来就永远投不进
 * 去。
 */
export interface ScreenProfile {
  /** 进追溯的 CLI 名，通用菜单判据的 id 以它为前缀。 */
  readonly agent: string;
  readonly dialogs: readonly DialogSignature[];
  /** 缺席表示首投时不要求看得见提示符，只拦对话框。 */
  readonly prompt?: RegExp;
}

/**
 * 通用的「选择菜单」特征：不认是哪个对话框，只认「这里正等人选一项」。
 *
 *   * 高亮的编号选项：`❯ 1.`（Claude、Copilot）、`› 2.`（Codex）、`> 1.`。
 *   * 菜单页脚：`Enter to confirm · Esc to cancel`（Claude）、`enter continue ·
 *     esc skip`（Codex）、`Press Enter to continue.`（Codex 重建本地库）、
 *     `[y/N]` 一类的问句。
 *
 * 只在它们出现在最后一处提示符**之后**才算；答过的菜单留在历史里不算。
 */
export const MENU_CUES: readonly RegExp[] = [
  /^\s*[│|]?\s*[❯›>]\s*\d+\.\s+\S/,
  /\bEnter to confirm\b|\bEsc to cancel\b/i,
  /\benter (?:to )?continue\b.*\besc\b/i,
  /\bPress Enter to continue\b/i,
  /\[(?:y\/N|Y\/n|y\/n)\]\s*:?\s*$/,
];

/**
 * 各家的画面特征。键是注册表里的基础 Agent id（自定义 Agent 按 base 查）。
 * 界面改版时从这里改；每条都写明出处与版本。
 */
export const SCREEN_SIGNATURES: Readonly<Record<string, ScreenSignatures>> = {
  claude: {
    dialogs: [
      {
        id: "claude.workspace-trust",
        pattern:
          /Is this a project you created or one you trust\?|Yes, I trust this folder/i,
        verified: true,
        source: "Claude Code 2.1.286 安装包字符串",
      },
      {
        id: "claude.bypass-permissions-warning",
        pattern: /Claude Code running in Bypass Permissions mode/i,
        verified: true,
        source: "Claude Code 2.1.286 安装包字符串",
      },
      {
        id: "claude.auto-mode-default",
        pattern:
          /Make auto mode your default permission mode\?|Yes, set auto mode as my default permission mode/i,
        verified: true,
        source: "Claude Code 2.1.286 安装包字符串与本机画面（2026-10-02）",
      },
    ],
    prompt: {
      // 输入框里只有一个 `❯`，页脚是 `? for shortcuts` 或权限模式那一行。对话
      // 框的选项也用 `❯` 标当前项，但后面跟着编号，所以只认「单独一个 `❯`」。
      pattern:
        /^\s*[│|]?\s*[❯>]\s*[│|]?\s*$|\? for shortcuts|\(shift\+tab to cycle\)/,
      verified: true,
      source: "Claude Code 2.1.286 本机画面",
    },
  },
  codex: {
    dialogs: [
      {
        id: "codex.folder-trust",
        pattern:
          /Trust this folder\?|\bTrust and continue\b|Your trust decision will be saved/,
        verified: true,
        source: "Codex 0.159.3 本机画面；0.160.0 安装包字符串",
      },
      {
        // 两种形态：模态的「Update available! A -> B」加三个选项（`Update now
        // (runs …)` / `Skip` / `Skip until next version`），与 0.160.0 的
        // 「✨ Update available!」加 `See full release notes`。后者不认安装方式
        // 时只是历史里的一条横幅，下面就是输入框——位置规则让它放行。
        id: "codex.update",
        pattern:
          /Update available\b|Update now \(runs|Skip until next version|See full release notes/,
        verified: true,
        source: "Codex 0.155.1 本机画面；0.160.0 安装包字符串",
      },
      {
        // 回车 = 「Trust all and continue」，会把信任写进用户的 config.toml。
        id: "codex.hooks-review",
        pattern:
          /Hooks need review|Trust all and continue|Continue without trusting \(hooks won't run\)/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串（startup_hooks_review）",
      },
      {
        // 回车 = 「Try new model」，改写用户的模型配置。
        id: "codex.model-migration",
        pattern:
          /Codex just got an upgrade\. Introducing|\bTry new model\b|\bUse existing model\b/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串（model_migration）",
      },
      {
        id: "codex.sign-in",
        pattern:
          /Choose how you want to use Codex|Sign in with ChatGPT to use Codex as part of your paid plan|Provide your own API key/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串（onboarding）",
      },
      {
        id: "codex.rate-limit-switch",
        pattern:
          /Switch to .+ for lower credit usage\?|Keep current model \(never show again\)/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
      {
        id: "codex.full-access-warning",
        pattern: /Yes, continue anyway|Apply full access for this session/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
      {
        id: "codex.mcp-install",
        pattern: /Install MCP servers\?/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
      {
        id: "codex.database-rebuilt",
        pattern:
          /Codex rebuilt its local database|Codex detected a damaged local database/,
        verified: true,
        source: "Codex 0.160.0 安装包字符串",
      },
    ],
    prompt: {
      // `›` 加占位文字（`Ask Codex to do anything` / `Ask a follow-up
      // question`）。对话框的选项也用 `›`，后面跟编号；启动或接回还没完成时
      // 输入框里是 `Waiting for startup` / `Resuming session…`，那时打进去的
      // 字只会被排进 Codex 自己的队，不算就绪。
      pattern:
        /^\s*›(?!\s*\d+\.)(?!\s*(?:Waiting for startup|Resuming session|Forking session))/,
      verified: true,
      source: "Codex 0.159.3 本机画面；0.160.0 安装包字符串",
    },
  },
  copilot: {
    dialogs: [
      {
        // 选项 2 会把目录记进用户配置。
        id: "copilot.folder-trust",
        pattern:
          /Confirm folder trust|Do you trust the files in this folder\?|Yes, and remember this folder for future sessions|Copilot may attempt to read, modify, and execute files/i,
        verified: false,
        source:
          "GitHub 官方文档《Using GitHub Copilot CLI》（2026-10 查阅），本机未安装",
      },
    ],
  },
  pi: {
    dialogs: [
      {
        // 目录里有 `.pi` 配置或 `.agents/skills` 且缺省信任为 `ask` 时启动就问；
        // 缺省选项「Trust」会把决定存进用户的信任文件。
        id: "pi.project-trust",
        pattern:
          /Trust project folder\?|Trust \(this session only\)|Do not trust \(this session only\)/,
        verified: true,
        source: "Pi 1.0.0 安装包字符串（resolveProjectTrusted）",
      },
    ],
  },
  omp: {
    dialogs: [
      {
        id: "omp.project-trust",
        pattern:
          /Trust project folder\?|Trust \(this session only\)|Do not trust \(this session only\)/,
        verified: false,
        source:
          "按同源的 Pi 1.0.0 推断；OMP 官方文档只提到 `omp setup`，本机未安装",
      },
    ],
  },
  // OpenCode：官方文档（opencode.ai/docs/tui，2026-10 查阅）没有启动对话框，提
  // 供方在 `/connect` 里手动加；提示符没核实。整条门不跑。
  opencode: { dialogs: [] },
};

/**
 * 这家 CLI 判定要用的画面特征；没有就整条门不跑，连 capture 都不取。
 *
 * 没有对话框、也没有核实过的提示符的 CLI 答 `undefined`。
 */
export function screenProfile(baseAgentId: string): ScreenProfile | undefined {
  const signatures = Object.hasOwn(SCREEN_SIGNATURES, baseAgentId)
    ? SCREEN_SIGNATURES[baseAgentId]
    : undefined;
  if (signatures === undefined) return undefined;
  const prompt =
    signatures.prompt?.verified === true
      ? signatures.prompt.pattern
      : undefined;
  if (signatures.dialogs.length === 0 && prompt === undefined) return undefined;
  return { agent: baseAgentId, dialogs: signatures.dialogs, prompt };
}

/** 通用菜单判据给出的对话框 id。 */
export function unrecognizedMenuId(agent: string): string {
  return `${agent}.unrecognized-menu`;
}

export type ScreenVerdict =
  | { readonly kind: "clear" }
  /** 停在一个已知对话框或一个认不出来的选择菜单上。 */
  | { readonly kind: "dialog"; readonly dialog: string }
  /** 首投时画面上看不见输入提示符。 */
  | { readonly kind: "no-prompt" };

/**
 * 判一块画面。`first` 是「这一次是不是首投」（见文件头第 2 条）。
 *
 * 画面取不到时调用方传 `undefined`：首投且这家有提示符特征就当作「看不见提
 * 示符」（宁可排队），否则放过——取画面失败不该让一条平常的投递从此投不进去。
 *
 * 一行既像提示符又像对话框（Codex 的选项 `› Trust all and continue` 没有编号
 * 时就是这样），按对话框算：错拦只是排队，错放是替人答题。
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
    const hit = profile.dialogs.find((entry) => entry.pattern.test(line));
    if (hit !== undefined) {
      lastDialog = index;
      dialog = hit.id;
      continue;
    }
    if (MENU_CUES.some((cue) => cue.test(line))) {
      // 已知对话框的标题在上、它的选项与页脚在下：沿用那个已知的 id。
      if (lastDialog < 0 || lastPrompt > lastDialog) {
        dialog = unrecognizedMenuId(profile.agent);
      }
      lastDialog = index;
      continue;
    }
    if (profile.prompt?.test(line) === true) lastPrompt = index;
  }
  if (lastDialog >= 0 && lastDialog > lastPrompt) {
    return { kind: "dialog", dialog };
  }
  if (first && profile.prompt !== undefined && lastPrompt < 0) {
    return { kind: "no-prompt" };
  }
  return { kind: "clear" };
}
