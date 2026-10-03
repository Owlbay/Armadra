// 设计展示页（docs/design/design-showcase.md §3）的截图探针。
//
// 只起两样东西：一个随机端口的 Vite 开发服务器（读 apps/web）和一个新 profile
// 的无头 Chrome。不起 core、不起 tmux，`ARMADRA_DATA_DIR` 指到一个空的临时
// 目录（Vite 配置会去那里找 Runtime 的 endpoints.json），不读写操作员自己的
// 数据目录；临时目录跑完即删。
//
// 每个分区 × 主题 × 视口截一张整页图，另外：
//   * 深浅两套主题各执行一次 `window.__showcaseContrast()`——读浏览器算出来的
//     颜色核算设计系统 §2.1–§2.5 的每一对，低于阈值即失败；
//   * `components` 分区按 Tab 走一遍：每个可聚焦元素都要被走到、命中
//     `:focus-visible`、并且看得见焦点环；
//   * `prefers-reduced-motion: reduce` 下 `canvas` 分区的动画必须静止
//     （隔 700ms 的两张截图逐字节相同，且没有在跑的动画）；
//   * `forced-colors: active` 下 `components` 分区的焦点仍有轮廓；
//   * 控制台 error 与未捕获异常一律算失败；
//   * `apps/web/dist/` 存在时（CI 先构建再跑探针）确认里面没有展示页。
//
// 用法（仓库根目录）：
//   pnpm libs:build
//   node tools/probes/design-showcase.mjs [输出目录] [--only=tokens,acp]
//        [--theme=dark] [--width=390] [--diff=<上一次的输出目录>]
//
// 产物：<输出目录>/<分区>-<主题>-<宽>.png、两张额外图与 result.json，
// 默认 target/design-showcase/。`--diff` 逐像素比较同名 PNG，差异超过 0.5%
// 的列进 result.json 的 `changed`。
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { harness, sleep, startChrome, startVite } from "./shell-e2e-lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];
const THEMES = ["dark", "light"];
const DIFF_THRESHOLD = 0.005;
/** 整页截图的高度上限：一个分区长到这里已经说明它该拆了。 */
const MAX_HEIGHT = 16_000;

/* --------------------------------- 参数 ---------------------------------- */

const options = { only: null, theme: null, width: null, diff: null };
let outputArg = null;
for (const arg of process.argv.slice(2)) {
  const match = /^--(only|theme|width|diff)=(.*)$/.exec(arg);
  if (match) options[match[1]] = match[2];
  else if (!arg.startsWith("--")) outputArg = arg;
  else throw new Error(`不认识的参数：${arg}`);
}
const output = resolve(outputArg ?? join(root, "target/design-showcase"));
mkdirSync(output, { recursive: true });
const themes = options.theme ? options.theme.split(",") : THEMES;
const viewports = options.width
  ? VIEWPORTS.filter((viewport) =>
      options.width.split(",").includes(String(viewport.width)),
    )
  : VIEWPORTS;
for (const theme of themes)
  if (!THEMES.includes(theme)) throw new Error(`没有这个主题：${theme}`);
if (viewports.length === 0) throw new Error(`没有这个宽度：${options.width}`);

const h = harness(output);
const { report, step } = h;
report.failures = [];
report.captures = [];
report.console = [];

function check(ok, name, detail = "") {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (ok) step(name, text);
  else {
    report.failures.push({ name, detail: text });
    console.error(`  FAIL  ${name}${text ? ` — ${text}` : ""}`);
  }
}

/* ------------------------------- PNG 比较 -------------------------------- */

/** 够用的 PNG 解码：8 位 RGB / RGBA、不隔行——Chrome 截图只产这两种。 */
export function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0)
        throw new Error("只支持 8 位、不隔行的 PNG");
      colorType = data[9];
    } else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(
      raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
    );
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = (line[x] + add) & 255;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = line[from];
      pixels[to + 1] = line[from + 1];
      pixels[to + 2] = line[from + 2];
      pixels[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** 两张图不同像素的占比；尺寸不同算全部不同。 */
export function pixelDifference(left, right) {
  const a = decodePng(left);
  const b = decodePng(right);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  for (let index = 0; index < a.pixels.length; index += 4) {
    if (
      a.pixels[index] !== b.pixels[index] ||
      a.pixels[index + 1] !== b.pixels[index + 1] ||
      a.pixels[index + 2] !== b.pixels[index + 2] ||
      a.pixels[index + 3] !== b.pixels[index + 3]
    )
      changed += 1;
  }
  return changed / (a.width * a.height);
}

/* ------------------------------ 产物检查 --------------------------------- */

/** 只在展示页源码里出现的串，与 `src/showcase/production.test.ts` 同一张表。 */
const MARKERS = [
  "design showcase is dev-only",
  "__showcaseContrast",
  "__showcaseSections",
  "showcaseReady",
  "data-showcase-section",
];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

function checkBundle() {
  const dist = join(root, "apps/web/dist");
  if (!existsSync(join(dist, "index.html"))) {
    report.bundle = { checked: false };
    step("apps/web/dist 未构建，跳过产物检查");
    return;
  }
  const files = walk(dist);
  const leaks = files
    .filter((file) => /showcase/i.test(relative(dist, file)))
    .map((file) => relative(dist, file));
  for (const file of files.filter((file) => /\.(js|html|css)$/.test(file))) {
    const text = readFileSync(file, "utf8");
    for (const marker of MARKERS)
      if (text.includes(marker))
        leaks.push(`${relative(dist, file)}: ${marker}`);
  }
  report.bundle = { checked: true, files: files.length, leaks };
  check(
    leaks.length === 0,
    "生产产物里没有展示页",
    leaks.join(", ") || `${files.length} 个文件`,
  );
}

/* --------------------------------- 主流程 -------------------------------- */

await h.run(async () => {
  checkBundle();

  const data = h.temp("armadra-showcase-");
  const origin = await startVite(h, root, {
    ...process.env,
    ARMADRA_DATA_DIR: data,
    BROWSER: "none",
  });
  step("Vite 已启动", origin);

  const chrome = await startChrome(h);
  const page = await chrome.open({ name: "showcase" });
  let visit = 0;

  const setViewport = async ({ width, height }) => {
    await page.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
  };
  /** 整页导航（带一个递增参数，hash 相同也真的重新加载）并等页面就绪。 */
  const open = async (section, theme) => {
    visit += 1;
    const url = `${origin}/showcase.html?theme=${theme}&only=1&visit=${visit}#${section}`;
    await page.call("Page.navigate", { url });
    await page.waitFor(
      `return document.readyState === "complete" &&
         document.documentElement.dataset.showcaseReady === "true" &&
         document.documentElement.dataset.theme === ${JSON.stringify(theme)} &&
         !!document.querySelector('[data-showcase-section=${JSON.stringify(section)}]');`,
      { timeout: 60_000, what: `${section} 就绪` },
    );
    await page.evaluate(`await document.fonts.ready; return true;`);
    await sleep(300);
  };
  /** 整页截图：视口宽 × 内容高。`file` 为空时只取字节、不落盘。 */
  const capture = async (file, width) => {
    const metrics = await page.call("Page.getLayoutMetrics");
    const height = Math.min(
      Math.ceil(metrics.cssContentSize.height),
      MAX_HEIGHT,
    );
    const shot = await page.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const bytes = Buffer.from(shot.data, "base64");
    const path = file ? join(output, `${file}.png`) : null;
    if (path) writeFileSync(path, bytes);
    return { path, bytes, height };
  };
  const drainConsole = (where) => {
    const { errors } = page.drain();
    for (const error of errors) report.console.push({ where, ...error });
    return errors;
  };
  const tab = () =>
    (async () => {
      for (const type of ["rawKeyDown", "keyUp"])
        await page.call("Input.dispatchKeyEvent", {
          type,
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
      // 焦点环有 box-shadow 过渡，等它画完再量。
      await sleep(200);
    })();

  // 预热：Vite 第一次看到依赖时会预构建并整页刷新一次，别让它落在截图里。
  await setViewport(VIEWPORTS[0]);
  await open("tokens", "dark");
  await sleep(2000);
  await open("tokens", "dark");
  const all = await page.evaluate(`return window.__showcaseSections ?? null;`);
  if (!Array.isArray(all) || all.length === 0)
    throw new Error("展示页没有登记分区（window.__showcaseSections）");
  const only = options.only ? options.only.split(",") : all;
  for (const id of only)
    if (!all.includes(id)) throw new Error(`没有这个分区：${id}`);
  report.sections = only;
  report.themes = themes;
  report.widths = viewports.map((viewport) => viewport.width);
  drainConsole("warm-up");
  step("分区", only.join(", "));

  /* ------------------------------ 截图矩阵 ------------------------------ */

  for (const viewport of viewports) {
    await setViewport(viewport);
    for (const theme of themes) {
      for (const section of only) {
        const started = Date.now();
        await open(section, theme);
        const name = `${section}-${theme}-${viewport.width}`;
        const shot = await capture(name, viewport.width);
        const errors = drainConsole(name);
        report.captures.push({
          section,
          theme,
          width: viewport.width,
          height: shot.height,
          file: shot.path,
          ms: Date.now() - started,
          errors: errors.length,
        });
        check(
          errors.length === 0,
          `截图 ${name}`,
          errors.length ? errors : shot.path,
        );
      }
    }
  }

  /* -------------------------------- 对比度 ------------------------------ */

  await setViewport(VIEWPORTS[0]);
  report.contrast = {};
  for (const theme of themes) {
    await open("tokens", theme);
    const pairs = await page.evaluate(`return window.__showcaseContrast();`);
    report.contrast[theme] = pairs;
    const failing = pairs.filter((pair) => !pair.pass);
    check(
      pairs.length > 0 && failing.length === 0,
      `${theme} 主题对比度 ${pairs.length} 对`,
      failing.length
        ? failing.map((pair) => `${pair.fg} on ${pair.bg} ${pair.ratio}`)
        : `最低 ${Math.min(...pairs.map((pair) => pair.ratio))}`,
    );
  }

  /* ------------------------------ Tab 可达 ------------------------------ */

  if (only.includes("components")) {
    await open("components", themes[0]);
    // 可聚焦元素：tabIndex ≥ 0、没禁用、看得见。Radix 的漫游焦点组（RadioGroup、
    // Tabs、ToggleGroup）根节点自己也是 tabIndex 0，但它一拿到焦点就转给当前项，
    // 所以「里面还有可聚焦后代」的容器不算一个落点。
    const total = await page.evaluate(`
      const root = document.querySelector('[data-showcase-section="components"]');
      const tabbable = [...root.querySelectorAll("*")].filter((element) =>
        element.tabIndex >= 0 && !element.disabled &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden");
      const stops = tabbable.filter((element) =>
        !tabbable.some((other) => other !== element && element.contains(other)));
      stops.forEach((element, index) => element.setAttribute("data-probe-tab", String(index)));
      document.activeElement?.blur?.();
      return stops.length;
    `);
    const reached = new Set();
    const ringless = [];
    const strangers = [];
    for (let press = 0; press < total + 3; press += 1) {
      await tab();
      const hit = await page.evaluate(`
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        // 漫游焦点组的根把焦点转给当前项：落点记在离它最近的那个登记过的容器上。
        const index = element.closest("[data-probe-tab]")?.getAttribute("data-probe-tab") ?? null;
        // 焦点环：轮廓，或一圈有扩展半径、不透明度不为零的 box-shadow（shadcn 的
        // ring）。画在元素自己、它的控件外壳（input-group），或外壳里的当前格
        // （input-otp 的 data-active 格）上都算。
        const ringOf = (node) => {
          const style = getComputedStyle(node);
          if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) return true;
          return style.boxShadow.split(/,(?![^(]*\\))/).some((shadow) => {
            // 颜色可能是 rgb()、oklab()、color(srgb …)：取函数里「/」后或第四个值做不透明度。
            const call = /[a-z-]+\\(([^)]*)\\)/i.exec(shadow);
            let alpha = /transparent/.test(shadow) ? 0 : 1;
            if (call) {
              const [, slash] = call[1].split("/");
              const commas = call[1].split(",");
              alpha = slash !== undefined ? parseFloat(slash)
                : commas.length === 4 ? parseFloat(commas[3]) : 1;
            }
            const lengths = shadow.replace(/[a-z-]+\\([^)]*\\)/i, "")
              .replace(/inset|transparent/g, "").trim().split(/\\s+/).map(parseFloat);
            return alpha > 0 && (lengths[3] ?? 0) > 0;
          });
        };
        const shell = element.parentElement?.parentElement;
        const ring = [element, element.parentElement, shell,
          ...(shell ? shell.querySelectorAll('[data-active="true"]') : [])]
          .filter(Boolean)
          .some(ringOf);
        return {
          index,
          visible: element.matches(":focus-visible"),
          ring,
          label: [element.tagName.toLowerCase(), element.getAttribute("data-slot"),
            (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)]
            .filter(Boolean).join(" "),
        };
      `);
      if (!hit) continue;
      if (hit.index === null) {
        strangers.push(hit.label);
        continue;
      }
      if (hit.visible) reached.add(hit.index);
      if (!hit.ring) ringless.push(hit.label);
    }
    const missing = await page.evaluate(`
      const reached = new Set(${JSON.stringify([...reached])});
      return [...document.querySelectorAll("[data-probe-tab]")]
        .filter((element) => !reached.has(element.getAttribute("data-probe-tab")))
        .map((element) => (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().slice(0, 40));
    `);
    report.tab = {
      focusable: total,
      reached: reached.size,
      missing,
      ringless,
      strangers,
    };
    check(
      total > 0 && reached.size === total,
      `components 分区 Tab 可达 ${reached.size}/${total}`,
      missing.length ? missing : "",
    );
    check(ringless.length === 0, "每次 Tab 落点都有可见焦点环", ringless);
    drainConsole("tab");
  }

  /* ----------------------------- 减少动效 ------------------------------- */

  if (only.includes("canvas")) {
    const theme = themes[0];
    await open("canvas", theme);
    await sleep(500);
    const movingA = (await capture(null, 1440)).bytes;
    await sleep(700);
    const movingB = (await capture(null, 1440)).bytes;
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await open("canvas", theme);
    await sleep(500);
    const running = await page.evaluate(`
      return document.getAnimations()
        .filter((animation) => animation.playState === "running")
        .map((animation) => animation.animationName ?? animation.constructor.name);
    `);
    const first = await capture(`canvas-${theme}-1440-reduced-motion`, 1440);
    await sleep(700);
    const second = await capture(null, 1440);
    report.reducedMotion = {
      running,
      still: first.bytes.equals(second.bytes),
      animatedWithoutReduce: !movingA.equals(movingB),
      file: first.path,
    };
    check(
      running.length === 0 && report.reducedMotion.still,
      "减少动效下 canvas 分区静止",
      running.length ? running : first.path,
    );
    await page.call("Emulation.setEmulatedMedia", { features: [] });
    drainConsole("reduced-motion");
  }

  /* ----------------------------- 强制颜色 ------------------------------- */

  if (only.includes("components")) {
    const theme = themes[0];
    await page.call("Emulation.setEmulatedMedia", {
      features: [{ name: "forced-colors", value: "active" }],
    });
    await open("components", theme);
    await page.evaluate(`document.activeElement?.blur?.(); return true;`);
    await tab();
    const focus = await page.evaluate(`
      const element = document.activeElement;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        forced: matchMedia("(forced-colors: active)").matches,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    `);
    const shot = await capture(`components-${theme}-1440-forced-colors`, 1440);
    report.forcedColors = { ...focus, file: shot.path };
    check(
      focus.forced &&
        focus.outlineStyle !== "none" &&
        focus.outlineWidth !== "0px",
      "强制颜色下焦点轮廓可见",
      focus,
    );
    await page.call("Emulation.setEmulatedMedia", { features: [] });
    drainConsole("forced-colors");
  }

  /* -------------------------------- 对照 -------------------------------- */

  if (options.diff) {
    const previous = resolve(options.diff);
    report.changed = [];
    for (const capture of report.captures) {
      const name = relative(output, capture.file);
      const before = join(previous, name);
      if (!existsSync(before)) {
        report.changed.push({ file: name, ratio: null, reason: "new" });
        continue;
      }
      const ratio = pixelDifference(
        readFileSync(before),
        readFileSync(capture.file),
      );
      if (ratio > DIFF_THRESHOLD)
        report.changed.push({
          file: name,
          ratio: Math.round(ratio * 10_000) / 10_000,
        });
    }
    step(`对照 ${previous}`, `${report.changed.length} 张有变化`);
  }

  check(report.console.length === 0, "控制台没有 error", report.console);
  step("截图", `${report.captures.length} 张`);
});
