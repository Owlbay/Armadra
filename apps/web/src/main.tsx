import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
// Tailwind v4 入口；它自己 @import 了 tokens.css，这里不再单独引入
import "./styles/app.css";
import "./styles/nodes.css";
import { mountSplash } from "./splash/mount";
import { MobileRoot } from "./mobile/MobileRoot";
import { prepareEntry, type Entry } from "./mobile/entry";
import { installPageErrorReporting } from "./diagnostics/report";
import { installShellTransport } from "./api/shell-transport";

/**
 * 开屏动画先挂：它有自己的 root，不等下面那个 Promise，所以 Runtime 该连连、
 * App 该挂挂，动画只是浮在上面的一层（`splash/mount.tsx`）。
 */
mountSplash();

/**
 * 桌面壳里每个发往 core 的请求与流都带票据换来的凭据（契约 §3.2）：装在本机源
 * 上（`api/source.ts`），先于任何一次请求装好。不在壳里什么也不做。
 */
installShellTransport();

/** 页面错误上报（契约 §30）：默认关，core 答「开」之前一条也不收。 */
installPageErrorReporting();

/**
 * 入口分支（架构 §10）：原生 App 还没连上 Gateway、或手机浏览器扫码带着配对
 * 票打开时先是连接页；其余（桌面窗口、普通网页）直接是画布，`prepareEntry`
 * 在那条路上不发请求。
 */
const entry: Promise<Entry> = prepareEntry().catch(
  (): Entry => ({ kind: "app" }),
);

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
