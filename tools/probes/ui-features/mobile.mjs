// 场景 9：手机视口下「连接 → 配对 → 焦点页里开会话视图」（补全计划 G2-10）。
//
// 页面经 Gateway 打开（本地 CA、只在回环上监听、托管 `apps/web/dist`）：
//
//  * 390×844 打开二维码里的网页链接 `https://…/#pair=<票>&fp=…`：是连接页
//    （BrandMark、来源、「连接」、CA 安装引导与下载），不是设置对话框；
//  * 点「连接」配对成 owner，进画布（底部导航在），地址栏的票被抹掉；
//  * 通知深链 `#push=armadra://w/<工作空间>/n/<节点>` 打开工作空间并进那个
//    节点的焦点页：ACP 驱动的终端节点体是会话视图，PTY 按键条不出现，输入框
//    16px；发一句，假 ACP Agent 的回复流进来；
//  * 768×1024（平板）同一会话下画布照常；
//  * 全程控制台没有错误。
//
// 要 `apps/web/dist`（CI 的 e2e 作业先 build）与 `@armadra/agent` 的假 ACP
// Agent；缺一样记 skipped。Chrome 经 CDP 只对这台浏览器忽略证书错误（本地 CA）。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeNode, root, sleep } from "./harness.mjs";

export const WEB_DIST = join(root, "apps/web/dist");
const FAKE_AGENT = "custom:fake-acp";
const fakeAgent = join(
  root,
  "apps/desktop/node_modules/@armadra/agent/dist/drivers/acp/testing/fake-agent-main.js",
);

const exists = (selector) =>
  `return !!document.querySelector(${JSON.stringify(selector)});`;

export default async function mobile({ stack, output, report, scenario }) {
  const run = scenario(report, "mobile", output);
  if (!existsSync(join(WEB_DIST, "index.html")) || !existsSync(fakeAgent)) {
    run.entry.status = "skipped";
    run.entry.reason = "没有 apps/web/dist 或假 ACP Agent";
    console.log(`  skip  ${run.entry.reason}`);
    return;
  }

  /* ------------------------------ 画布与 Gateway ------------------------------ */

  const projectRoot = join(stack.scratch, "mobile-project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "# mobile\n");
  await stack.api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({
      agents: {
        custom: [
          {
            id: FAKE_AGENT,
            label: "Fake ACP",
            launchCmd: process.execPath,
            args: [fakeAgent],
            baseAgent: "opencode",
          },
        ],
      },
    }),
  });
  const { workspace, board } = await stack.workspace("mobile", projectRoot);
  const agent = makeNode(
    board.id,
    "terminal",
    "Agent",
    { x: 40, y: 80 },
    { width: 560, height: 520 },
    {
      kind: "terminal",
      cwd: projectRoot,
      agent: { id: FAKE_AGENT, driver: "acp" },
    },
  );
  await stack.seedBoard(workspace.id, board.id, [agent]);

  const gateway = await stack.api("/api/gateway", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, listen: "loopback" }),
  });
  run.check(
    gateway.running && gateway.tls?.source === "localCa",
    "Gateway 开在回环上（本地 CA）",
    gateway.origin,
  );
  const origin = gateway.origin;
  const pairing = await stack.api("/api/gateway/pairing", {
    method: "POST",
    body: "{}",
  });

  // 只对这台无头浏览器忽略证书错误：本地 CA 没装进系统。
  await stack.browser.call("Security.setIgnoreCertificateErrors", {
    ignore: true,
  });
  const context = await stack.browser.context();
  const page = await stack.browser.page(context, { width: 390, height: 844 });
  await page.viewport(390, 844, true);

  try {
    /* ------------------------------ 1. 连接页 ------------------------------ */

    await page.goto(pairing.webUrl);
    await page.settle();
    await page.until(exists('[data-slot="mobile-connect"]'), "连接页");
    const connect = await page.evaluate(`
      const screen = document.querySelector('[data-slot="mobile-connect"]');
      const link = [...screen.querySelectorAll("a[download]")]
        .find((node) => node.getAttribute("href")?.endsWith("/ca.crt"));
      return {
        text: screen.innerText,
        ca: link?.getAttribute("href") ?? null,
        settings: !!document.querySelector('[role="dialog"]'),
        hash: location.hash,
      };
    `);
    run.check(
      connect.text.includes("连接到 Armadra") &&
        connect.text.includes(new URL(origin).host),
      "扫码打开的是连接页：标题与这个 Gateway 的地址",
    );
    run.check(
      connect.ca === `${origin}/ca.crt`,
      "连接页给出 CA 安装引导与下载",
      connect.ca,
    );
    run.check(!connect.settings, "没有弹设置对话框");
    run.check(
      connect.hash.startsWith("#pair="),
      "点「连接」之前票还在地址栏（装完 CA 刷新还配得上）",
    );
    await run.shot(page, "mobile-connect");

    /* --------------------------- 2. 配对 → 进画布 --------------------------- */

    await page.clickOn(
      `return [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "连接");`,
      "「连接」按钮",
    );
    await page.until(exists('[data-slot="mobile-bottom-nav"]'), "进画布", {
      timeout: 20_000,
    });
    const after = await page.evaluate(`return {
      hash: location.hash,
      connect: !!document.querySelector('[data-slot="mobile-connect"]'),
    };`);
    run.check(
      !after.connect && after.hash === "",
      "配对成功进画布，地址栏的票已抹掉",
    );
    const session = await page.evaluate(`
      const answer = await fetch("/api/identity/session", { credentials: "include" });
      const body = await answer.json();
      return { status: answer.status, role: body.device?.role ?? null };
    `);
    run.check(
      session.status === 200 && session.role === "owner",
      "这台手机配对成 owner（Cookie 会话）",
      session,
    );
    await sleep(800);
    await run.shot(page, "mobile-connected");

    /* ---------------------- 3. 通知深链 → 焦点页会话视图 ---------------------- */

    const deepLink = `armadra://w/${workspace.id}/n/${agent.id}`;
    await page.evaluate(
      `location.hash = ${JSON.stringify(`#push=${encodeURIComponent(deepLink)}`)}; return true;`,
    );
    await page.until(
      exists(
        '[data-slot="mobile-focus"] [data-slot="acp-session-view"] textarea',
      ),
      "焦点页里的会话视图",
      { timeout: 30_000 },
    );
    const focus = await page.evaluate(`
      const textarea = document.querySelector('[data-slot="mobile-focus"] textarea');
      return {
        keyBar: !!document.querySelector('[data-slot="mobile-key-bar"]'),
        fontSize: getComputedStyle(textarea).fontSize,
        hash: location.hash,
      };
    `);
    run.check(
      !focus.keyBar,
      "ACP 驱动的节点在焦点页里没有 PTY 按键条（输入走 PromptBox）",
    );
    run.check(
      focus.fontSize === "16px",
      "会话视图的输入框在手机上是 16px",
      focus.fontSize,
    );
    run.check(focus.hash === "", "深链片段读完即抹掉");

    await page.until(
      `const t = document.querySelector('[data-slot="mobile-focus"] textarea'); return t && !t.disabled;`,
      "会话就绪、输入框可用",
      { timeout: 30_000 },
    );
    await page.clickOn(
      `return document.querySelector('[data-slot="mobile-focus"] textarea');`,
      "输入框",
    );
    await page.type("hello from the phone");
    await page.key("Enter");
    await page.until(
      `return document.querySelector('[data-slot="mobile-focus"]')?.innerText.includes("echo: hello from the phone");`,
      "假 Agent 的回复流进焦点页",
      { timeout: 30_000 },
    );
    run.ok("在焦点页里发一句，回复流进会话视图");
    await sleep(400);
    await run.shot(page, "mobile-focus-acp");

    /* ------------------------------- 4. 平板 ------------------------------- */

    await page.viewport(768, 1024, true);
    await page.until(
      `return !document.querySelector('[data-slot="mobile-focus"]') && !!document.querySelector(".react-flow");`,
      "平板宽度回到画布（焦点页只在手机布局）",
    );
    await sleep(600);
    await run.shot(page, "tablet-canvas");

    run.consoleClean(page);
    run.entry.status = "passed";
  } finally {
    await page.close();
    await stack.api("/api/gateway", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    });
  }
}
