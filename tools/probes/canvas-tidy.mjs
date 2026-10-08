// 画布「整理」探针（UI 设计 2026-10-07 §6.7）。
//
// 复现用户报的场景：导入一个项目之后点「整理」，导入的东西被打散成一长排、
// Agent 簇散落。画布里放：1 个主 Agent + 3 个子 Agent（主从边）+ 一个连着子
// Agent 的浏览器节点 + 一张走新入口导入的 Mermaid 图（自带组）+ 一张修复前那样
// 散在顶层的 Mermaid 图（白板孤岛）+ 几笔手画的框线。截「整理前 / 整理后」两张，
// 断言整理后：
//   - 主从边条数不变；
//   - 顶层对象两两不重叠（包围盒相交 = 0）；
//   - 导入组、散落的旧导入、手画框线各自内部相对位置不变（没被拆开）；
//   - 纵向布局（缺省，契约 §50）：三个子 Agent 在主下面同一行、等距，主水平
//     居中于它们；连着子 Agent 的浏览器挂在那个子右侧同一行；
//   - 再整理一次位移为 0（幂等），撤销一次整块回到整理前。
//
// 跑的是整条真链路：临时数据目录里的 core、一个临时工作空间、Vite 开发服务器、
// 新 profile 的无头 Chrome；「整理」点的是 Dock 上那颗按钮。页面里的模块从
// Vite 直接取（`/src/...`），和应用用的是同一份实例。端口随机（不用 1420 /
// 1421 / 43120 / 43121），数据目录、HOME 与浏览器 profile 都是 mktemp 出来的，
// 跑完删除；不读写操作员自己的数据目录、凭据或任何远端。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   pnpm --filter @armadra/desktop build
//   node tools/probes/canvas-tidy.mjs [输出目录]
//
// 产物：<输出目录>/result.json、before.png、after.png。
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isolatedEnv, probeHome } from "./probe-home.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "target/canvas-tidy"));
mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const cleanups = [];
const report = { status: "failed", steps: [], checks: {}, output };

function step(name, detail = "") {
  report.steps.push({ name, detail });
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
}

function check(name, ok, detail = "") {
  report.checks[name] = { ok, detail };
  if (!ok) throw new Error(`${name}${detail ? `：${detail}` : ""}`);
  step(name, detail);
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return [1420, 1421, 43120, 43121].includes(port) ? freePort() : port;
}

/* -------------------------------- 画布内容 ------------------------------- */

/** 用户截图里那种散落：主在右下，子东一个西一个，浏览器远在角落。 */
function seed(boardId) {
  const stamp = new Date().toISOString();
  const node = (type, title, position, size, data) => ({
    id: randomUUID(),
    boardId,
    type,
    title,
    color: "#0a84ff",
    position,
    size,
    labels: [],
    note: "",
    data,
    createdAt: stamp,
    updatedAt: stamp,
  });
  const terminal = { kind: "terminal" };
  const main = node(
    "terminal",
    "main",
    { x: 2400, y: 1500 },
    { width: 420, height: 280 },
    terminal,
  );
  const subs = [
    node(
      "terminal",
      "sub-1",
      { x: 100, y: 1900 },
      { width: 380, height: 240 },
      terminal,
    ),
    node(
      "terminal",
      "sub-2",
      { x: 3300, y: 120 },
      { width: 380, height: 240 },
      terminal,
    ),
    node(
      "terminal",
      "sub-3",
      { x: 1500, y: 2600 },
      { width: 380, height: 240 },
      terminal,
    ),
  ];
  const browser = node(
    "browser",
    "web",
    { x: 3600, y: 2700 },
    { width: 480, height: 320 },
    { kind: "browser", url: "about:blank" },
  );
  const edge = (source, target, role) => ({
    id: randomUUID(),
    boardId,
    source,
    target,
    kind: "link",
    ...(role ? { role } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  });
  return {
    main,
    subs,
    browser,
    nodes: [main, ...subs, browser],
    edges: [
      ...subs.map((sub) => edge(main.id, sub.id, "supervises")),
      // 浏览器连在阅读顺序最后的那个从上（sub-3），它挂在 sub-3 正下方，
      // 不夹在兄弟之间，三个从仍然等距。
      edge(subs[2].id, browser.id),
    ],
  };
}

const MERMAID_NEW = `flowchart LR
  A[入口] --> B{鉴权}
  B -->|通过| C[画布]
  B -->|拒绝| D[登录]
  C --> E[整理]`;

const MERMAID_LEGACY = `flowchart TD
  core[core] --> web[web]
  core --> server[server]
  web --> shared[shared]
  server --> shared`;

/* ---------------------------- 页面里的读与写 ---------------------------- */

/** 页面侧的辅助：从 Vite 取应用自己的模块，所以和画布是同一个 store。 */
const PAGE_HELPERS = `
  const store = (await import("/src/store/canvas-store.ts")).useCanvasStore;
  const model = await import("/src/canvas/whiteboard/model.ts");
  const snapshot = () => {
    const state = store.getState();
    const nodes = state.document?.nodes ?? [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const abs = (node) => {
      const parent = node.parentId ? byId.get(node.parentId) : null;
      return parent
        ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y }
        : { x: node.position.x, y: node.position.y };
    };
    return {
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        parentId: node.parentId ?? null,
        ...abs(node),
        w: node.size?.width ?? 0,
        h: node.size?.height ?? 0,
      })),
      items: state.whiteboard.items.map((item) => {
        const parent = item.parentId ? byId.get(item.parentId) : null;
        return {
          id: model.toItemId(item.id),
          parentId: item.parentId ?? null,
          x: item.x + (parent ? parent.position.x : 0),
          y: item.y + (parent ? parent.position.y : 0),
          w: item.w,
          h: item.h,
        };
      }),
      supervises: (state.document?.edges ?? []).filter((edge) => edge.role === "supervises").length,
    };
  };
`;

/* ------------------------------- 断言工具 ------------------------------- */

const intersects = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 一组对象之间的相对偏移（以第一个为基准），用来验「没被拆开」。 */
function offsets(entries) {
  const [first] = entries;
  return entries.map((entry) => [
    Math.round(entry.x - first.x),
    Math.round(entry.y - first.y),
  ]);
}

function bounds(entries) {
  const left = Math.min(...entries.map((entry) => entry.x));
  const top = Math.min(...entries.map((entry) => entry.y));
  const right = Math.max(...entries.map((entry) => entry.x + entry.w));
  const bottom = Math.max(...entries.map((entry) => entry.y + entry.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

async function main() {
  const workspace = mkdtempSync(join(tmpdir(), "armadra-tidy-"));
  cleanups.push(() =>
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20 }),
  );
  const project = join(workspace, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# probe\n");

  /* -------------------------------- core --------------------------------- */

  const binary = join(root, "apps/desktop/out/core/main.js");
  if (!existsSync(binary)) {
    throw new Error(
      `core 未构建：${binary}。先跑 pnpm --filter @armadra/desktop build`,
    );
  }
  const data = join(workspace, "runtime");
  mkdirSync(data, { recursive: true });
  cleanups.push(() =>
    execFileSync("tmux", ["-S", join(data, "tmux.sock"), "kill-server"], {
      stdio: "ignore",
    }),
  );
  const home = probeHome("armadra-canvas-tidy-home-");
  cleanups.push(home.remove);
  const environment = isolatedEnv(home, {
    ARMADRA_DATA_DIR: data,
    ARMADRA_LOG: process.env.ARMADRA_LOG ?? "warn",
  });
  const runtime = spawn(
    process.execPath,
    [binary, "--listen", "tcp:127.0.0.1:0", "--data-dir", data],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"], env: environment },
  );
  cleanups.push(() => runtime.kill("SIGKILL"));
  let diagnostics = "";
  runtime.stderr.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  const endpoints = join(data, "endpoints.json");
  let origin = "";
  for (let attempt = 0; attempt < 300 && !origin; attempt += 1) {
    if (runtime.exitCode !== null) throw new Error(`core 退出：${diagnostics}`);
    try {
      origin = JSON.parse(readFileSync(endpoints, "utf8")).runtime.http;
    } catch {
      await sleep(100);
    }
  }
  if (!(await fetch(new URL("/api/health", origin))).ok) {
    throw new Error("core 健康检查失败");
  }
  step("core 已启动", origin);

  const api = async (path, init) => {
    const answer = await fetch(new URL(path, origin), {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    if (!answer.ok) {
      throw new Error(`${path} → ${answer.status} ${await answer.text()}`);
    }
    return answer.json();
  };

  const created = await api("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "tidy",
      rootPath: project,
      permissions: { read: true, write: true, execute: true },
    }),
  });
  const boards = await api(`/api/workspaces/${created.id}/boards`);
  const board =
    boards[0] ??
    (await api(`/api/workspaces/${created.id}/boards`, {
      method: "POST",
      body: JSON.stringify({ name: "tidy" }),
    }));
  const document = await api(
    `/api/workspaces/${created.id}/boards/${board.id}/document`,
  );
  const seeded = seed(board.id);
  await api(`/api/workspaces/${created.id}/boards/${board.id}/document`, {
    method: "PUT",
    body: JSON.stringify({
      expectedUpdatedAt: document.board.updatedAt,
      nodes: seeded.nodes,
      edges: seeded.edges,
      viewport: { x: 0, y: 0, zoom: 0.25 },
      whiteboard: "",
    }),
  });
  step("节点就位", "1 主 3 从 + 浏览器");

  /* ---------------------------- Vite 开发服务器 -------------------------- */

  const port = await freePort();
  const vite = spawn(
    process.platform === "win32" ? "pnpm.exe" : "pnpm",
    [
      "--filter",
      "@armadra/web",
      "exec",
      "vite",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment, ARMADRA_DATA_DIR: data },
    },
  );
  cleanups.push(() => vite.kill("SIGKILL"));
  let served = false;
  vite.stdout.on("data", (chunk) => {
    if (String(chunk).includes("ready in")) served = true;
  });
  const page = `http://127.0.0.1:${port}/?workspace=${created.id}&board=${board.id}`;
  for (let attempt = 0; attempt < 900 && !served; attempt += 1) {
    if (vite.exitCode !== null) throw new Error("Vite 退出");
    await sleep(100);
  }
  if (!served) throw new Error("Vite 未就绪");
  step("开发服务器已就绪", page);

  /* --------------------------------- Chrome ------------------------------ */

  const executable =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executable)) {
    throw new Error(`找不到 Chrome：${executable}（可用 CHROME_PATH 指定）`);
  }
  const profile = mkdtempSync(join(tmpdir(), "armadra-tidy-profile-"));
  cleanups.push(() =>
    rmSync(profile, { recursive: true, force: true, maxRetries: 20 }),
  );
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  cleanups.push(() => browser.kill("SIGKILL"));
  let devtools = "";
  for (let attempt = 0; attempt < 300 && !devtools; attempt += 1) {
    try {
      devtools = readFileSync(join(profile, "DevToolsActivePort"), "utf8")
        .split("\n")[0]
        .trim();
    } catch {
      await sleep(100);
    }
  }
  if (!devtools) throw new Error("Chrome 未开出调试端口");
  const target = await (
    await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  cleanups.push(() => socket.close());
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(
        `${message.params.exceptionDetails.text}: ${
          message.params.exceptionDetails.exception?.description ?? ""
        }`.slice(0, 300),
      );
    }
  });
  report.pageErrors = errors;
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = (sequence += 1);
      pending.set(id, (message) =>
        message.error
          ? fail(new Error(message.error.message))
          : done(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (body) => {
    const answer = await call("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_HELPERS} ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ??
          answer.exceptionDetails.text ??
          "页面表达式抛错",
      );
    }
    return answer.result.value;
  };
  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      join(output, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
  };

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // 整理的过渡在减少动效下直接跳过，截图不用等动画。
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await call("Page.navigate", { url: page });

  let mounted = 0;
  for (
    let attempt = 0;
    attempt < 240 && mounted < seeded.nodes.length;
    attempt += 1
  ) {
    mounted = await evaluate(
      `return document.querySelectorAll(".react-flow__node").length;`,
    ).catch(() => 0);
    if (mounted < seeded.nodes.length) await sleep(500);
  }
  if (mounted < seeded.nodes.length) {
    throw new Error(`画布没挂上：${mounted} 个 RF 节点 ${errors.join(" | ")}`);
  }
  step("画布已挂载", `${mounted} 个 RF 节点`);

  // 实时协同完成第一次同步之前画布只读，同步一到会整份换成 core 的文档；
  // 等它可写再动手，否则改动会被冲掉。
  let writable = false;
  for (let attempt = 0; attempt < 120 && !writable; attempt += 1) {
    writable = await evaluate(`
      const realtime = store.getState().realtime;
      return !realtime || realtime.writable === true;
    `);
    if (!writable) await sleep(250);
  }
  if (!writable) throw new Error("画布一直不可写");
  step("画布可写");

  // 主从关系走页面的连线动作 `setEdgeRole`（与连线菜单「设为主从」同一条，
  // 经实时文档落盘）。文档 REST 保存的解析器不收边的 `role`，种子里写了也
  // 会被存成对等。
  await evaluate(`
    const ids = ${JSON.stringify(seeded.edges.filter((edge) => edge.role).map((edge) => edge.id))};
    for (const id of ids) store.getState().setEdgeRole(id, "supervises");
    return 0;
  `);

  /* -------------------- 导入：新入口一张、修复前那样一张 -------------------- */

  const imported = await evaluate(`
    const mermaid = await import("/src/canvas/whiteboard/mermaid/import.ts");
    const parse = await import("/src/canvas/whiteboard/mermaid/parse.ts");
    const layout = await import("/src/canvas/whiteboard/mermaid/layout.ts");
    const toItems = await import("/src/canvas/whiteboard/mermaid/to-items.ts");
    const scheme = await import("/src/canvas/whiteboard/scheme.ts");
    const wb = await import("/src/canvas/whiteboard/store.ts");

    // 新入口：整张图进一个组。
    const outcome = await mermaid.importMermaidText(${JSON.stringify(MERMAID_NEW)}, { x: 900, y: 300 });

    // 修复前的形状：同样一张图，对象全在顶层（parentId: null）。
    const parsed = await parse.parseMermaid(${JSON.stringify(MERMAID_LEGACY)});
    const laid = layout.centreLayout(
      layout.layoutGraph(parsed.graph, mermaid.layoutOptions()),
      { x: 400, y: 900 },
    );
    const legacy = toItems.graphToItems(parsed.graph, laid, {
      style: { color: "black", size: "m" },
      scheme: scheme.canvasScheme(),
      newId: wb.createItemId,
    });
    wb.addItems(legacy);

    // 手画的一组：一个框、框里一行字、一条从框伸出去的线。
    const drawn = [
      { id: crypto.randomUUID(), kind: "shape", geo: "rectangle", x: 3000, y: 900, w: 260, h: 160, z: 0, parentId: null, style: { color: "blue", size: "m" } },
      { id: crypto.randomUUID(), kind: "text", text: "todo", x: 3030, y: 940, w: 120, h: 32, z: 0, parentId: null, style: { color: "blue", size: "m" } },
      { id: crypto.randomUUID(), kind: "line", x: 3260, y: 980, w: 160, h: 4, z: 0, parentId: null, style: { color: "blue", size: "m" }, points: [[0, 0], [160, 4]], arrowEnd: true },
    ];
    for (const item of drawn) {
      const parsed = model.itemSchema.safeParse(item);
      if (!parsed.success) throw new Error("手画对象不合法：" + parsed.error.message);
    }
    const drawnIds = wb.addItems(drawn);
    store.getState().setSelection({ nodes: [], edges: [], items: [] });
    const state = store.getState();
    const group = state.document.nodes.find((node) => node.type === "group");
    return {
      groupId: group?.id ?? null,
      groupItems: state.whiteboard.items.filter((item) => item.parentId === group?.id).map((item) => model.toItemId(item.id)),
      legacy: legacy.map((item) => model.toItemId(item.id)),
      drawn: drawnIds.map((id) => model.toItemId(id)),
      outcome: outcome.kind,
    };
  `);
  check(
    "新入口导入成组",
    Boolean(imported.groupId) && imported.groupItems.length > 1,
    `${imported.groupItems.length} 个对象在组里`,
  );
  step("修复前形状的导入", `${imported.legacy.length} 个顶层对象`);
  step("手画框线", `${imported.drawn.length} 个对象`);

  await evaluate(
    `(await import("/src/canvas/flow/use-flow-viewport.ts")).fitView(); return 0;`,
  );
  await sleep(800);
  await capture("before");
  const before = await evaluate(`return snapshot();`);

  /* --------------------------------- 整理 -------------------------------- */

  const clicked = await evaluate(`
    const button = document.querySelector('button[aria-label="一键整理"], button[aria-label="Tidy up"]');
    if (!button) return false;
    button.click();
    return true;
  `);
  if (!clicked) throw new Error("Dock 上找不到「整理」按钮");
  await sleep(1200);
  await capture("after");
  const after = await evaluate(`return snapshot();`);
  report.before = before;
  report.after = after;

  /* --------------------------------- 断言 -------------------------------- */

  check(
    "主从边条数不变",
    before.supervises === after.supervises && after.supervises === 3,
    `${before.supervises} → ${after.supervises}`,
  );

  const byId = (snapshot) => {
    const map = new Map();
    for (const node of snapshot.nodes) map.set(node.id, node);
    for (const item of snapshot.items) map.set(item.id, item);
    return map;
  };
  const was = byId(before);
  const now = byId(after);
  const pick = (map, ids) => ids.map((id) => map.get(id));

  // 刚体：组、旧导入孤岛、手画框线各自整体平移。
  for (const [name, ids] of [
    ["导入组内相对位置不变", imported.groupItems],
    ["旧导入孤岛相对位置不变", imported.legacy],
    ["手画框线相对位置不变", imported.drawn],
  ]) {
    const a = JSON.stringify(offsets(pick(was, ids)));
    const b = JSON.stringify(offsets(pick(now, ids)));
    check(name, a === b, `${ids.length} 个对象`);
  }

  // 顶层单元两两不重叠：节点（含组）一个一格，白板孤岛整体一格。
  const units = [
    ...after.nodes.filter((node) => !node.parentId),
    bounds(pick(now, imported.legacy)),
    bounds(pick(now, imported.drawn)),
  ];
  const hits = [];
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      if (intersects(units[i], units[j])) hits.push(`${i}×${j}`);
    }
  }
  check(
    "顶层对象两两不重叠",
    hits.length === 0,
    hits.join(", ") || `${units.length} 个单元`,
  );

  const main = now.get(seeded.main.id);
  // 纵向布局：子在主下面一行，从左到右按原阅读顺序（sub-2 最上、sub-1、sub-3）。
  const subs = seeded.subs
    .map((sub) => now.get(sub.id))
    .sort((a, b) => a.x - b.x);
  const order = seeded.subs
    .map((sub) => [sub.id, was.get(sub.id)])
    .sort((a, b) => a[1].y - b[1].y)
    .map(([id]) => id);
  check(
    "子 Agent 保持原阅读顺序",
    JSON.stringify(subs.map((sub) => sub.id)) === JSON.stringify(order),
  );
  const ys = new Set(subs.map((sub) => sub.y));
  check(
    "子 Agent 在主下面同一行",
    ys.size === 1 && subs[0].y > main.y + main.h,
    `主 y=${main.y}，子 y=${[...ys].join("/")}`,
  );
  const blockMid = (subs[0].x + subs[2].x + subs[2].w) / 2;
  check(
    "主水平居中于子、子左右等距",
    Math.abs(main.x + main.w / 2 - blockMid) <= 8 &&
      subs[1].x - subs[0].x === subs[2].x - subs[1].x,
    subs.map((sub) => sub.x).join(" / "),
  );
  const web = now.get(seeded.browser.id);
  const host = now.get(seeded.subs[2].id);
  check(
    "浏览器挂在所连子 Agent 右侧同一行",
    web.y === host.y && web.x > host.x,
    `web (${web.x}, ${web.y})`,
  );
  const grid = [...after.nodes.filter((node) => !node.parentId)].every(
    (node) => node.x % 8 === 0 && node.y % 8 === 0,
  );
  check("顶层节点落在 8px 网格", grid);

  // 不再是一长排：整理后的包围盒宽高比不离谱。
  const all = bounds([...units]);
  report.afterBounds = all;
  check(
    "没有被排成一长排",
    all.w / all.h < 6,
    `${Math.round(all.w)}×${Math.round(all.h)}`,
  );

  /* ------------------------------ 幂等与撤销 ------------------------------ */

  await evaluate(`
    document.querySelector('button[aria-label="一键整理"], button[aria-label="Tidy up"]').click();
    return 0;
  `);
  await sleep(800);
  const twice = await evaluate(`return snapshot();`);
  check("再整理一次位移为 0", JSON.stringify(twice) === JSON.stringify(after));

  const undone = await evaluate(`
    store.getState().undo();
    return snapshot();
  `);
  const restored =
    undone.nodes.every((node) => {
      const old = was.get(node.id);
      return old && old.x === node.x && old.y === node.y;
    }) &&
    undone.items.every((item) => {
      const old = was.get(item.id);
      return old && old.x === item.x && old.y === item.y;
    });
  check("撤销一次整块回到整理前", restored);

  report.status = "ok";
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${report.error}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      cleanup();
    } catch {}
  }
  writeFileSync(
    join(output, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`  报告  ${join(output, "result.json")}`);
  process.exit(report.status === "ok" ? 0 : 1);
}
