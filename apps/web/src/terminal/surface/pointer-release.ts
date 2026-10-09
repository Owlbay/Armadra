/**
 * 终端里按下的鼠标键，松开时一定要让 xterm 知道（#227）。
 *
 * xterm 在 `mousedown` 时往 `document` 上挂 `mousemove` / `mouseup`：选区靠它
 * 们跟随指针、靠 `mouseup` 收尾；应用开了鼠标上报（tmux 内的 vim、TUI）时，
 * 松开键的那一帧上报也靠同一个 `mouseup`。它的 `mousemove` 不看 `buttons`，
 * 所以只要这一下 `mouseup` 没到 `document`，选区就一直跟着指针走，松开了也停
 * 不下来；上报模式下应用则一直以为键还按着。
 *
 * 丢 `mouseup` 是实测出来的：画布平移走的 d3-zoom 在 `window` 捕获相位接住
 * `mouseup` 并 `stopImmediatePropagation()`。手形工具下左键按在终端上、或任
 * 何时候中键按在终端上，按下那一下 xterm 与 d3-zoom 都收到了，松开那一下只
 * 有 d3-zoom 收到。窗口外松开、失焦、`pointercancel`、页面切到后台也是同一种
 * 「键松了，`document` 不知道」。
 *
 * 做法是只补不改：在终端体上记下按下了哪些键，`document` 上真的收到 `mouseup`
 * 就划掉；该收尾却没划掉的（`pointerup` 之后这一轮事件派发完了仍没到、
 * `mousemove` 的 `buttons` 里已经没有这个键、失焦、切后台、`pointercancel`），
 * 就在 `document` 上补派一个 `mouseup`。xterm 照它自己的逻辑收尾——选区停在
 * 松开处，上报模式下应用收到松开——别的行为一概不动：节点内的正常拖选、
 * 画布平移、应用自己的鼠标模式都还是原来那条路。
 */

/** `MouseEvent.button` → `MouseEvent.buttons` 里对应的那一位。 */
function bitOf(button: number): number {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 4;
    case 2:
      return 2;
    default:
      return button >= 0 && button < 5 ? 1 << button : 0;
  }
}

/** `buttons` 的某一位 → `button` 编号（`bitOf` 的逆）。 */
function buttonOf(bit: number): number {
  if (bit === 1) return 0;
  if (bit === 4) return 1;
  if (bit === 2) return 2;
  return Math.log2(bit);
}

/**
 * 给终端体装上「松开必达」的守卫，返回卸载函数。`body` 是 xterm 元素的祖先
 * （`[data-slot="terminal-body"]`）：它的捕获相位比 xterm 自己的 `mousedown`
 * 更早。
 */
export function guardPointerRelease(body: HTMLElement): () => void {
  const doc = body.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => undefined;

  /** 按在终端里、`document` 还没收到松开的键（`buttons` 位）。 */
  let pending = 0;
  let last = { clientX: 0, clientY: 0 };
  let check: ReturnType<typeof setTimeout> | null = null;
  let listening = false;

  const remember = (event: MouseEvent) => {
    last = { clientX: event.clientX, clientY: event.clientY };
  };

  /** 在 `document` 上补派一个松开；xterm 的监听器挂在那里。 */
  const release = (bits: number) => {
    for (const bit of [1, 4, 2, 8, 16]) {
      if (!(bits & bit) || !(pending & bit)) continue;
      pending &= ~bit;
      doc.dispatchEvent(
        new win.MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          button: buttonOf(bit),
          buttons: pending,
          clientX: last.clientX,
          clientY: last.clientY,
        }),
      );
    }
    if (pending === 0) stop();
  };

  const releaseAll = () => release(pending);

  /** `document` 真的收到了：xterm 也收到了，划掉。 */
  const onDocumentUp = (event: MouseEvent) => {
    pending &= ~bitOf(event.button);
    if (pending === 0) stop();
  };

  /**
   * `pointerup` / `mouseup` 在捕获相位先到这里。同一轮输入里浏览器接着派
   * `mouseup`；等这一轮派发完（下一个宏任务）还没划掉，就是被半路吞了。
   */
  const onReleaseSeen = (event: MouseEvent) => {
    remember(event);
    if (check) return;
    check = setTimeout(() => {
      check = null;
      if (pending !== 0) {
        // `pointerup` 只在最后一个键松开时来；这时 `buttons` 是松开之后的状态。
        release(pending & ~event.buttons);
      }
    }, 0);
  };

  /** 键早就不在 `buttons` 里了：补上松开，这一下移动就不会再扩选区。 */
  const onMove = (event: MouseEvent) => {
    remember(event);
    if (typeof event.buttons !== "number") return;
    const lost = pending & ~event.buttons;
    if (lost) release(lost);
  };

  const onVisibility = () => {
    if (doc.visibilityState === "hidden") releaseAll();
  };

  const start = () => {
    if (listening) return;
    listening = true;
    doc.addEventListener("mouseup", onDocumentUp);
    win.addEventListener("pointerup", onReleaseSeen, true);
    win.addEventListener("mouseup", onReleaseSeen, true);
    win.addEventListener("mousemove", onMove, true);
    win.addEventListener("pointercancel", releaseAll, true);
    win.addEventListener("blur", releaseAll);
    doc.addEventListener("visibilitychange", onVisibility);
  };

  function stop() {
    if (check) clearTimeout(check);
    check = null;
    if (!listening) return;
    listening = false;
    doc.removeEventListener("mouseup", onDocumentUp);
    win?.removeEventListener("pointerup", onReleaseSeen, true);
    win?.removeEventListener("mouseup", onReleaseSeen, true);
    win?.removeEventListener("mousemove", onMove, true);
    win?.removeEventListener("pointercancel", releaseAll, true);
    win?.removeEventListener("blur", releaseAll);
    doc.removeEventListener("visibilitychange", onVisibility);
  }

  const onDown = (event: MouseEvent) => {
    const bit = bitOf(event.button);
    if (!bit) return;
    remember(event);
    pending |= bit;
    start();
  };
  body.addEventListener("mousedown", onDown, true);

  return () => {
    body.removeEventListener("mousedown", onDown, true);
    pending = 0;
    stop();
  };
}
