// 分享链接到画布探针（平台计划 V2，A 档，personal 版本）。
//
// owner 在桌面页面（真 Electron）里生成链接，第二个浏览器上下文（另一台「设备」：独立
// profile、Cookie 不共享）打开 `/j/<id>#…`，加入后看见画布。量步数与耗时。
//
//   owner（桌面页面）：设置 → 远程服务 → 行下的分享区：打开「分享本机」→ 新建链接 → 选
//                      工作空间 → 新建，从二维码对话框读出地址；每一次点击都计数；
//                      之后在列表里再复制、再开二维码（契约 §33.9：整条链接存在本机）；
//   访客（浏览器）：    打开链接（一次导航）→ 落地页点「加入」→ 进画布、看见节点；
//                      点击数不超过 3，导航到画布可见的耗时进报告。第二个访客用同一条
//                      链接再加入一次（链接可复用）；owner 撤销（要确认）后第三个访客被拒。
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
  // 分享区在远程服务行下直接展开：开关「分享本机」。
  await ownerClick(
    ["分享本机", "Share this machine"],
    "分享本机开关",
    'button[role="switch"]',
  );
  await win.until(
    `return document.querySelector('button[role="switch"][aria-checked="true"]') ? true : null;`,
    "本机已分享到中继",
    { timeout: 60_000 },
  );
  await ownerClick(["新建链接", "New link"], "新建链接");
  await sleep(800);
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
  await ownerClick(["新建", "Create"], "新建");
  const link = await win.until(
    `return document.querySelector('[data-slot="share-link"] input')?.value || null;`,
    "二维码对话框里出现分享链接",
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

  const escape = async (page) => {
    for (const type of ["keyDown", "keyUp"])
      await page.call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
    await sleep(500);
  };
  const qrGone = () =>
    win.until(
      `return document.querySelector('[data-slot="share-link"]') ? null : true;`,
      "二维码对话框关上",
    );
  await escape(win);
  await qrGone();
  // 列表里的这一条：再复制（拦下写进剪贴板的字）、再开二维码，都是同一条整链接。
  await win.evaluate(`
    window.__copied = null;
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
      return original(text).catch(() => undefined);
    };
    return true;`);
  await clickText(win, ["复制链接", "Copy link"], "列表里的复制");
  const copied = await win.until(`return window.__copied;`, "复制进剪贴板");
  run.check(copied === link, "列表里再复制，得到同一条整链接");
  await clickText(win, ["二维码", "QR code"], "列表里的二维码");
  const again = await win.until(
    `return document.querySelector('[data-slot="share-link"] input')?.value || null;`,
    "重开二维码",
  );
  const qrText = await win.evaluate(
    `return document.querySelector('[data-slot="share-link"] svg[data-qr-text]')?.getAttribute("data-qr-text") ?? null;`,
  );
  run.check(
    again === link && qrText === link,
    "关掉后在列表里重开二维码，还是这条链接",
  );
  await escape(win);
  await qrGone();

  /* ------------------ 访客：两台设备先后用同一条链接 ------------------ */
  await stack.browser.call("Security.setIgnoreCertificateErrors", {
    ignore: true,
  });
  const joinAsGuest = async (index) => {
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
    report.timings[`guest${index}-landing`] = Date.now() - guestStart;
    await run.shot(guest, `02-guest${index}-landing`);
    const hash = await guest.evaluate(`return location.hash;`);
    run.check(
      !hash.includes(linkSecret) && !hash.includes("."),
      `访客 ${index}：落地页把片段（秘密与邀请令牌）从地址栏抹掉`,
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
    report.timings[`guest${index}-total`] = Date.now() - guestStart;
    report.steps[`guest${index}Clicks`] = guestClicks;
    const text = await guest.until(
      `const node = document.querySelector('${nodeAt(stickyId)}');
       const text = (node?.innerText ?? "") + [...(node?.querySelectorAll("textarea, input") ?? [])].map((el) => el.value).join(" ");
       return text.includes("link-join-canvas") ? text : null;`,
      "便签的内容同步到了访客的画布",
      { timeout: 30_000 },
    );
    run.ok(`访客 ${index} 的画布上有 owner 的便签`, text.slice(0, 60));
    await run.shot(guest, `03-guest${index}-canvas`);
    run.check(
      guestClicks <= MAX_GUEST_CLICKS,
      `访客 ${index} 从链接到画布 ${guestClicks} 次点击（上限 ${MAX_GUEST_CLICKS}）、1 次导航、${report.timings[`guest${index}-total`]} ms`,
      { clicks: guestClicks, ms: report.timings[`guest${index}-total`] },
    );
    run.consoleClean(guest);
  };
  await joinAsGuest(1);
  await joinAsGuest(2);

  /* ------------------ owner：列表里看到 2 次使用，撤销要确认 ------------------ */
  await clickText(win, ["刷新", "Refresh"], "刷新链接列表");
  await win.until(
    `const text = document.body.innerText;
     return text.includes("已用 2/1000") || text.includes("Used 2/1000") ? true : null;`,
    "列表里这条链接已用 2 次",
    { timeout: 30_000 },
  );
  run.ok("同一条链接两个访客先后加入，列表显示已用 2/1000");
  await win.capture(join(output, "04-owner-used.png"));
  await clickText(win, ["撤销", "Revoke"], "列表里的撤销");
  await win.until(
    `return document.querySelector('[role="alertdialog"]') ? true : null;`,
    "撤销前要确认",
  );
  await clickText(
    win,
    ["撤销", "Revoke"],
    "确认撤销",
    '[role="alertdialog"] button',
  );
  await win.until(
    `return /(历史|History) · 1/.test(document.body.innerText) ? true : null;`,
    "撤销后这条链接进了历史",
    { timeout: 30_000 },
  );
  run.ok("owner 撤销链接（二次确认），它折进历史");

  // 第三台设备再用这条链接：落地页按码说明，不给加入。
  guest = await stack.browser.page(await stack.browser.context());
  guest.allowed.push(/Failed to load resource/);
  await guest.goto(link);
  await guest.settle();
  await guest.until(
    `return /链接已停用或不存在|This link is disabled or doesn't exist/.test(document.body.innerText) ? true : null;`,
    "撤销后的链接被拒",
    { timeout: 30_000 },
  );
  await run.shot(guest, "05-guest3-revoked");
  run.ok("撤销后第三个访客打开同一条链接被拒");

  /* ------------------ 截图：390 / 1440，明暗两主题 ------------------ */
  for (const theme of ["dark", "light"]) {
    for (const width of [1440, 390]) {
      await win.call("Emulation.setDeviceMetricsOverride", {
        width,
        height: width < 768 ? 844 : 900,
        deviceScaleFactor: 1,
        mobile: width < 768,
      });
      await win.call("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      await win.evaluate(
        `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; document.documentElement.style.colorScheme = ${JSON.stringify(theme)}; return true;`,
      );
      await sleep(800);
      await win.capture(join(output, `06-settings-${width}-${theme}.png`));
    }
  }
  await win.call("Emulation.clearDeviceMetricsOverride", {});

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
