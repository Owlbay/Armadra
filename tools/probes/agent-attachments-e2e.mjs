// 画布 Agent 的图片与文件（契约 §55，issue #226）端到端（A 档）。
//
// 真 core（`apps/desktop/out/core/main.js`）、真页面（Vite）、新 profile 的无头
// Chrome；临时数据目录与 HOME，`ARMADRA_NO_GLOBAL_WRITES=1`，不用任何真实账号、
// 不起任何真 CLI：
//
//   * 终端 Agent 是 `fixtures/fake-paste-cli.mjs`（开括号粘贴、报出收到的每段
//     粘贴与每个回车），注册成 `custom:fake-paste`（借 Claude 的适配）；
//   * ACP Agent 是 `fixtures/fake-acp-attach.mjs`（声明收图片与内嵌正文、把收到
//     的块概括成一句回来），注册成 `custom:fake-acp-attach`。
//
// 走一遍：
//
//   1. 终端 Agent 节点里 ⌘V 一张截图（页面里派发带 `File` 的 `paste` 事件）：
//      文件上传进 `<数据目录>/agent-uploads/<工作空间>/`，路径经**括号粘贴**到达
//      CLI、一个文件一段，**没有回车**；
//   2. 普通 shell 节点里拖进一个系统文件：同样上传，按 shell 的引用规则插入，
//      没有被执行；
//   3. ACP 节点里粘一张截图和一个文本文件：输入框里出现缩略图与徽标，移除一个
//      再加回来，发送：Agent 收到 `image` 块（字节数对得上）与内嵌的 `resource`；
//      镜像（`acp.log`）里只有链接，图片的 base64 与文件正文都不在；
//   4. 全程页面没有控制台错误。
//
// 经中继到达的源走的是同一个上传接口，由 `apps/desktop/src/core/relay/uploads.test.ts`
// 在假中继的隧道上测。
//
// 用法（仓库根目录）：
//   pnpm libs:build && pnpm --filter @armadra/desktop build
//   node tools/probes/agent-attachments-e2e.mjs [输出目录]
//
// 产物：<输出目录>/result.json 与各步截图，默认 target/agent-attachments-e2e/。
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { isolatedEnv, probeHome } from "./probe-home.mjs";
import {
  child,
  harness,
  killTmux,
  sleep,
  startChrome,
  startVite,
} from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(
  process.argv[2] ?? join(root, "target/agent-attachments-e2e"),
);
mkdirSync(output, { recursive: true });
const h = harness(output);
const { report, step } = h;
report.failures = [];

const PASTE_AGENT = "custom:fake-paste";
const ACP_AGENT = "custom:fake-acp-attach";
const pasteCli = join(root, "tools/probes/fixtures/fake-paste-cli.mjs");
const acpAgent = join(root, "tools/probes/fixtures/fake-acp-attach.mjs");
/** 1×1 的 PNG。 */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG, "base64").length;
const SECRET = "attach-secret-body-7f3a";

function check(ok, name, detail = "") {
  if (ok) step(name, detail);
  else {
    report.failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

await h.run(async () => {
  const main = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(main))
    throw new Error("core 未构建：pnpm --filter @armadra/desktop build");

  /* -------------------------------- core --------------------------------- */

  const data = h.temp("armadra-attach-e2e-");
  const home = probeHome("armadra-attach-e2e-home-");
  h.cleanups.push(() => home.remove());
  h.cleanups.push(() => killTmux(data));
  const environment = isolatedEnv(home, {
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
    ARMADRA_NO_GLOBAL_WRITES: "1",
    ARMADRA_SECRET_BACKEND: "file",
  });
  // 假终端 Agent 的启动程序：一个只 exec 假 CLI 的脚本。
  const bin = h.temp("armadra-attach-e2e-bin-");
  const launcher = join(bin, "fake-paste");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(pasteCli)} "$@"\n`,
  );
  chmodSync(launcher, 0o755);

  const runtime = child(
    h,
    process.execPath,
    [main, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, env: environment },
  );
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.process.exitCode !== null)
      throw new Error(`core 退出：${runtime.tail()}`);
    try {
      origin = JSON.parse(readFileSync(join(data, "endpoints.json"), "utf8"))
        .runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!origin) throw new Error("core 没有写出 endpoints.json");
  step("core 已启动", origin);
  const api = async (path, init = {}) => {
    const answer = await fetch(new URL(path, origin), {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await answer.text();
    if (!answer.ok)
      throw new Error(
        `${init.method ?? "GET"} ${path} → ${answer.status} ${text}`,
      );
    return text ? JSON.parse(text) : null;
  };
  const web = await startVite(h, root, environment);
  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "page", width: 1600, height: 1000 });
  const query = (sql, ...args) => {
    const db = new DatabaseSync(join(data, "canvas.db"), { readOnly: true });
    try {
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  };

  /* ---------------------------- 画布与三个节点 ---------------------------- */

  const projectRoot = h.temp("armadra-attach-e2e-project-");
  writeFileSync(join(projectRoot, "README.md"), "# attach\n");
  await api("/api/settings", {
    method: "PATCH",
    body: {
      agents: {
        custom: [
          {
            id: PASTE_AGENT,
            label: "Fake paste",
            launchCmd: launcher,
            baseAgent: "claude",
          },
          {
            id: ACP_AGENT,
            label: "Fake ACP attach",
            launchCmd: process.execPath,
            args: [acpAgent],
            baseAgent: "opencode",
          },
        ],
      },
      terminal: { ecoMode: false },
    },
  });
  const workspace = await api("/api/workspaces", {
    method: "POST",
    body: {
      name: "Attach",
      rootPath: projectRoot,
      permissions: { read: true, write: true, execute: true },
    },
  });
  const board = (await api(`/api/workspaces/${workspace.id}/boards`))[0];
  const documentPath = `/api/workspaces/${workspace.id}/boards/${board.id}/document`;
  const current = await api(documentPath);
  const stamp = new Date().toISOString();
  const P = randomUUID();
  const T = randomUUID();
  const A = randomUUID();
  const terminalNode = (id, title, position, size, data) => ({
    id,
    boardId: board.id,
    type: "terminal",
    title,
    color: "#0a84ff",
    position,
    size,
    labels: [],
    note: "",
    data: { kind: "terminal", cwd: projectRoot, ...data },
    createdAt: stamp,
    updatedAt: stamp,
  });
  await api(documentPath, {
    method: "PUT",
    body: {
      expectedUpdatedAt: current.board.updatedAt,
      nodes: [
        terminalNode(
          P,
          "Paste",
          { x: 20, y: 20 },
          { width: 1300, height: 240 },
          {
            agent: { id: PASTE_AGENT, driver: "terminal" },
          },
        ),
        terminalNode(
          T,
          "Shell",
          { x: 20, y: 280 },
          { width: 1300, height: 180 },
          {},
        ),
        terminalNode(
          A,
          "ACP",
          { x: 20, y: 480 },
          { width: 900, height: 360 },
          {
            agent: { id: ACP_AGENT, driver: "acp" },
          },
        ),
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      whiteboard: "",
    },
  });
  step("画布上放好终端 Agent、普通 shell 与 ACP 三个节点");

  page.drain();
  await page.navigate(`${web}/?workspace=${workspace.id}&board=${board.id}`);
  await page.settle();
  const node = (id) => `.react-flow__node[data-id="${id}"]`;
  /** 节点里的字，行与行接起来（长路径在终端里会折行）。 */
  const flat = (id) =>
    page.evaluate(
      `return (document.querySelector(${JSON.stringify(node(id))})?.innerText ?? "").replace(/\\n/g, "");`,
    );
  const uploads = () => {
    const base = join(data, "agent-uploads", workspace.id);
    if (!existsSync(base)) return [];
    return readdirSync(base).flatMap((id) =>
      readdirSync(join(base, id)).map((name) => join(base, id, name)),
    );
  };
  /** 在一个元素上派发带文件的 `paste` / `drop`（`DataTransfer` 是真的）。 */
  const dispatch = (selector, type, files) =>
    page.evaluate(`
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) return false;
      const transfer = new DataTransfer();
      for (const spec of ${JSON.stringify(files)}) {
        const bytes = spec.base64
          ? Uint8Array.from(atob(spec.base64), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(spec.text);
        transfer.items.add(new File([bytes], spec.name, { type: spec.type }));
      }
      const event =
        ${JSON.stringify(type)} === "paste"
          ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return true;
    `);

  /* -------------------- 1. 终端 Agent：⌘V 一张截图 -------------------- */

  await page.waitFor(
    `return (document.querySelector(${JSON.stringify(node(P))})?.innerText ?? "").includes("fake-paste ready");`,
    { what: "假终端 Agent 起来了", timeout: 40_000 },
  );
  await sleep(600);
  check(
    await dispatch(`${node(P)} [data-slot="terminal-body"] textarea`, "paste", [
      { name: "image.png", type: "image/png", base64: PNG },
    ]),
    "终端 Agent：派发了带截图的粘贴",
  );
  const pasted = await page.waitFor(
    `const text = (document.querySelector(${JSON.stringify(node(P))})?.innerText ?? "").replace(/\\n/g, "");
     const match = text.match(/PASTE<([^>]*)>/);
     return match ? match[1] : null;`,
    { what: "路径经括号粘贴到了 CLI", timeout: 20_000 },
  );
  const [shot] = uploads();
  check(
    shot !== undefined &&
      pasted === shot &&
      readFileSync(shot).equals(Buffer.from(PNG, "base64")),
    "截图上传进数据目录，路径原样经括号粘贴到 CLI",
    pasted,
  );
  await sleep(800);
  const afterPaste = await flat(P);
  check(
    !afterPaste.includes("ENTER") && !afterPaste.includes("KEYS<"),
    "没有替人按回车，也没有别的按键",
  );
  await page.capture("01-terminal-agent-paste");

  /* -------------------- 2. 普通 shell：拖进一个系统文件 -------------------- */

  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${node(T)} [data-slot="terminal-body"][data-lifecycle="live"]`)});`,
    { what: "shell 节点连上了", timeout: 30_000 },
  );
  await sleep(1_000);
  check(
    await dispatch(`${node(T)} [data-slot="terminal-body"]`, "drop", [
      { name: "notes.txt", type: "text/plain", text: SECRET },
    ]),
    "普通 shell：派发了带文件的拖放",
  );
  const note = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const found = uploads().find((path) => path.endsWith("notes.txt"));
      if (found) return found;
      await sleep(200);
    }
    return undefined;
  })();
  check(note !== undefined, "拖进来的文件上传进数据目录", note);
  if (note) {
    await page.waitFor(
      `return (document.querySelector(${JSON.stringify(node(T))})?.innerText ?? "").replace(/\\n/g, "").includes(${JSON.stringify(note)});`,
      { what: "路径插进了 shell 的输入行", timeout: 20_000 },
    );
    await sleep(1_000);
    const shell = await flat(T);
    check(
      !/command not found|not found|permission denied|No such file/i.test(
        shell,
      ),
      "路径只是插进去，没有被执行",
    );
  }
  await page.capture("02-shell-drop");

  /* -------------------- 3. ACP：图片与文件作为内容块 -------------------- */

  const textarea = `${node(A)} [data-slot="acp-session-view"] textarea`;
  await page.waitFor(
    `return !!document.querySelector(${JSON.stringify(`${node(A)} button[aria-label="添加附件"], ${node(A)} button[aria-label="Attach files"]`)});`,
    { what: "ACP 输入框旁的回形针（会话开好、读到能力）", timeout: 40_000 },
  );
  await dispatch(textarea, "paste", [
    { name: "image.png", type: "image/png", base64: PNG },
    { name: "notes.txt", type: "text/plain", text: SECRET },
  ]);
  await page.waitFor(
    `return document.querySelectorAll(${JSON.stringify(`${node(A)} [data-slot="acp-attachments"] li`)}).length === 2;`,
    { what: "输入框里出现两个附件" },
  );
  check(
    await page.evaluate(
      `return !!document.querySelector(${JSON.stringify(`${node(A)} [data-slot="acp-attachments"] img[src^="blob:"]`)});`,
    ),
    "截图画成缩略图",
  );
  // 移除截图再粘回来：移除钮好用。
  await page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(`${node(A)} [data-slot="acp-attachments"] button`)})]
       .find((button) => (button.getAttribute("aria-label") ?? "").includes("image.png"))
       ?.click(); return true;`,
  );
  await page.waitFor(
    `return document.querySelectorAll(${JSON.stringify(`${node(A)} [data-slot="acp-attachments"] li`)}).length === 1;`,
    { what: "移除一个附件" },
  );
  await dispatch(textarea, "paste", [
    { name: "image.png", type: "image/png", base64: PNG },
  ]);
  await page.waitFor(
    `return document.querySelectorAll(${JSON.stringify(`${node(A)} [data-slot="acp-attachments"] li`)}).length === 2;`,
    { what: "粘回来" },
  );
  await page.capture("03-acp-attachments");
  report.textarea = await page.evaluate(
    `const input = document.querySelector(${JSON.stringify(textarea)});
     const rect = input?.getBoundingClientRect();
     return input ? { disabled: input.disabled, top: rect.top, bottom: rect.bottom, left: rect.left } : null;`,
  );
  // 聚焦输入框，经 `Input.insertText` 走真实的输入事件，再按 Enter 发送。
  await page.evaluate(
    `document.querySelector(${JSON.stringify(textarea)})?.focus(); return true;`,
  );
  await page.call("Input.insertText", { text: "look" });
  await sleep(150);
  await page.key("Enter");
  const reply = await page.waitFor(
    `const text = document.querySelector(${JSON.stringify(node(A))})?.innerText ?? "";
     const match = text.match(/got: [^\\n]*/);
     return match ? match[0] : null;`,
    { what: "ACP Agent 的回复", timeout: 30_000 },
  );
  check(
    reply.includes("text:look") &&
      reply.includes(`image:image/png:${PNG_BYTES}`) &&
      reply.includes(`resource:notes.txt:${SECRET.length}`),
    "Agent 收到文字、image 块（字节数对得上）与内嵌的 resource",
    reply,
  );
  check(
    await page.evaluate(
      `return document.querySelectorAll(${JSON.stringify(`${node(A)} [data-slot="acp-attachments"] li`)}).length === 0;`,
    ),
    "发出去后输入框里的附件清空",
  );
  const row = query(
    "SELECT id FROM terminal_sessions WHERE owner_node_id = ? AND status = 'running' ORDER BY generation DESC LIMIT 1",
    A,
  )[0];
  const log = await api(`/api/acp/sessions/${row.id}/log`);
  const user = log.entries.find((entry) => entry.role === "user");
  const raw = JSON.stringify(log);
  check(
    log.promptCapabilities?.image === true &&
      user?.blocks.filter((block) => block.type === "resource_link").length ===
        2 &&
      !raw.includes(PNG.slice(0, 40)) &&
      !raw.includes(SECRET),
    "镜像里只有两条链接：图片的 base64 与文件正文都不在",
  );
  await page.capture("04-acp-reply");

  /* ------------------------------ 4. 控制台 ------------------------------ */

  const seen = page.drain();
  report.consoleErrors = seen.errors;
  report.failedResponses = seen.responses;
  check(
    seen.errors.length === 0,
    "全程没有控制台错误",
    seen.errors.map((error) => error.text).join(" | "),
  );
  if (report.failures.length > 0)
    throw new Error(`${report.failures.length} 项检查没过`);
});
