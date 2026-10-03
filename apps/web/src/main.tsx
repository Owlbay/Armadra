import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
// Tailwind v4 入口；它自己 @import 了 tokens.css，这里不再单独引入
import "./styles/app.css";
import "./styles/nodes.css";
import { mountSplash } from "./splash/mount";
import { initRuntimeSockets } from "./api/client";
import { MobileRoot } from "./mobile/MobileRoot";
import { prepareEntry, type Entry } from "./mobile/entry";

/**
 * 开屏动画先挂：它有自己的 root，不等下面那个 Promise，所以 Runtime 该连连、
 * App 该挂挂，动画只是浮在上面的一层（`splash/mount.tsx`）。
 */
mountSplash();

/**
 * 终端与事件流的 WebSocket 地址在桌面壳里不等于 HTTP 地址（roadmap §4.4），
 * 先问一次壳再挂载：这一步只有一次本地请求，失败也会回退到 HTTP 基址，
 * 所以不用挡住渲染之外的任何东西。
 *
 * 入口分支（架构 §10）：原生 App 还没连上 Gateway、或手机浏览器扫码带着配对
 * 票打开时先是连接页；其余（桌面窗口、普通网页）直接是画布，`prepareEntry`
 * 在那条路上不发请求。
 */
const entry: Promise<Entry> = initRuntimeSockets()
  .catch(() => undefined)
  .then(() => prepareEntry())
  .catch((): Entry => ({ kind: "app" }));

void entry.then((entry) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MotionConfig
        reducedMotion="user"
        // 与 tokens.css 的 `--ease-out` 同一条曲线（设计系统 §2.10）
        transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
      >
        <MobileRoot entry={entry} />
      </MotionConfig>
    </StrictMode>,
  );
});
