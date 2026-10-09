/**
 * 「这个节点现在看得见吗」——采样节奏的依据（路线图 §4.3）。
 *
 * 三件事都算看不见，因为三件事都意味着没人在看这个数字：
 *
 *  1. 节点折叠或已退出（调用方给的 `mounted`）；
 *  2. 元素滚出了视口——画布不裁剪节点（`canCull() => false`，见
 *     `ArmadraShapeUtil`），所以离屏的节点仍然挂在 DOM 上，只有
 *     `IntersectionObserver` 能说出它其实在屏幕外；
 *  3. 整个窗口切到后台。
 *
 * 拿不到 `IntersectionObserver` 的环境（jsdom、很旧的浏览器）按**看得见**
 * 处理：宁可多采几次，也不要让一个用户正盯着的徽标停在 30 秒前的数字上。
 */
import { useEffect, useState, type RefObject } from "react";

/**
 * `enabled` 是调用方告诉我们「元素这一帧挂上了没有」。effect 只在依赖变化时重
 * 跑，`ref.current` 本身变了不会叫醒它：一个首帧 `return null`、之后才渲染出元
 * 素的组件（内存徽标等会话 id 到了才画），只依赖 `[ref]` 的话观察器永远挂不上，
 * 离屏降速也就从未生效（性能核实 §1.1）。所以元素出现的那次提交要把 `enabled`
 * 翻成真，effect 随之重跑。`enabled` 为假时按看得见处理，与拿不到
 * `IntersectionObserver` 同一条规矩。
 */
export function useOnScreen(
  ref: RefObject<Element | null>,
  enabled = true,
): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setOnScreen(last.isIntersecting);
      },
      // 一点点露出来就算看得见：半个终端头部也是在看。
      { threshold: 0 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      // 下一次挂上之前不沿用旧读数：观察器的第一条回调会给出真值。
      setOnScreen(true);
    };
  }, [ref, enabled]);
  return enabled ? onScreen : true;
}

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
