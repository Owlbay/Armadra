/**
 * shadcn 生成的 `TabsContent` 可以拿到焦点（Radix 给它 tabIndex 0），但只写了
 * `outline-none`，键盘落到它上面时什么也看不见。生成文件不改，调用方把这串
 * 类加在 `TabsContent` 上：环画在内侧（`ring-inset`），外层是 `ScrollArea`
 * 或抽屉这种会裁边的容器时也不会被切掉。颜色与透明度同 `Button` 的焦点环。
 */
export const TABS_CONTENT_FOCUS =
  "rounded-[var(--r-control)] focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50";
