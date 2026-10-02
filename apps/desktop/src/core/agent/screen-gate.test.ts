import { describe, expect, it } from "vitest";
import {
  SCREEN_GATE_LINES,
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

  it("对话框里的「❯ 1.」选项不算提示符", () => {
    // 去掉标题行，只剩选项与页脚：认不出对话框，但也看不见提示符。
    const options = [
      " ❯ 1. Something else",
      "   2. Another choice",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(judgeScreen(profile("claude"), options, true)).toEqual({
      kind: "no-prompt",
    });
    // 平常的投递不拦一个认不出来的画面：只认已知对话框。
    expect(judgeScreen(profile("claude"), options, false)).toEqual({
      kind: "clear",
    });
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
      kind: "no-prompt",
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

  it("没有登记的 CLI 没有画面特征", () => {
    for (const id of ["pi", "omp", "opencode", "unknown"]) {
      expect(screenProfile(id)).toBeUndefined();
    }
  });
});
