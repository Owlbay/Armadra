// 分享链接到画布探针（平台计划 V2，A 档，personal 版本）。
//
// owner 在桌面页面（真 Electron）里生成链接，第二个浏览器上下文（另一台「设备」：独立
// profile、Cookie 不共享）打开 `/j/<id>#…`，加入后看见画布。量步数与耗时。
//
//   owner（桌面页面）：设置 → 远程服务 → 分享本机 → 开始分享 → 选工作空间 → 生成链接，
//                      从链接输入框读出地址；每一次点击都计数；
//   访客（浏览器）：    打开链接（一次导航）→ 落地页点「加入」→ 进画布、看见节点；
//                      点击数不超过 3，导航到画布可见的耗时进报告。
//
// 与 V1 `personal-roundtrip` 重叠的部分（中继、桌面壳、页面小工具、日志扫秘密）都来自
// `platform-lib.mjs`；这里只有 owner 的界面流程和访客的计步。中继在容器里，来自
// armadra-cloud 的本地检出（`cloud-source.mjs`）；没有检出或没有 Docker 时退出码 2。
// 个人中转没有账号注册，访客就是「分享链接 + 邀请令牌」，不需要额外账号；SaaS 版本
// 随 SaaS 服务端落地再加（清单里标明预留）。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build && pnpm --filter @armadra/web build
//   node tools/ci/e2e.mjs --only link-join
//   node tools/probes/link-join.mjs [输出目录]
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { CLOUD_ENTRY, findCloudSource } from "./cloud-source.mjs";
import {
  buttonByText,
  buttonExists,
  clickText,
  dockerReady,
  launchElectron,
  nodeAt,
  ownerClient,
  reloadAfterMount,
  secretLedger,
  seedWorkspace,
  startDockerRelay,
} from "./platform-lib.mjs";
import {
  makeNode,
  root,
  scenario,
  sleep,
  startStack,
  writeResult,
} from "./ui-features/harness.mjs";

/** 访客点击数的上限（规格：不超过 3 次）。 */
const MAX_GUEST_CLICKS = 3;

const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
    join(root, "target/link-join"),
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const cloudHome = findCloudSource();
if (!cloudHome) {
  console.error(
    `没有 armadra-cloud 的本地检出（${CLOUD_ENTRY}）：设 ARMADRA_DEV_STACK_CLOUD_SRC 或放在仓库旁的 ../armadra-cloud`,
  );
  process.exit(2);
}
if (!dockerReady()) {
  console.error("Docker 守护进程没有运行：个人中转在容器里跑");
  process.exit(2);
}
for (const [file, hint] of [
  ["apps/web/dist/index.html", "pnpm --filter @armadra/web build"],
  ["apps/desktop/out/main/index.js", "pnpm --filter @armadra/desktop build"],
]) {
  if (!existsSync(join(root, file))) {
    console.error(`先 ${hint}`);
    process.exit(2);
  }
}
if (process.platform === "win32") {
  console.error("探针要私有通道（core-control.sock），Windows 上不跑");
  process.exit(2);
}
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const report = {
  status: "failed",
  output,
  scenarios: [],
  timings: {},
  steps: {},
};
const started = Date.now();
const ledger = secretLedger();
const { secret } = ledger;
let relay;
let stack;
let electron;
let guest;

try {
  stack = await startStack({
    log: "info",
    env: { ARMADRA_SECRET_BACKEND: "file" },
  });
  report.chrome = stack.chrome;
  const run = scenario(
    report,
    "分享链接到画布（V2 link-join，personal）",
    output,
  );

  /* ------------------ 准备：中继、owner 的桌面与它的画布 ------------------ */
  const password = secret("中继口令", randomBytes(18).toString("base64url"));
  relay = await startDockerRelay({
    cloudHome,
    webRoot: join(root, "apps/web/dist"),
    scratch: stack.scratch,
    password,
  });
  run.ok("个人中转在容器里起来", relay.issuer);

  electron = await launchElectron({ scratch: stack.scratch, tag: "join" });
  const win = electron.page;
  const core = ownerClient(electron.session);
  const project = join(stack.scratch, "owner-project");
  const sticky = (boardId) =>
    makeNode(
      boardId,
      "sticky",
      "便签",
      { x: 120, y: 120 },
      { width: 240, height: 150 },
      { kind: "sticky", content: "link-join-canvas" },
    );
  const seeded = await seedWorkspace(
    core.owner,
    "shared-workspace",
    project,
    (boardId) => [sticky(boardId)],
  );
  const stickyId = seeded.nodes[0].id;
  // 远程服务的卡片是「分享本机」的入口；添加（口令、指纹核对）不在计步范围内。
  await core.rpc("sources.remoteAdd", {
    kind: "personal",
    issuer: relay.issuer,
    account: relay.account,
    password,
    fingerprint: relay.fingerprint,
  });
  // 页面里加远程服务时壳会重读源表（钉扎中继证书、放行来源）；探针从接口加，补上这一步。
  await reloadAfterMount(win);
  run.ok("owner 的桌面加了个人中转，有一个待分享的工作空间");

  /* ------------------ owner：在桌面页面生成链接 ------------------ */
  let ownerClicks = 0;
  const ownerClick = async (texts, what, selector) => {
    ownerClicks += 1;
    await clickText(win, texts, what, selector);
  };
  const ownerStart = Date.now();
  await ownerClick(["设置", "Settings"], "设置");
  await ownerClick(
    ["远程服务", "Remote services"],
    "远程服务",
    "button, a, [role=tab], [role=link]",
  );
  await ownerClick(["分享本机", "Share this machine"], "分享本机");
  // 对话框弹入的动画里按坐标点，点到的是动画中的那一帧：等它停稳。
  await sleep(1_000);
  await ownerClick(["开始分享", "Start sharing"], "开始分享");
  // 选工作空间：下拉里取刚建的那个（缺省是列表第一个）。
  await win.until(
    `return !!(() => { ${buttonByText(["工作空间", "Workspace"], 'button[role="combobox"]')} })();`,
    "登记后出现生成链接的表单",
    { timeout: 60_000 },
  );
  await ownerClick(
    ["工作空间", "Workspace"],
    "工作空间下拉",
    'button[role="combobox"]',
  );
  await ownerClick(
    ["shared-workspace"],
    "选 shared-workspace",
    '[role="option"]',
  );
  // 隧道 ready 之前「生成链接」是禁用的：clickOn 只认可点的按钮，会等到它能点。
  await ownerClick(["生成链接", "Create link"], "生成链接");
  const link = await win.until(
    `return document.querySelector('[data-slot="share-link"] input')?.value || null;`,
    "对话框里出现分享链接",
    { timeout: 30_000 },
  );
  report.timings["owner-generate"] = Date.now() - ownerStart;
  report.steps.ownerClicks = ownerClicks;
  const url = new URL(link);
  const [linkSecret, invitation] = url.hash.slice(1).split(".");
  secret("链接秘密", linkSecret);
  secret("邀请令牌", invitation);
  run.check(
    url.origin === relay.issuer && /^\/j\/[A-Za-z0-9_-]+$/.test(url.pathname),
    "链接指向中继的 /j/<id>，秘密与邀请令牌在片段里",
    { path: url.pathname, hash: url.hash ? "有片段" : "无" },
  );
  await win.capture(join(output, "01-owner-link.png"));
  run.ok("owner 在桌面页面生成链接", {
    clicks: ownerClicks,
    ms: report.timings["owner-generate"],
  });

  /* ------------------ 访客：另一台设备打开链接 ------------------ */
  await stack.browser.call("Security.setIgnoreCertificateErrors", {
    ignore: true,
  });
  guest = await stack.browser.page(await stack.browser.context());
  guest.allowed.push(/WebSocket connection to .* failed/);
  let guestClicks = 0;
  const guestClick = async (texts, what) => {
    guestClicks += 1;
    await guest.clickOn(buttonByText(texts), what);
  };
  const guestStart = Date.now();
  await guest.goto(link);
  await guest.settle();
  await guest.until(buttonExists(["加入", "Join"]), "落地页的「加入」按钮");
  report.timings["guest-landing"] = Date.now() - guestStart;
  await run.shot(guest, "02-guest-landing");
  const hash = await guest.evaluate(`return location.hash;`);
  run.check(
    !hash.includes(linkSecret) && !hash.includes("."),
    "落地页把片段（秘密与邀请令牌）从地址栏抹掉",
    hash,
  );
  await guestClick(["加入", "Join"], "加入");
  await guest.until(
    `return location.pathname === "/app/" ? true : null;`,
    "加入后地址换成 /app/",
    { timeout: 45_000 },
  );
  await guest.until(
    `return !!document.querySelector('${nodeAt(stickyId)}')`,
    "访客的画布上出现 owner 的便签",
    { timeout: 60_000 },
  );
  report.timings["guest-total"] = Date.now() - guestStart;
  report.steps.guestClicks = guestClicks;
  report.steps.guestNavigations = 1;
  const text = await guest.until(
    `const node = document.querySelector('${nodeAt(stickyId)}');
     const text = (node?.innerText ?? "") + [...(node?.querySelectorAll("textarea, input") ?? [])].map((el) => el.value).join(" ");
     return text.includes("link-join-canvas") ? text : null;`,
    "便签的内容同步到了访客的画布",
    { timeout: 30_000 },
  );
  run.ok("便签的内容同步到了访客的画布", text.slice(0, 60));
  await run.shot(guest, "03-guest-canvas");
  run.check(
    guestClicks <= MAX_GUEST_CLICKS,
    `访客从链接到画布 ${guestClicks} 次点击（上限 ${MAX_GUEST_CLICKS}）、1 次导航、${report.timings["guest-total"]} ms`,
    { clicks: guestClicks, ms: report.timings["guest-total"] },
  );
  run.consoleClean(guest);

  const leaks = ledger.scan({
    relay: relay.logs(),
    core: electron.log(),
    probe: ledger.printed(),
  });
  run.check(
    leaks.length === 0,
    "中继、桌面与探针的日志里没有口令、令牌与链接秘密",
    { secrets: ledger.secrets.size, leaks },
  );
  run.entry.status = "ok";
  report.status = "ok";
} catch (error) {
  report.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`  FAIL  ${report.error}`);
  for (const [name, page] of [
    ["guest", guest],
    ["owner", electron?.page],
  ]) {
    if (!page) continue;
    await page.capture(join(output, `zz-failure-${name}.png`)).catch(() => {});
    report[`${name}Text`] = await page
      .evaluate("return document.body.innerText.slice(0, 1500)")
      .catch(() => undefined);
  }
  if (relay) report.relayLog = relay.logs().slice(-3000);
  if (electron) report.electronLog = electron.log().slice(-3000);
} finally {
  report.timings.totalMs = Date.now() - started;
  await electron?.stop().catch(() => {});
  await relay?.stop().catch(() => {});
  await stack?.stop();
  writeResult(output, report);
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
