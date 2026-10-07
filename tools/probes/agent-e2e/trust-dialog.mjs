// Claude 进一个新目录时的信任对话框：认出来才答，认不出就等（fail-closed）。
// 场景 1–10 的 `waitAgentUp`（lib.mjs）与场景 12 的终端视图共用这一份。
//
// 认得的两种形态（只看画面最后 40 行）：
//   * 编号菜单：「1. Yes, …」——按编号；
//   * 箭头菜单（Claude Code 2.1.287 实测）：
//       Quick safety check: Is this a project you created or one you trust?
//       ❯ No, exit
//         Yes, I trust this folder
//       Enter to confirm · Esc to cancel
//     两个选项与「Enter to confirm」都在才算认出；按一次下箭头，重新取画面，
//     确认 ❯ 落在「Yes, I trust this folder」上才按回车。光标不在那里就不按。
// 其余（只画了问句、选项没出来、别的对话框）一律不答。

const TRUST_HINTS = ["trust this folder", "trust the files", "one you trust"];
const YES_TEXT = "Yes, I trust this folder";
const NO_TEXT = "No, exit";
const CURSOR = /^\s*[❯>›]/;

function tailOf(text) {
  return String(text ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split("\n")
    .slice(-40);
}

/**
 * 答 `{ kind: "none" }`（没有信任对话框）、`{ kind: "numbered", digit }`、
 * `{ kind: "arrow", cursorOnYes }` 或 `{ kind: "pending" }`（像是信任对话框，但
 * 还认不全——等）。
 */
export function classifyTrustDialog(text) {
  const lines = tailOf(text);
  const joined = lines.join("\n");
  if (!TRUST_HINTS.some((hint) => joined.includes(hint)))
    return { kind: "none" };
  const numbered = [...joined.matchAll(/([1-9])\.\s*Yes\b/g)].at(-1);
  if (numbered !== undefined) return { kind: "numbered", digit: numbered[1] };
  const lastLine = (needle) =>
    lines.findLast((line) => line.includes(needle) && !line.includes("?"));
  const yes = lastLine(YES_TEXT);
  const no = lastLine(NO_TEXT);
  if (yes !== undefined && no !== undefined && /Enter to confirm/.test(joined))
    return {
      kind: "arrow",
      cursorOnYes: CURSOR.test(yes) && !CURSOR.test(no),
    };
  return { kind: "pending" };
}

/**
 * 画面上有信任对话框时走一步。`io` 是 `{ capture(), focus(), down(), enter(),
 * type(text), sleep(ms) }`。答 `"none"`（没有对话框）、`"answered"`（已按下确认，
 * 调用方等它消失）或 `"waiting"`（认不全或光标没到位，下一轮再看）。
 */
export async function stepTrustDialog(text, io) {
  const dialog = classifyTrustDialog(text);
  if (dialog.kind === "none") return "none";
  if (dialog.kind === "numbered") {
    await io.focus();
    await io.type(dialog.digit);
    return "answered";
  }
  if (dialog.kind !== "arrow") return "waiting";
  await io.focus();
  if (!dialog.cursorOnYes) {
    await io.down();
    await io.sleep(400);
    const again = classifyTrustDialog(await io.capture());
    if (again.kind !== "arrow" || !again.cursorOnYes) return "waiting";
  }
  await io.enter();
  return "answered";
}
