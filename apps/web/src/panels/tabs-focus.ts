/**
 * shadcn 生成的 `TabsContent` 可以拿到焦点（Radix 给它 tabIndex 0），但只写了
 * `outline-none`，键盘落到它上面时什么也看不见。生成文件不改，调用方把这串
 * 类加在 `TabsContent` 上：环画在内侧（`ring-inset`），外层是 `ScrollArea`
 * 或抽屉这种会裁边的容器时也不会被切掉。颜色与透明度同 `Button` 的焦点环。
 */
export const TABS_CONTENT_FOCUS =
  "rounded-[var(--r-control)] focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50";

/**
 * 同一类问题：生成的 `CommandInput` 把输入框放进透明的 `InputGroup`，自己只写
 * `outline-hidden`，`InputGroup` 的焦点环认的是 `input-group-control` 这个
 * slot，于是命令面板、快速打开、侧栏搜索、时区选择的输入框聚焦时什么也
 * 看不见。生成文件不改，调用方把这串类加在 `CommandInput` 上（传给的就是
 * 里面那个 input）。
 */
export const COMMAND_INPUT_FOCUS =
  "rounded-[var(--r-control)] px-1 focus-visible:ring-3 focus-visible:ring-ring/50";
