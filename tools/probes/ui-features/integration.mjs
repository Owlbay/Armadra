// 场景 6：集成页的旧残留（b1811c85）。
//
// core 的 HOME / CLAUDE_CONFIG_DIR 指向探针自己造的临时目录（`prepareIntegrationHome`
// 在 core 启动前调用），里面的 `.claude/settings.json` 在 11 个 Hook 事件下各挂
// 一条同样的本产品旧版命令，外加一条用户自己的命令、一条别的工具的命令和一条
// 与本产品改名前同名的命令（现在只认 armadra 命名，它按别的工具对待）。截图
// 确认：Agent CLI 主表点进 Claude Code 子页、「画布注入」一行行高正常、「清理旧版
// 11」点开的清单弹层在设置对话框之上且没被盖住、同一条命令合并成一行并标 ×11、
// 别的工具与改名前同名的命令不出现。最后点清单底下的「清理」：我们的条目清掉、用户与别的工具
// 的留着、旁边多一份备份——这些都只发生在临时目录里。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTree, sleep } from "./harness.mjs";

/** 别的工具装进同一个文件的 Hook：不列、不改、不删。 */
const OTHER_TOOL = "sh '/Users/dev/.othertool/agent-hooks/claude.sh'";
/** 与本产品改名前同名的程序：现在不认它，按别的工具的条目对待。 */
const FORMER_NAME = "/usr/local/bin/aicc-hook claude";

const EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
];

/** 造一个带 11 条重复旧残留（本产品旧版写的）的 HOME；返回路径与删除函数。 */
export function prepareIntegrationHome() {
  const path = mkdtempSync(join(tmpdir(), "armadra-ui-home-"));
  const claude = join(path, ".claude");
  mkdirSync(claude, { recursive: true });
  const legacy = `"${join(path, "Old Build", "armadra-hook")}" claude`;
  const hooks = Object.fromEntries(
    EVENTS.map((event) => [
      event,
      [{ hooks: [{ type: "command", command: legacy }] }],
    ]),
  );
  hooks.Stop.push({ hooks: [{ type: "command", command: "echo mine" }] });
  hooks.Stop.push({ hooks: [{ type: "command", command: OTHER_TOOL }] });
  hooks.Stop.push({ hooks: [{ type: "command", command: FORMER_NAME }] });
  writeFileSync(
    join(claude, "settings.json"),
    `${JSON.stringify({ hooks }, null, 2)}\n`,
  );
  return {
    path,
    settings: join(claude, "settings.json"),
    remove: () => removeTree(path),
  };
}

async function openIntegration(page) {
  await page.clickOn(
    `return [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "设置");`,
    "设置按钮",
  );
  await page.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((b) => b.textContent.trim() === "Agent CLI");`,
    "Agent CLI 页",
  );
  await openClaude(page);
}

/** Agent CLI 主表里点 Claude Code，进它的子页（细节与「清理旧版」在那里）。 */
async function openClaude(page) {
  await page.clickOn(
    `return [...document.querySelectorAll('[data-testid="settings-page"] button')].find((b) => b.textContent.trim() === "Claude Code");`,
    "Claude Code 一行",
  );
  await page.until(
    `return document.querySelector('[data-testid="settings-heading"]')?.textContent.trim() === "Claude Code"`,
    "Claude Code 子页载入",
  );
}

export default async function integration({ stack, output, report, scenario }) {
  const run = scenario(report, "集成页旧残留（b1811c85）", output);
  const settings = join(stack.home, ".claude/settings.json");
  run.check(
    existsSync(settings),
    "临时 HOME 里有造好的 settings.json",
    settings,
  );
  const original = readFileSync(settings, "utf8");
  const { workspace, board } = await stack.workspace("集成", stack.scratch);
  const url = stack.boardUrl(workspace.id, board.id);
  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(url);
  await page.settle();
  await openIntegration(page);

  const badge = `return [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "清理旧版 11");`;
  await page.centerOf(badge, "「清理旧版 11」");
  // Claude Code 子页：页头是名字，「画布注入」组里那一行没有被一段命令撑开。
  const row = await page.evaluate(`
    const badge = (() => { ${badge} })();
    const group = badge.closest("section");
    const title = group?.querySelector("h3");
    const heading = document.querySelector('[data-testid="settings-heading"]');
    const line = badge.closest(".settings-row");
    const r = line.getBoundingClientRect();
    return { heading: heading?.textContent.trim(), group: title?.textContent.trim(), rowHeight: Math.round(r.height) };
  `);
  run.check(
    row.heading === "Claude Code" &&
      row.group === "画布注入" &&
      row.rowHeight < 120,
    "Claude Code 子页布局正常（页头是名字、注入一行行高不被撑开）",
    row,
  );
  await run.shot(page, "integration-1-page");

  await page.clickOn(badge, "点开徽标");
  const popover = await page.until(
    `const content = document.querySelector('[data-slot="popover-content"]');
     if (!content) return null;
     const r = content.getBoundingClientRect();
     const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
     return {
       text: content.innerText,
       onTop: content.contains(top),
       zIndex: getComputedStyle(content.closest("[data-radix-popper-content-wrapper]") ?? content).zIndex,
       inViewport: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
     };`,
    "残留弹层",
  );
  run.check(popover.onTop, "弹层在设置对话框之上，没有被盖住", {
    zIndex: popover.zIndex,
  });
  run.check(popover.inViewport, "弹层整块在视口内");
  run.check(
    popover.text.includes("×11") &&
      popover.text.split('armadra-hook" claude').length === 2 &&
      !popover.text.includes("othertool") &&
      !popover.text.includes(FORMER_NAME),
    "同一条命令只列一行并标 ×11，别的工具与改名前同名的命令不列",
    popover.text.slice(0, 160),
  );
  await sleep(300);
  await run.shot(page, "integration-2-popover");

  /* -------------------------------- 清理 --------------------------------- */
  // 看过清单再清理：「清理」在弹层底下。
  await page.clickOn(
    `return [...document.querySelectorAll('[data-slot="popover-content"] button')].find((b) => b.textContent.trim() === "清理");`,
    "清理",
  );
  await page.until(
    `return !document.body.innerText.includes("清理旧版 11")`,
    "清理后徽标消失",
    { timeout: 20_000 },
  );
  const after = JSON.parse(readFileSync(settings, "utf8"));
  const commands = Object.values(after.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
  run.check(
    commands.every((command) => !command.includes("armadra-hook")) &&
      commands.includes("echo mine") &&
      commands.includes(OTHER_TOOL) &&
      commands.includes(FORMER_NAME),
    "我们的旧条目全部移除，用户、别的工具与改名前同名的命令保留",
    commands,
  );
  const backups = readdirSync(join(stack.home, ".claude")).filter((name) =>
    name.startsWith("settings.json.armadra-backup-"),
  );
  run.check(backups.length === 1, "改写前留了一份备份", backups);
  await sleep(300);
  await run.shot(page, "integration-3-repaired");

  /* -------------------------------- 窄屏 --------------------------------- */
  // 清理后没有徽标了；重新造一份残留，看窄屏下的行与弹层。
  writeFileSync(settings, original);
  const phone = await stack.browser.page(await stack.browser.context());
  await phone.viewport(390, 844, true);
  await phone.goto(url);
  await phone.settle();
  await phone.clickOn(
    `return document.querySelector("nav[data-slot='mobile-bottom-nav'] button[aria-label='设置']");`,
    "手机底栏「设置」",
  );
  await phone.dialogSettled("手机设置抽屉停稳");
  await phone.clickOn(
    `return [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((b) => b.getAttribute("aria-label") === "Agent CLI");`,
    "手机 Agent CLI 页",
  );
  await openClaude(phone);
  await phone.clickOn(badge, "手机上点开「清理旧版 11」");
  await phone.until(
    `return !!document.querySelector('[data-slot="popover-content"]')`,
    "手机弹层",
  );
  await sleep(300);
  await run.shot(phone, "mobile-integration");
  run.consoleClean(page, phone);
  await phone.close();
  await page.close();
  run.entry.status = "passed";
}
