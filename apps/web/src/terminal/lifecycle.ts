/**
 * 终端前端的分阶段生命周期（性能设计 §2.4 B2）。
 *
 * 三层分开看：会话（core 的 PTY / tmux）永远不动；表面的 React 状态（会话 id、
 * 输入账、离屏缓冲、最后行列数）常驻；只有显示层（`Terminal` 实例、渲染器、
 * 观察器）可以整块销毁再重建。
 *
 * | 阶段       | 显示层 | 传输 | 输出                   |
 * |------------|--------|------|------------------------|
 * | `live`     | 有     | 连着 | 直写                   |
 * | `parked`   | 有     | 连着 | 共享调度器批写         |
 * | `detached` | 有     | 关   | 无（core 侧不发）       |
 * | `released` | 销毁   | 关   | 无                     |
 *
 * 这里只放纯函数：迁移时机与豁免都要靠单测钉死。
 */

import type { MemoryPressureLevel } from "./pressure-bus";
import { HIDDEN_DETACH_MS } from "./render-state";
import { DETACH_GRACE_MS } from "./surface/constants";

export type LifecyclePhase = "live" | "parked" | "detached" | "released";

/* -------------------------------- 时序常量 -------------------------------- */

/**
 * 平移出视口多久后收 socket。画布不裁剪节点，离屏终端以前一直连着、一直收
 * 输出；一分钟和窗口后台同一个量级。设成 `null` 即退回「平移离屏不断开」。
 */
export const OFFSCREEN_DETACH_MS: number | null = 60_000;

/** 豁免命中时多久后再看一次。 */
export const LIFECYCLE_RECHECK_MS = 5_000;

/**
 * 告警档内存压力时释放离屏多久以上的实例；与压力策略的
 * `WARNING_RELEASE_OFFSCREEN_MS` 同值。紧急档不限时长。
 */
export const PRESSURE_WARNING_RELEASE_MS = 30_000;

export const RELEASE_AFTER_OPTIONS = ["5m", "10m", "30m", "never"] as const;
export type ReleaseAfter = (typeof RELEASE_AFTER_OPTIONS)[number];
export const DEFAULT_RELEASE_AFTER: ReleaseAfter = "10m";

/** 设置项 → 毫秒；`never` 是 `null`（退回不释放显示层）。 */
export function releaseAfterMs(value: ReleaseAfter): number | null {
  switch (value) {
    case "5m":
      return 5 * 60_000;
    case "10m":
      return 10 * 60_000;
    case "30m":
      return 30 * 60_000;
    case "never":
      return null;
  }
}

/* -------------------------------- 可见性 --------------------------------- */

export interface VisibilityInputs {
  collapsed: boolean;
  onScreen: boolean;
  pageVisible: boolean;
}

/** 有人在看：未折叠、在视口里、窗口在前台。 */
export function isSeen(inputs: VisibilityInputs): boolean {
  return !inputs.collapsed && inputs.onScreen && inputs.pageVisible;
}

/**
 * 看不见之后多久收 socket；看得见时是 `null`。三种看不见取最短的那一档：
 * 折叠 5 s，窗口后台与平移离屏各 60 s。
 */
export function detachDelay(inputs: VisibilityInputs): number | null {
  if (isSeen(inputs)) return null;
  if (inputs.collapsed) return DETACH_GRACE_MS;
  if (!inputs.pageVisible) return HIDDEN_DETACH_MS;
  return OFFSCREEN_DETACH_MS;
}

export function resolveLifecycle(inputs: {
  seen: boolean;
  detached: boolean;
  released: boolean;
}): LifecyclePhase {
  if (inputs.released) return "released";
  if (inputs.detached) return "detached";
  return inputs.seen ? "live" : "parked";
}

/* --------------------------------- 豁免 ---------------------------------- */

export interface HoldInputs {
  /** 启动行已武装、还没敲出去。 */
  launchArmed: boolean;
  /** 节点还在等依赖再敲启动行（`agent.pendingLaunch`）。 */
  pendingLaunch: boolean;
  /** `starting` / `connecting`，或者休眠正在接回。 */
  connecting: boolean;
  /** 有发出去还没被 core 确认的输入，或者排着队等传输的输入。 */
  unackedInput: boolean;
  /** 这个节点是聚焦模式里的那一个。 */
  focusNode: boolean;
  /** Agent 在等审批。 */
  blocked: boolean;
}

/**
 * 能不能收 socket。启动序列与在途输入挡住它：收了 socket，启动行的计时器
 * 跟着停，在途输入要等下一次 attach 才知道落没落地。
 */
export function canDetach(inputs: HoldInputs): boolean {
  return (
    !inputs.launchArmed &&
    !inputs.pendingLaunch &&
    !inputs.connecting &&
    !inputs.unackedInput
  );
}

/**
 * 能不能销毁显示层。在 `canDetach` 之外再挡两条：聚焦节点与等审批的 Agent
 * ——用户多半马上就要看，释放了也是立刻重建，净亏。
 */
export function canRelease(inputs: HoldInputs): boolean {
  return canDetach(inputs) && !inputs.focusNode && !inputs.blocked;
}

/**
 * 内存压力要不要提前释放一个看不见的实例。可见的一律不动；告警档只动离屏
 * 够久的，紧急档全部；`normal` 什么都不做（降级不重建，等用户看到再恢复）。
 */
export function pressureReleases(
  level: MemoryPressureLevel,
  unseenForMs: number | null,
): boolean {
  if (unseenForMs === null) return false;
  if (level === "critical") return true;
  if (level === "warning") return unseenForMs >= PRESSURE_WARNING_RELEASE_MS;
  return false;
}
