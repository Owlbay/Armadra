/**
 * 简洁模式（ACP 设计 §8 第 3 条）：本机偏好 `ui.simpleMode`，缺省关。
 *
 * 开着时只是**不显示**一批高级入口，不删任何功能：
 *
 *  * 节点菜单隐藏「回收 / 权限模式 / 终端视图」；
 *  * 终端节点头部徽标只留状态与审批；
 *  * 侧栏的 Agent 面板默认展开；
 *  * 新建菜单只剩「新建 Agent…」与便签 / 白板。
 *
 * 隐藏清单写在这一个文件里，各处只问「这一项在简洁模式下还显示吗」——加一
 * 个入口时只改这里，`simple-mode.test.ts` 守着清单本身。
 */
import { create } from "zustand";

import {
  readStored,
  storedBoolean,
  writeStored,
} from "@/app/preferences/storage";

export const SIMPLE_MODE_KEY = "armadra.ui.simpleMode";

interface SimpleModeState {
  simpleMode: boolean;
  setSimpleMode: (value: boolean) => void;
}

export const useSimpleModeStore = create<SimpleModeState>((set) => ({
  simpleMode: storedBoolean(SIMPLE_MODE_KEY, false),
  setSimpleMode: (value) => {
    writeStored(SIMPLE_MODE_KEY, String(value));
    set({ simpleMode: value });
  },
}));

/** 非组件代码（菜单规格、注册表回调）读当前值。 */
export function isSimpleMode(): boolean {
  return useSimpleModeStore.getState().simpleMode;
}

export function useSimpleMode(): boolean {
  return useSimpleModeStore((state) => state.simpleMode);
}

/** 仅测试用：按 localStorage 重读一次。 */
export function reloadSimpleMode(): void {
  useSimpleModeStore.setState({
    simpleMode: readStored(SIMPLE_MODE_KEY) === "true",
  });
}

/** 节点菜单里简洁模式下不显示的项：精确 id 或 `前缀*`。 */
export const SIMPLE_HIDDEN_NODE_MENU: readonly string[] = [
  "agent.recycle",
  "agent.permission.*",
  "agent.driver.terminal",
];

/** 新建菜单在简洁模式下只留这几项。 */
export const SIMPLE_ADD_MENU: readonly string[] = [
  "add.newAgent",
  "add.sticky",
  "add.text",
  "add.frame",
];

function matches(id: string, pattern: string): boolean {
  return pattern.endsWith("*")
    ? id.startsWith(pattern.slice(0, -1))
    : id === pattern;
}

export function hiddenInSimpleMode(menuItemId: string): boolean {
  return SIMPLE_HIDDEN_NODE_MENU.some((pattern) =>
    matches(menuItemId, pattern),
  );
}

/** 节点菜单：简洁模式下滤掉隐藏清单里的项。 */
export function visibleNodeMenu<T extends { id: string }>(
  items: readonly T[],
  simple: boolean = isSimpleMode(),
): T[] {
  return simple
    ? items.filter((item) => !hiddenInSimpleMode(item.id))
    : [...items];
}

/** 新建菜单：简洁模式下只留 `SIMPLE_ADD_MENU`。 */
export function visibleAddMenu<T extends { id: string }>(
  items: readonly T[],
  simple: boolean = isSimpleMode(),
): T[] {
  return simple
    ? items.filter((item) => SIMPLE_ADD_MENU.includes(item.id))
    : [...items];
}
