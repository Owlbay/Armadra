// 浮层安全区探针：在真 Chromium 里给根元素写上模拟的 `--safe-*` 与
// `--window-controls-top`（与 iPadOS 原生层写窗口控件同一个做法；桌面
// Chromium 的 `env()` 恒为 0），把 Popover / DropdownMenu / Select / Tooltip
// 的触发器钉在可用区域的四个角上，量浮层是否整个落在安全区以内；对话框与
// 抽屉量位置、最大高度、内边距与关闭钮。另挂一遍 `collisionPadding={0}`
// 的对照，证明量得出差别。
//
// 只起一个随机端口的 Vite 开发服务器和一个新 profile 的无头 Chrome；
// `ARMADRA_DATA_DIR` 指到空的临时目录，不起 core，跑完即删。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   node tools/probes/overlay-safe-area.mjs [输出目录]
//
// 产物：<输出目录>/result.json 与每种视口一张截图，默认
// target/overlay-safe-area/。
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harness, sleep, startChrome, startVite } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(
  process.argv[2] ?? join(root, "target/overlay-safe-area"),
);
mkdirSync(output, { recursive: true });

/** 两种形状：iPad 窗口化（窗口控件比状态栏高），手机横屏（左右刘海）。 */
const SCENARIOS = [
  {
    name: "ipad-windowed",
    width: 1180,
    height: 820,
    insets: { top: 24, right: 0, bottom: 20, left: 0, controlsTop: 40 },
  },
  {
    name: "phone-landscape",
    width: 844,
    height: 390,
    insets: { top: 0, right: 47, bottom: 21, left: 47, controlsTop: 0 },
  },
];
const KINDS = ["popover", "dropdown", "select", "tooltip"];
const CORNERS = ["tl", "tr", "bl", "br"];
/** 子像素取整的余量。 */
const EPSILON = 0.5;

const h = harness(output);
const { report, step } = h;
report.failures = [];
report.measurements = [];

function check(ok, name, detail = "") {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (ok) step(name, text);
  else {
    report.failures.push({ name, detail: text });
    console.error(`  FAIL  ${name} — ${text}`);
  }
}

await h.run(async () => {
  const data = h.temp("armadra-overlay-probe-");
  const origin = await startVite(h, root, {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    BROWSER: "none",
  });
  step("Vite 已启动", origin);
  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "overlay" });

  for (const scenario of SCENARIOS) {
    const { width, height, insets } = scenario;
    await page.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.call("Page.navigate", {
      url: `${origin}/showcase.html?theme=dark&only=1&visit=${scenario.name}#components`,
    });
    await page.waitFor(
      `return document.readyState === "complete" &&
         document.documentElement.dataset.showcaseReady === "true";`,
      { timeout: 60_000, what: "展示页就绪" },
    );
    await page.evaluate(`
      const style = document.documentElement.style;
      style.setProperty("--safe-top", "${insets.top}px");
      style.setProperty("--safe-right", "${insets.right}px");
      style.setProperty("--safe-bottom", "${insets.bottom}px");
      style.setProperty("--safe-left", "${insets.left}px");
      style.setProperty("--window-controls-top", "${insets.controlsTop}px");
      await import("/src/showcase/overlay-probe.tsx");
      return true;
    `);
    const area = {
      top: Math.max(insets.top, insets.controlsTop),
      right: width - insets.right,
      bottom: height - insets.bottom,
      left: insets.left,
    };
    const resolved = await page.evaluate(`
      const s = getComputedStyle(document.documentElement);
      return s.getPropertyValue("--overlay-inset-top");
    `);
    step(`${scenario.name}：可用区域`, { ...area, overlayInsetTop: resolved });

    /** 挂一个浮层，等动画结束，量它的外框。 */
    const measure = async (spec) => {
      await page.evaluate(
        `window.__overlayProbe.mount(${JSON.stringify(spec)}); return true;`,
      );
      await sleep(350);
      return page.evaluate(`
        const node = [...document.querySelectorAll("[data-probe-overlay]")].at(-1);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { top: r.top, right: r.right, bottom: r.bottom, left: r.left,
                 position: node.getAttribute("data-align-trigger") };
      `);
    };
    const outside = (rect) =>
      rect === null
        ? ["没有挂出来"]
        : [
            rect.top < area.top - EPSILON && `上 ${rect.top}`,
            rect.left < area.left - EPSILON && `左 ${rect.left}`,
            rect.right > area.right + EPSILON && `右 ${rect.right}`,
            rect.bottom > area.bottom + EPSILON && `下 ${rect.bottom}`,
          ].filter(Boolean);

    let unpaddedViolations = 0;
    for (const kind of KINDS) {
      for (const corner of CORNERS) {
        const rect = await measure({ kind, corner });
        const bad = outside(rect);
        report.measurements.push({
          scenario: scenario.name,
          kind,
          corner,
          rect,
        });
        check(
          bad.length === 0,
          `${scenario.name} ${kind} ${corner} 落在安全区内`,
          bad.length === 0 ? JSON.stringify(rect) : bad.join("，"),
        );
        if (kind === "select") {
          check(
            rect?.position === "false",
            `${scenario.name} select 有安全区时改用 popper`,
            String(rect?.position),
          );
        }
        if (kind !== "select") {
          const control = await measure({ kind, corner, unpadded: true });
          if (outside(control).length > 0) unpaddedViolations += 1;
        }
      }
    }
    // 对照：碰撞边距为 0 时至少有一处越界，说明上面的「通过」不是量空了。
    check(
      unpaddedViolations > 0,
      `${scenario.name} 对照（collisionPadding=0）确有越界`,
      `${unpaddedViolations} 处`,
    );

    const dialog = await measure({ kind: "dialog", corner: "tl" });
    const dialogBad = outside(dialog);
    check(
      dialogBad.length === 0,
      `${scenario.name} 对话框（高 2000px 的内容）落在安全区内`,
      dialogBad.length === 0 ? JSON.stringify(dialog) : dialogBad.join("，"),
    );
    await page.capture(`${scenario.name}-dialog`);
    await page.evaluate(`window.__overlayProbe.unmount(); return true;`);
    await sleep(200);

    // 抽屉：点组件分区里现成的那个（右侧）。
    const opened = await page.evaluate(`
      for (const trigger of document.querySelectorAll('[aria-haspopup="dialog"]')) {
        trigger.click();
        await new Promise((done) => setTimeout(done, 300));
        if (document.querySelector('[data-slot="sheet-content"]')) return true;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((done) => setTimeout(done, 300));
      }
      return false;
    `);
    check(opened, `${scenario.name} 打开组件分区的抽屉`);
    if (opened) {
      await sleep(300);
      const sheet = await page.evaluate(`
        const node = document.querySelector('[data-slot="sheet-content"]');
        const s = getComputedStyle(node);
        const close = node.querySelector(':scope > button');
        const c = close?.getBoundingClientRect();
        return {
          side: node.getAttribute("data-side"),
          paddingTop: parseFloat(s.paddingTop),
          paddingRight: parseFloat(s.paddingRight),
          paddingBottom: parseFloat(s.paddingBottom),
          close: c ? { top: c.top, right: c.right } : null,
        };
      `);
      report.measurements.push({
        scenario: scenario.name,
        kind: "sheet",
        sheet,
      });
      check(
        sheet.side === "right" &&
          sheet.paddingTop === insets.top &&
          sheet.paddingRight === insets.right &&
          sheet.paddingBottom === insets.bottom,
        `${scenario.name} 右侧抽屉的内边距等于安全区`,
        sheet,
      );
      check(
        sheet.close !== null &&
          sheet.close.top >= insets.top - EPSILON &&
          sheet.close.right <= width - insets.right + EPSILON,
        `${scenario.name} 抽屉关闭钮让开安全区`,
        sheet.close,
      );
      await page.capture(`${scenario.name}-sheet`);
    }
  }
  const { errors } = page.drain();
  check(errors.length === 0, "控制台没有 error", errors);
});
