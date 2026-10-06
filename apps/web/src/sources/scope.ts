/**
 * 源维度的键（客户端包 §2）：查询键与 store 键都带上 `sourceId`，
 * 两个源里恰好同名的工作空间 / 节点 / 会话 id 不会互相覆盖。
 *
 * - 查询键：`["src", sourceId, ...]`（{@link srcKey}）。
 * - store 键：`${sourceId}:${id}`（{@link scoped}）。
 *
 * 省略 `sourceId` 就是「此刻的那个源」：事件派发时是产生事件的那条连接
 * 所属的源（{@link withSource}），其它时候是当前源。零配置只有本机源，
 * 此时一切行为与加源之前相同。
 */
import { currentSource, LOCAL_SOURCE_ID } from "../api/source";

let ambient: string | null = null;

/** 此刻默认的源：事件派发中是事件所属的源，否则是当前源。 */
export function activeSourceId(): string {
  return ambient ?? currentSource().sourceId ?? LOCAL_SOURCE_ID;
}

/** 在 `sourceId` 的上下文里同步执行 `run`（事件派发用）。 */
export function withSource<T>(sourceId: string, run: () => T): T {
  const previous = ambient;
  ambient = sourceId;
  try {
    return run();
  } finally {
    ambient = previous;
  }
}

/** store 键：`${sourceId}:${id}`。 */
export function scoped(
  id: string,
  sourceId: string = activeSourceId(),
): string {
  return `${sourceId}:${id}`;
}

/** 把 {@link scoped} 的键拆回来；不带源前缀时按本机源。 */
export function unscoped(key: string): { sourceId: string; id: string } {
  const at = key.indexOf(":");
  if (at < 0) return { sourceId: LOCAL_SOURCE_ID, id: key };
  return { sourceId: key.slice(0, at), id: key.slice(at + 1) };
}

/** 查询键：`["src", sourceId, ...rest]`。 */
export function srcKey(
  sourceId: string,
  ...rest: readonly unknown[]
): readonly unknown[] {
  return ["src", sourceId, ...rest];
}

/** 当前源下的查询键。 */
export function sk(...rest: readonly unknown[]): readonly unknown[] {
  return srcKey(activeSourceId(), ...rest);
}

/** 查询键的前缀 `["src", sourceId]`，给手写数组展开用。 */
export function srcPrefix(): readonly ["src", string] {
  return ["src", activeSourceId()];
}
