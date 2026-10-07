import { describe, expect, it } from "vitest";
import {
  SCREEN_GATE_LINES,
  SCREEN_SIGNATURES,
  judgeScreen,
  screenProfile,
  type ScreenProfile,
} from "./screen-gate";

/**
 * 画面门的判据（`agent-delivery.md` §4.3「画面门」）。
 *
 * 画面全是自编的文本：只保留每家对话框与提示符里那几行有辨识度的字，布局、
 * 路径与状态栏都是编的，不含任何真实会话内容。
 */

function profile(id: string): ScreenProfile {
  const found = screenProfile(id);
  if (found === undefined) throw new Error(`no profile for ${id}`);
  return found;
}

const CLAUDE_PROMPT = [
  " Claude Code vX.Y.Z",
  " ~/work/demo",
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle)",
].join("\n");

const CLAUDE_PROMPT_DEFAULT_MODE = [
  "────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const CLAUDE_AUTO_MODE_DIALOG = [
  " Claude Code vX.Y.Z",
  "╭──────────────────────────────────────╮",
  "│ Make auto mode your default permission mode?",
  "│ Auto mode lets Claude handle routine actions on its own.",
  "│ ❯ 1. Yes, set auto mode as my default permission mode",
  "│   2. No, keep bypass permissions",
  "╰──────────────────────────────────────╯",
  "  Enter to confirm · Esc to cancel",
].join("\n");

const CLAUDE_TRUST_DIALOG = [
  " Accessing workspace:",
  " /tmp/demo",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code)",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  " Enter to confirm · Esc to cancel",
].join("\n");

const CLAUDE_BYPASS_WARNING = [
  " WARNING: Claude Code running in Bypass Permissions mode",
  " By proceeding, you accept all responsibility.",
  " ❯ 1. No, exit",
  "   2. Yes, I accept",
].join("\n");

const CODEX_PROMPT = [
  ">_ Codex (vX.Y.Z)",
  "",
  "› Ask Codex to do anything",
  "",
  "  ? for shortcuts                         100% context left",
].join("\n");

const CODEX_UPDATE = [
  "  Update available · X.Y.Z → X.Y.W",
  "  Release notes: https://example.invalid/releases",
  "› 1. Update now (runs `npm install -g example`)",
  "  2. Skip",
  "  3. Skip until next version",
  "  enter continue · esc skip",
].join("\n");

const CODEX_TRUST = [
  "  Folder access",
  "  /tmp/demo",
  "  Trust this folder? Codex can read, edit, and run files here.",
  "› 1. Trust and continue",
  "  2. Back",
  "  enter continue · esc back",
].join("\n");

const COPILOT_TRUST = [
  " Confirm folder trust",
  " Do you trust the files in this folder?",
  " ❯ 1. Yes",
  "   2. No (Esc)",
].join("\n");

describe("judgeScreen", () => {
  it("Claude：提示符在前台，首投与平常都放行", () => {
    expect(judgeScreen(profile("claude"), CLAUDE_PROMPT, true)).toEqual({
      kind: "clear",
    });
    expect(
      judgeScreen(profile("claude"), CLAUDE_PROMPT_DEFAULT_MODE, true),
    ).toEqual({ kind: "clear" });
    expect(judgeScreen(profile("claude"), CLAUDE_PROMPT, false)).toEqual({
      kind: "clear",
    });
  });

  it("Claude：三个已知对话框，首投与平常都拦", () => {
    for (const [screen, dialog] of [
      [CLAUDE_AUTO_MODE_DIALOG, "claude.auto-mode-default"],
      [CLAUDE_TRUST_DIALOG, "claude.workspace-trust"],
      [CLAUDE_BYPASS_WARNING, "claude.bypass-permissions-warning"],
    ] as const) {
      for (const first of [true, false]) {
        expect(judgeScreen(profile("claude"), screen, first)).toEqual({
          kind: "dialog",
          dialog,
        });
      }
    }
  });

  it("对话框里的「❯ 1.」选项不算提示符，认不出标题也按菜单拦", () => {
    // 去掉标题行，只剩选项与页脚：认不出是哪个对话框，但这里正等人选一项。
    // 平常的投递也拦——回车会替人选了高亮的那一项。
    const options = [
      " ❯ 1. Something else",
      "   2. Another choice",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    for (const first of [true, false]) {
      expect(judgeScreen(profile("claude"), options, first)).toEqual({
        kind: "dialog",
        dialog: "claude.unrecognized-menu",
      });
    }
  });

  it("答过的对话框留在历史里、下面已经是提示符：放行", () => {
    const screen = `${CLAUDE_TRUST_DIALOG}\n\n${CLAUDE_PROMPT}`;
    expect(judgeScreen(profile("claude"), screen, true)).toEqual({
      kind: "clear",
    });
  });

  it("提示符之后又弹了对话框：拦", () => {
    const screen = `${CLAUDE_PROMPT}\n${CLAUDE_AUTO_MODE_DIALOG}`;
    expect(judgeScreen(profile("claude"), screen, false)).toMatchObject({
      kind: "dialog",
    });
  });

  it("只看最后几十行：滚出窗口的对话框不算", () => {
    const filler = Array.from(
      { length: SCREEN_GATE_LINES },
      (_, index) => `line ${index}`,
    ).join("\n");
    const screen = `${CLAUDE_AUTO_MODE_DIALOG}\n${filler}`;
    expect(judgeScreen(profile("claude"), screen, false)).toEqual({
      kind: "clear",
    });
  });

  it("首投时画面空白或还没画出提示符：拦", () => {
    expect(judgeScreen(profile("claude"), "", true)).toEqual({
      kind: "no-prompt",
    });
    expect(
      judgeScreen(profile("claude"), " Claude Code vX.Y.Z\n loading…", true),
    ).toEqual({ kind: "no-prompt" });
    expect(judgeScreen(profile("claude"), "", false)).toEqual({
      kind: "clear",
    });
  });

  it("画面取不到：首投当作看不见提示符，平常放过", () => {
    expect(judgeScreen(profile("claude"), undefined, true)).toEqual({
      kind: "no-prompt",
    });
    expect(judgeScreen(profile("claude"), undefined, false)).toEqual({
      kind: "clear",
    });
  });

  it("Codex：提示符、升级提示、目录信任", () => {
    expect(judgeScreen(profile("codex"), CODEX_PROMPT, true)).toEqual({
      kind: "clear",
    });
    expect(judgeScreen(profile("codex"), CODEX_UPDATE, true)).toEqual({
      kind: "dialog",
      dialog: "codex.update",
    });
    expect(judgeScreen(profile("codex"), CODEX_TRUST, false)).toEqual({
      kind: "dialog",
      dialog: "codex.folder-trust",
    });
  });

  it("Codex：「› 1.」是对话框的选项，不是提示符", () => {
    const options = "› 1. Something\n  2. Other";
    expect(judgeScreen(profile("codex"), options, true)).toEqual({
      kind: "dialog",
      dialog: "codex.unrecognized-menu",
    });
  });

  it("Copilot：只拦已知对话框，首投不要求提示符（提示符未核实）", () => {
    expect(judgeScreen(profile("copilot"), COPILOT_TRUST, true)).toEqual({
      kind: "dialog",
      dialog: "copilot.folder-trust",
    });
    expect(judgeScreen(profile("copilot"), "", true)).toEqual({
      kind: "clear",
    });
    expect(judgeScreen(profile("copilot"), undefined, true)).toEqual({
      kind: "clear",
    });
  });

  it("没有对话框、也没有核实过的提示符的 CLI 没有画面特征", () => {
    for (const id of ["opencode", "unknown", "constructor", "toString"]) {
      expect(screenProfile(id)).toBeUndefined();
    }
  });
});

/**
 * 每一条对话框特征一块自编画面：标题或选项里有辨识度的那一行取自特征的出处
 * （安装包字符串、本机画面或官方文档），其余是编的。不跑任何真 CLI。
 */
const DIALOG_SCREENS: Readonly<Record<string, string>> = {
  "claude.workspace-trust": CLAUDE_TRUST_DIALOG,
  "claude.bypass-permissions-warning": CLAUDE_BYPASS_WARNING,
  "claude.auto-mode-default": CLAUDE_AUTO_MODE_DIALOG,
  "codex.folder-trust": CODEX_TRUST,
  "codex.update": CODEX_UPDATE,
  "codex.hooks-review": [
    "  1 hook is new or changed.",
    "  Hooks need review",
    "  Hooks can run outside the sandbox after you trust them.",
    "  Review hooks",
    "  Trust all and continue",
    "  Continue without trusting (hooks won't run)",
  ].join("\n"),
  "codex.model-migration": [
    "  Codex just got an upgrade. Introducing model-b.",
    "  We recommend switching from model-a to model-b.",
    "  Try new model",
    "  Use existing model",
  ].join("\n"),
  "codex.sign-in": [
    "  Welcome to Codex, OpenAI's command-line coding agent",
    "  Sign in with ChatGPT to use Codex as part of your paid plan",
    "  or connect an API key for usage-based billing",
    "  Sign in with ChatGPT",
    "  Provide your own API key",
  ].join("\n"),
  "codex.rate-limit-switch": [
    "  Approaching rate limits",
    "  Switch to model-mini for lower credit usage?",
    "  Keep current model",
    "  Keep current model (never show again)",
  ].join("\n"),
  "codex.full-access-warning": [
    "  Codex can edit any file on your computer and run commands with network, without your approval.",
    "  Yes, continue anyway",
    "  Go back without enabling full access",
  ].join("\n"),
  "codex.mcp-install": [
    "  Install MCP servers?",
    "  Install and enable the missing MCP servers in your global config.",
  ].join("\n"),
  "codex.database-rebuilt": [
    "  Codex rebuilt its local database.",
    "  Continuing startup with a fresh local database...",
  ].join("\n"),
  "copilot.folder-trust": COPILOT_TRUST,
  "pi.project-trust": [
    " Trust project folder?",
    " /tmp/demo",
    " This allows pi to load .pi settings and resources.",
    " → Trust",
    "   Trust (this session only)",
    "   Do not trust",
  ].join("\n"),
  "omp.project-trust": [
    " Trust project folder?",
    " /tmp/demo",
    " → Trust",
    "   Do not trust (this session only)",
  ].join("\n"),
};

describe("特征表", () => {
  const entries = Object.entries(SCREEN_SIGNATURES).flatMap(([agent, table]) =>
    table.dialogs.map((dialog) => [agent, dialog.id] as const),
  );

  it.each(entries)("%s：%s 首投与平常都拦", (agent, id) => {
    const screen = DIALOG_SCREENS[id];
    expect(screen, `缺 ${id} 的自编画面`).toBeDefined();
    for (const first of [true, false]) {
      expect(judgeScreen(profile(agent), screen, first)).toEqual({
        kind: "dialog",
        dialog: id,
      });
    }
  });

  it("每条特征都写明了出处与核实与否，id 以 CLI 名开头、不重复", () => {
    const seen = new Set<string>();
    for (const [agent, table] of Object.entries(SCREEN_SIGNATURES)) {
      for (const entry of [
        ...table.dialogs,
        ...(table.prompt ? [table.prompt] : []),
      ]) {
        expect(typeof entry.verified).toBe("boolean");
        expect(entry.source.length).toBeGreaterThan(0);
      }
      for (const dialog of table.dialogs) {
        expect(dialog.id.startsWith(`${agent}.`)).toBe(true);
        expect(seen.has(dialog.id)).toBe(false);
        seen.add(dialog.id);
      }
    }
    // 自编画面与特征表一一对应：删了特征就删画面。
    expect([...seen].sort()).toEqual(Object.keys(DIALOG_SCREENS).sort());
  });

  it("没核实的提示符不进判定：首投不要求它", () => {
    for (const [agent, table] of Object.entries(SCREEN_SIGNATURES)) {
      const used = screenProfile(agent);
      if (table.prompt?.verified === true) {
        expect(used?.prompt).toBe(table.prompt.pattern);
      } else {
        expect(used?.prompt).toBeUndefined();
      }
    }
  });
});

describe("Codex 的变体", () => {
  it("升级提示的第二形态：0.160.0 的「✨ Update available!」", () => {
    const screen = [
      "  ✨ Update available! X.Y.Z -> X.Y.W",
      "  See full release notes:",
      "  https://example.invalid/releases/latest",
    ].join("\n");
    expect(judgeScreen(profile("codex"), screen, false)).toEqual({
      kind: "dialog",
      dialog: "codex.update",
    });
  });

  it("升级横幅留在历史里、下面是输入框：放行", () => {
    const screen = [
      "  ✨ Update available! X.Y.Z -> X.Y.W",
      "  See https://example.invalid for installation options.",
      CODEX_PROMPT,
    ].join("\n");
    expect(judgeScreen(profile("codex"), screen, true)).toEqual({
      kind: "clear",
    });
  });

  it("提示符的占位文字变体：追问也是提示符", () => {
    const screen = "› Ask a follow-up question\n\n  ? for shortcuts";
    expect(judgeScreen(profile("codex"), screen, true)).toEqual({
      kind: "clear",
    });
  });

  it("还在启动或接回：输入框里的占位不算提示符", () => {
    for (const placeholder of [
      "Waiting for startup",
      "Resuming session…",
      "Forking session…",
    ]) {
      expect(
        judgeScreen(profile("codex"), `>_ Codex\n\n› ${placeholder}`, true),
      ).toEqual({ kind: "no-prompt" });
    }
  });

  it("没有编号的选项与提示符同形：按对话框算", () => {
    const screen = [
      "  Hooks need review",
      "› Trust all and continue",
      "  Continue without trusting (hooks won't run)",
    ].join("\n");
    expect(judgeScreen(profile("codex"), screen, false)).toEqual({
      kind: "dialog",
      dialog: "codex.hooks-review",
    });
  });
});

describe("认不出来的选择菜单", () => {
  it("提示符之后出现编号选项或菜单页脚：拦", () => {
    for (const tail of [
      " ❯ 2. Something new",
      "  enter continue · esc skip",
      "  Press Enter to continue.",
      "  Continue anyway? [y/N]: ",
    ]) {
      const screen = `${CLAUDE_PROMPT}\n Some new dialog\n${tail}`;
      expect(judgeScreen(profile("claude"), screen, false)).toEqual({
        kind: "dialog",
        dialog: "claude.unrecognized-menu",
      });
    }
  });

  it("答过的菜单留在历史里、下面已经是提示符：放行", () => {
    const screen = ` Some old dialog\n ❯ 1. Yes\n   2. No\n${CLAUDE_PROMPT}`;
    expect(judgeScreen(profile("claude"), screen, false)).toEqual({
      kind: "clear",
    });
  });

  it("已知对话框下面的选项与页脚沿用它的 id", () => {
    expect(
      judgeScreen(profile("claude"), CLAUDE_AUTO_MODE_DIALOG, false),
    ).toEqual({ kind: "dialog", dialog: "claude.auto-mode-default" });
  });

  it("只有对话框、没有核实提示符的 CLI 同样认菜单（Copilot）", () => {
    const screen = " Allow this tool?\n ❯ 1. Yes\n   2. No (Esc)";
    expect(judgeScreen(profile("copilot"), screen, false)).toEqual({
      kind: "dialog",
      dialog: "copilot.unrecognized-menu",
    });
  });
});
