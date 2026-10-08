import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import {
  DEFAULT_LAYOUT_DIRECTION,
  completionSettingsSchema,
  type LayoutDirection,
} from "@armadra/shared";

import { useAccess } from "@/app/use-access";
import { settingsGateway } from "@/settings";
import { runCanvasCommand } from "./commands";

/**
 * 画布的布局方向（契约 §50 `canvas.layoutDirection`，ui-wave2 §4.2）。
 *
 * 设置在主机上（core 的放置也读它）。页面侧由画布挂一次
 * {@link useLayoutDirectionSync} 把设置推进这个小 store，派发线、整理与「派生」
 * 都从这里读——每条边各开一个设置查询不划算，非组件代码（命令、菜单规格）也
 * 拿不到查询。还没读到设置时按缺省纵向。
 */
interface LayoutDirectionState {
  setting: LayoutDirection;
  /** Dock「纵向整理 / 横向整理」的一次性覆盖；只在那一次整理里有效。 */
  override: LayoutDirection | null;
}

const useLayoutDirectionStore = create<LayoutDirectionState>(() => ({
  setting: DEFAULT_LAYOUT_DIRECTION,
  override: null,
}));

/** 设置文档里的 `canvas.layoutDirection`；读不出就是缺省。 */
export function layoutDirectionOf(settings: unknown): LayoutDirection {
  return completionSettingsSchema.parse(
    settings && typeof settings === "object" ? settings : {},
  ).canvas.layoutDirection;
}

/** 当前生效的方向（覆盖优先）。 */
export function layoutDirection(): LayoutDirection {
  const { setting, override } = useLayoutDirectionStore.getState();
  return override ?? setting;
}

/** 组件里读方向：设置变了，派发线跟着换走向。 */
export function useLayoutDirection(): LayoutDirection {
  return useLayoutDirectionStore((state) => state.setting);
}

/**
 * 画布挂一次：读设置并推进 store。与设置页共用 `["settings"]` 查询（同一个
 * 键、同一个 `queryFn`），存完设置画布立刻跟着变。共享画布的成员读不了主机
 * 设置（`settings.get` 答 403），不发这次请求，按缺省纵向。
 */
export function useLayoutDirectionSync(): void {
  const { member } = useAccess();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => settingsGateway.load(),
    retry: false,
    enabled: !member,
  });
  const value = settings.data ? layoutDirectionOf(settings.data) : null;
  React.useEffect(() => {
    if (value) useLayoutDirectionStore.setState({ setting: value });
  }, [value]);
}

/**
 * 按指定方向整理一次，不写设置（Dock 整理钮的右键菜单）。整理命令同步执行，
 * 覆盖在它返回后立即撤掉。
 */
export function tidyInDirection(direction: LayoutDirection): void {
  useLayoutDirectionStore.setState({ override: direction });
  try {
    runCanvasCommand("canvas.tidy");
  } finally {
    useLayoutDirectionStore.setState({ override: null });
  }
}

/** 仅测试用。 */
export function setLayoutDirectionForTest(value: LayoutDirection): void {
  useLayoutDirectionStore.setState({ setting: value, override: null });
}
