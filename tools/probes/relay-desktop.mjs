// relay-web-e2e.mjs 的桌面壳一段（`--desktop`）。
//
// 起开发构建的 Electron（apps/desktop/out/main），它自己起一台 core，数据目录、
// HOME 与 Chromium profile 都是临时的（mock 钥匙串，core 用 file 后端）。在这台
// core 上加个人中转（钉指纹）、挂载分享方那台源（经中继），页面重载后侧栏出现
// 这个源的分组；点它的工作空间、开终端收发数据。页面的来源是回环，发往中继的
// 请求由壳把 `Origin` 改成原生来源（`shell-core/relay-origin.ts`），预检由中继
// 自己回答。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { isolatedEnv, probeHome } from "./probe-home.mjs";
import { probeSession } from "./probe-session.mjs";
import {
  freePort,
  makeNode,
  root,
  sleep,
  until,
} from "./ui-features/harness.mjs";

/** 连上 Electron 的渲染页（回环 http 那个），给一组最小的页面工具。 */
async function attachRenderer(port, log) {
  let target;
  await until(
    async () => {
      try {
        const list = await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json();
        target = list.find(
          (each) =>
            each.type === "page" &&
            /^https?:\/\/(127\.0\.0\.1|localhost)/.test(each.url ?? "") &&
            each.webSocketDebuggerUrl,
        );
      } catch {
        target = undefined;
      }
      return target ?? null;
    },
    "Electron 渲染页出现",
    { timeout: 60_000 },
  ).catch((error) => {
    throw new Error(`${error.message}\n${log()}`);
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  const problems = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.exceptionThrown") {
      problems.push(
        message.params.exceptionDetails?.exception?.description ?? "exception",
      );
    }
  };
  const call = (method, params = {}) =>
    new Promise((done) => {
      id += 1;
      pending.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call("Runtime.enable");
  await call("Page.enable");
  const evaluate = async (expression) => {
    const answer = await call("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (answer.result?.exceptionDetails)
      throw new Error(
        JSON.stringify(answer.result.exceptionDetails).slice(0, 600),
      );
    return answer.result?.result?.value;
  };
  const page = {
    call,
    evaluate,
    problems,
    until: (expression, what, timing) =>
      until(() => evaluate(expression).catch(() => null), what, timing),
    async clickOn(finder, what) {
      const box = await page.until(
        `const element = (() => { ${finder} })();
         if (!element) return null;
         element.scrollIntoView({ block: "nearest" });
         const r = element.getBoundingClientRect();
         return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;`,
        what,
        { timeout: 30_000 },
      );
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await call("Input.dispatchMouseEvent", {
          type,
          x: box.x,
          y: box.y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
        });
      await sleep(200);
    },
    async type(text) {
      await call("Input.insertText", { text });
      await sleep(60);
    },
    async enter() {
      for (const type of ["keyDown", "keyUp"])
        await call("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r" } : {}),
        });
      await sleep(80);
    },
    async capture(file) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(shot.result.data, "base64"));
      return file;
    },
    close: () => socket.close(),
  };
  return page;
}

export async function runDesktop(ctx) {
  const { run, issuer, password, fingerprint, sourceId, stack, output } = ctx;
  const require = createRequire(join(root, "apps/desktop/package.json"));
  const electronBinary = require("electron");
  if (!existsSync(join(root, "apps/desktop/out/main/index.js")))
    throw new Error("桌面壳未构建：apps/desktop/out/main/index.js");

  // 分享方那台上给桌面单独一块工作空间：终端由桌面这一页起、这一页驱动。
  const project = join(stack.scratch, "desktop-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# desktop\n");
  const { workspace, board } = await stack.workspace("桌面经中继", project);
  const terminal = makeNode(
    board.id,
    "terminal",
    "终端",
    { x: 120, y: 120 },
    { width: 520, height: 300 },
    { kind: "terminal", cwd: project },
  );
  await stack.seedBoard(workspace.id, board.id, [terminal]);

  const data = join(stack.scratch, "electron-data");
  mkdirSync(data, { recursive: true });
  const isolated = probeHome("armadra-relay-desktop-home-");
  const port = await freePort();
  const app = spawn(
    electronBinary,
    [
      join(root, "apps/desktop"),
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${join(data, "electron")}`,
      // 临时 HOME 下没有登录钥匙串：不让 Chromium 与 safeStorage 去碰它。
      "--use-mock-keychain",
    ],
    {
      env: isolatedEnv(isolated, {
        ARMADRA_DATA_DIR: data,
        ARMADRA_DESKTOP_OWNS_RUNTIME: "1",
        ARMADRA_RUNTIME_PORT: String(await freePort()),
        ARMADRA_SECRET_BACKEND: "file",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  app.stdout.on("data", (chunk) => (log = (log + chunk).slice(-16_384)));
  app.stderr.on("data", (chunk) => (log = (log + chunk).slice(-16_384)));
  const stop = async () => {
    app.kill("SIGTERM");
    for (let i = 0; i < 50 && app.exitCode === null; i += 1) await sleep(100);
    if (app.exitCode === null) app.kill("SIGKILL");
    isolated.remove();
  };
  let page;
  try {
    page = await attachRenderer(port, () => log);
    const httpBase = await page.until(
      `return window.armadra?.transport?.endpointsSync?.()?.httpBase ?? null;`,
      "桌面壳报出 core 地址",
      { timeout: 60_000 },
    );
    const session = await probeSession({ dataDir: data, base: httpBase });
    const local = async (path, body) => {
      const answer = await session.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await answer.text();
      if (!answer.ok)
        throw new Error(`${path} → ${answer.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    };
    const added = await local("/api/rpc/sources/remoteAdd", {
      json: { kind: "personal", issuer, account: "dev", password, fingerprint },
    });
    const serviceId = (added.json ?? added).remote.serviceId;
    await local("/api/rpc/sources/mount", { json: { serviceId, sourceId } });
    run.ok("桌面壳的 core 加个人中转（钉指纹）、经中继挂载分享方", serviceId);

    // 页面经设置页挂源时做的那两件事：壳重读源表（CSP、钉扎、Origin 改写名单），
    // 记下「挂过源」，重载。
    await page.evaluate(`
      await window.armadra.sources.changed();
      localStorage.setItem("armadra.sources.mounted", "1");
      return true;
    `);
    await page.call("Page.reload", {});
    await sleep(1_500);
    await page.until(
      `return !document.getElementById("splash-root") && document.readyState === "complete"`,
      "页面重载完成",
      { timeout: 30_000 },
    );
    await page.until(
      `return !!document.querySelector('[data-source-group="${sourceId}"][data-state="ready"] [data-source-workspace="${workspace.id}"]')`,
      "侧栏出现经中继挂载的源（就绪）与它的工作空间",
      { timeout: 60_000 },
    );
    run.ok("侧栏按源分组：经中继挂载的源就绪");
    await page.capture(join(output, "06-desktop-mounted.png"));

    await page.clickOn(
      `return document.querySelector('[data-source-workspace="${workspace.id}"]')`,
      "经中继的工作空间",
    );
    await page.until(
      `return !!document.querySelector('.react-flow__node[data-id="${terminal.id}"] .xterm')`,
      "打开工作空间，终端挂上 xterm",
      { timeout: 60_000 },
    );
    await page.clickOn(
      `return document.querySelector('.react-flow__node[data-id="${terminal.id}"] .xterm-screen')`,
      "终端画面",
    );
    await sleep(300);
    await page.type("echo $((40+2))desktop");
    await page.enter();
    await page.until(
      `return (document.querySelector('.react-flow__node[data-id="${terminal.id}"] .xterm-rows')?.innerText ?? "").includes("42desktop")`,
      "终端回显 42desktop",
      { timeout: 30_000 },
    );
    run.ok("真 Electron：打开经中继挂载的工作空间、开终端收发");
    await page.capture(join(output, "07-desktop-terminal.png"));
    run.ok(
      "桌面页面无异常",
      page.problems.length === 0 ? "无" : page.problems.slice(0, 5),
    );
  } catch (error) {
    if (page) {
      await page
        .capture(join(output, "zz-failure-desktop.png"))
        .catch(() => undefined);
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- Electron 日志 ---\n${log.slice(-4000)}`,
    );
  } finally {
    page?.close();
    await stop();
  }
}
