// 场景：终端里按下的键，松开时选区一定结束（#227）。
//
// xterm 的选区靠 `document` 上的 `mouseup` 收尾；画布平移（d3-zoom）在 window
// 捕获相位吞掉 `mouseup`，于是手形工具下在终端里拖、或中键按在终端上，松开后
// 选区仍跟着指针走，开了鼠标上报的应用也收不到松开。这里逐条走一遍：
//
//  1. 选择工具：节点内按下、拖到节点外松开，之后不按键上下移动，选区不变；
//  2. 手形工具：同样的拖动（这一下平移画布），松开后不按键移动，选区不变；
//  3. 应用开了鼠标上报（`?1002h` + SGR）：中键按在终端上拖出去松开，应用收到
//     松开（`…m`）；
//  4. 节点内正常拖选照旧出选区。
//
// 选区用 DOM 渲染器画的 `.xterm-selection` 矩形读：默认渲染器就是 `dom`。
import { makeNode, sleep } from "./harness.mjs";

const nodeQuery = (id) =>
  `document.querySelector('.react-flow__node[data-id="${id}"]')`;

const selectionOf = (id) =>
  `const layer = ${nodeQuery(id)}?.querySelector(".xterm-selection");
   if (!layer) return null;
   return [...layer.children]
     .map((e) => [e.style.top, e.style.left, e.style.width, e.style.height].join("|"))
     .join(";");`;

const rectOf = (id, selector) =>
  `const node = ${nodeQuery(id)};
   const element = ${selector ? `node?.querySelector(${JSON.stringify(selector)})` : "node"};
   if (!element) return null;
   const r = element.getBoundingClientRect();
   return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };`;

export default async function terminalSelection({
  stack,
  output,
  report,
  scenario,
}) {
  const run = scenario(report, "终端选区随松开结束（#227）", output);
  const { workspace, board } = await stack.workspace("终端选区", stack.scratch);
  const terminal = makeNode(
    board.id,
    "terminal",
    "选区",
    { x: 120, y: 120 },
    { width: 520, height: 300 },
    { kind: "terminal" },
  );
  await stack.seedBoard(workspace.id, board.id, [terminal]);

  const page = await stack.browser.page(await stack.browser.context());
  await page.goto(stack.boardUrl(workspace.id, board.id));
  await page.settle();
  await page.until(
    `return ${nodeQuery(terminal.id)}?.querySelector(".xterm-screen") ? true : null;`,
    "终端挂上 xterm",
    { timeout: 30_000 },
  );
  const screenRect = () =>
    page.until(rectOf(terminal.id, ".xterm-screen"), "终端屏幕");
  const nodeRect = () => page.until(rectOf(terminal.id), "终端节点");
  /** 点一下画布空白处：焦点离开终端，工具快捷键才归画布。 */
  const focusCanvas = async () => {
    const node = await nodeRect();
    await page.click(node.right + 260, node.bottom + 120);
  };

  let screen = await screenRect();
  await page.click(screen.left + 40, screen.top + 20);
  await page.type("for i in $(seq 1 12); do echo line-$i-abcdefghij; done");
  await page.key("Enter");
  await page.until(
    `return (${nodeQuery(terminal.id)}?.querySelector(".xterm-rows")?.innerText ?? "").includes("line-12-abcdefghij") ? true : null;`,
    "终端输出了十二行",
    { timeout: 20_000 },
  );

  const viewport = await page.evaluate(
    `return { width: innerWidth, height: innerHeight };`,
  );
  /**
   * 节点内按下，拖到 `target(node)` 松开，然后不按键在 `back`（缺省就是松开处）
   * 上下晃，返回松开时与晃完的选区。
   */
  const dragOut = async (button = "left", target, back) => {
    screen = await screenRect();
    const node = await nodeRect();
    const from = { x: screen.left + 30, y: screen.top + 30 };
    const to = target?.(node) ?? {
      x: Math.min(node.right + 120, viewport.width - 20),
      y: node.top + 60,
    };
    const held = button === "middle" ? 4 : 1;
    await page.mouse("mouseMoved", from.x, from.y);
    await page.mouse("mousePressed", from.x, from.y, { button });
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse(
        "mouseMoved",
        from.x + ((to.x - from.x) * step) / 10,
        from.y + ((to.y - from.y) * step) / 10,
        { button, buttons: held },
      );
      await sleep(16);
    }
    await page.mouse("mouseReleased", to.x, to.y, { button });
    await sleep(250);
    const settled = await page.evaluate(selectionOf(terminal.id));
    const wiggle = back?.(node) ?? to;
    for (const dy of [-120, 60, -40, 140, 20]) {
      await page.mouse("mouseMoved", wiggle.x, Math.max(1, wiggle.y + dy));
      await sleep(30);
    }
    await sleep(250);
    const after = await page.evaluate(selectionOf(terminal.id));
    return { settled, after };
  };

  // 1. 选择工具，节点外松开。
  const plain = await dragOut();
  run.check(Boolean(plain.settled), "拖到节点外时有选区", plain.settled);
  run.check(
    plain.after === plain.settled,
    "选择工具：节点外松开后不按键移动，选区不变",
    plain,
  );

  // 1b. 窗口外松开：页面收不到这一下松开，指针回到窗口里时（键早已松开）收尾。
  const away = await dragOut(
    "left",
    (node) => ({ x: viewport.width + 80, y: node.top + 60 }),
    (node) => ({ x: viewport.width - 20, y: node.top + 60 }),
  );
  const awayFinal = await page.evaluate(selectionOf(terminal.id));
  await sleep(200);
  for (const dy of [-80, 80]) {
    await page.mouse("mouseMoved", viewport.width - 20, 300 + dy);
    await sleep(30);
  }
  run.check(
    Boolean(away.after) &&
      (await page.evaluate(selectionOf(terminal.id))) === awayFinal,
    "窗口外松开：回到窗口里不按键移动，选区不再变",
    { ...away, awayFinal },
  );

  // 2. 手形工具：这一下拖动平移画布，`mouseup` 被平移吞掉。
  await focusCanvas();
  await page.key("h");
  await page.until(
    `return document.querySelector('[aria-pressed="true"]')?.getAttribute("aria-label") === "手形" ? true : null;`,
    "切到手形工具",
  );
  const before = await nodeRect();
  // 往下拖：画布跟着往下平移，节点留在视口里。
  const hand = await dragOut("left", (node) => ({
    x: node.left + 40,
    y: node.bottom + 80,
  }));
  const panned = await nodeRect();
  run.check(
    Math.abs(panned.top - before.top) > 20,
    "手形工具：按在终端上拖动平移了画布",
    { before: before.top, after: panned.top },
  );
  run.check(
    hand.after === hand.settled,
    "手形工具：松开后不按键移动，选区不变",
    hand,
  );
  await focusCanvas();
  await page.key("v");
  await page.until(
    `return document.querySelector('[aria-pressed="true"]')?.getAttribute("aria-label") === "选择" ? true : null;`,
    "切回选择工具",
  );

  // 3. 应用开了鼠标上报：中键按下、拖出去松开，应用要收到松开。
  screen = await screenRect();
  await page.click(screen.left + 40, screen.top + 20);
  await page.type("clear; printf '\\033[?1002h\\033[?1006h'; cat -v");
  await page.key("Enter");
  await sleep(800);
  // 往上拖（中键同样平移画布），把上一步的平移大致还回去。
  await dragOut("middle", (node) => ({
    x: node.left + 40,
    y: Math.max(60, node.top - 80),
  }));
  const reports = await page.until(
    `const text = (${nodeQuery(terminal.id)}?.querySelector(".xterm-rows")?.innerText ?? "").replace(/\\s+/g, "");
     return /\\^\\[\\[<1;\\d+;\\d+M/.test(text) ? text : null;`,
    "应用收到中键按下",
  );
  run.check(
    /\^\[\[<1;\d+;\d+m/.test(reports),
    "鼠标上报：中键在节点外松开，应用收到松开",
    reports.slice(-160),
  );
  // 退出 cat 并关掉鼠标上报，回到普通 shell。
  await page.key("c", 2);
  await page.type("printf '\\033[?1002l\\033[?1006l'; clear");
  await page.key("Enter");
  await sleep(600);
  await page.type("for i in $(seq 1 12); do echo line-$i-abcdefghij; done");
  await page.key("Enter");
  await page.until(
    `return (${nodeQuery(terminal.id)}?.querySelector(".xterm-rows")?.innerText ?? "").includes("line-12-abcdefghij") ? true : null;`,
    "终端重新输出十二行",
    { timeout: 20_000 },
  );

  // 4. 节点内正常拖选照旧可用。
  screen = await screenRect();
  await page.drag(
    { x: screen.left + 10, y: screen.top + 30 },
    { x: screen.left + 200, y: screen.top + 60 },
  );
  const inside = await page.evaluate(selectionOf(terminal.id));
  run.check(Boolean(inside), "节点内拖拽照常出选区", inside);
  await run.shot(page, "terminal-selection");
  run.consoleClean(page);
  await page.close();
  run.entry.status = "passed";
}
