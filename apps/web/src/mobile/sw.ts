/**
 * Service worker 入口（推送，契约 §19）：构建时由 `vite.config.ts` 的
 * `armadra-service-worker` 单独打成一个 IIFE 挂在站点根 `/sw.js`，作用域覆盖
 * 整个页面。只用 `push/service-worker.ts` 的 worker 一半；页面一半在打包时被
 * 摇掉，所以这里没有 `window`、没有 i18n、没有 store。
 */
import {
  installPushHandlers,
  type PushWorkerScope,
} from "../push/service-worker";

installPushHandlers(globalThis as unknown as PushWorkerScope);
