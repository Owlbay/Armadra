import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTrustDialog, stepTrustDialog } from "./trust-dialog.mjs";

const QUESTION =
  "Accessing workspace:\nQuick safety check: Is this a project you created or one you trust?";
const ARROW = (onYes) =>
  `${QUESTION}\n${onYes ? "  No, exit\n❯ Yes, I trust this folder" : "❯ No, exit\n  Yes, I trust this folder"}\nEnter to confirm · Esc to cancel`;

function io(screens) {
  const calls = [];
  return {
    calls,
    capture: async () => screens.shift() ?? "",
    focus: async () => calls.push("focus"),
    down: async () => calls.push("down"),
    enter: async () => calls.push("enter"),
    type: async (value) => calls.push(`type ${value}`),
    sleep: async () => {},
  };
}

test("认出三种：没有、编号、箭头（光标位置）；只有问句时等", () => {
  assert.equal(classifyTrustDialog("? for shortcuts").kind, "none");
  assert.deepEqual(classifyTrustDialog(QUESTION), { kind: "pending" });
  assert.deepEqual(
    classifyTrustDialog(`${QUESTION}\n❯ 1. Yes, proceed\n  2. No, exit`),
    { kind: "numbered", digit: "1" },
  );
  assert.deepEqual(classifyTrustDialog(ARROW(false)), {
    kind: "arrow",
    cursorOnYes: false,
  });
  assert.deepEqual(classifyTrustDialog(ARROW(true)), {
    kind: "arrow",
    cursorOnYes: true,
  });
  // 少了「Enter to confirm」就不算认出。
  assert.equal(
    classifyTrustDialog(ARROW(false).replace(/Enter to confirm.*/, "")).kind,
    "pending",
  );
});

test("箭头菜单：下移、核对光标在 Yes 才回车", async () => {
  const ok = io([ARROW(true)]);
  assert.equal(await stepTrustDialog(ARROW(false), ok), "answered");
  assert.deepEqual(ok.calls, ["focus", "down", "enter"]);
  // 下移之后画面没跟上：不回车，下一轮再看。
  const late = io([ARROW(false)]);
  assert.equal(await stepTrustDialog(ARROW(false), late), "waiting");
  assert.deepEqual(late.calls, ["focus", "down"]);
});

test("编号菜单按编号；认不全的不碰键盘", async () => {
  const numbered = io([]);
  assert.equal(
    await stepTrustDialog(
      `${QUESTION}\n  1. Yes, I trust this folder\n❯ 2. No, exit`,
      numbered,
    ),
    "answered",
  );
  assert.deepEqual(numbered.calls, ["focus", "type 1"]);
  const pending = io([]);
  assert.equal(await stepTrustDialog(QUESTION, pending), "waiting");
  assert.deepEqual(pending.calls, []);
  assert.equal(await stepTrustDialog("? for shortcuts", pending), "none");
});
