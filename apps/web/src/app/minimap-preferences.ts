import { create } from "zustand";

import { isCompactLayout } from "../platform/layout";

const STORAGE_KEY = "armadra.minimapCollapsed";
/** 没存过偏好时，手机宽度默认收起：展开的缩略图要占掉约三分之一屏。 */
function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? isCompactLayout() : stored === "true";
  } catch {
    return isCompactLayout();
  }
}

/** Shared by the minimap and shell so the usage orb follows the collapsed edge. */
export const useMinimapPreferences = create<{
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}>((set) => ({
  collapsed: readCollapsed(),
  setCollapsed: (collapsed) => {
    set({ collapsed });
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      /* Optional persistence. */
    }
  },
}));
