/**
 * Agent 启动时序（计划书 §5.1：启动行是被"敲进 shell"的，不是 exec）。
 *
 * `hello` 之后武装启动器，然后：
 *  - 每收到一段输出就把定时器重置为 QUIET_MS —— 提示符打完就会安静下来；
 *  - 一直没有输出（提示符为空、或 tmux 重绘早于 attach）则在 COLD_MS 时兜底发出；
 *  - `stdinPrompt`（opencode 这类 promptMode=stdin-after-start）再等 PROMPT_MS
 *    发第二次，给 TUI 起来的时间。
 * 整个过程只发生一次，由 `launchPhase` 保证。
 */
export const LAUNCH_QUIET_MS = 400;
export const LAUNCH_COLD_MS = 3_000;
export const LAUNCH_PROMPT_MS = 600;

/**
 * 启动闸门与失败重试（契约 §52、界面第二波 §8.3）。
 *
 *  - 敲启动行前向 core 申请位置，最多等 SLOT_WAIT_MS（core 自己 30 s 就答）；
 *  - 敲完问结果，失败就在 RETRY_MIN–RETRY_MAX 之间随机退避后再敲一次；
 *  - 第二次仍失败：节点头显示「启动失败」与重试按钮，不再自动重敲。
 */
export const LAUNCH_SLOT_WAIT_MS = 32_000;
export const LAUNCH_RESULT_WAIT_MS = 35_000;
export const LAUNCH_RETRY_MIN_MS = 2_000;
export const LAUNCH_RETRY_MAX_MS = 5_000;
/** 自动重试之后的总次数。 */
export const LAUNCH_ATTEMPTS = 2;

/** 尺寸去抖（§15.7 / §18.2 规则 2）。 */
export const RESIZE_DEBOUNCE_MS = 80;

/** 折叠后延迟 detach，避免"折叠一下又展开"来回重连（§15.7）。 */
export const DETACH_GRACE_MS = 5_000;

export const TERMINAL_SCROLLBACK = 5_000;

/** 铃声闪一下头部图标的时长（§18.3 铃声行）。 */
export const BELL_FLASH_MS = 600;
