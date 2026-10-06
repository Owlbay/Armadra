/**
 * 在线订阅 `boards.presence`（契约 §36.4）。
 *
 * 一个客户端在一块画布上的一条订阅，走所在源的控制面 `/api/ws`：订上就是登记，
 * 连着就是续期（core 替页面续），取消或断线就是离开；每一项是这个客户端看到的
 * 在线表。断线后由门面的重试插件重订（`api/client.ts`），重订就是一次新的登记。
 * 被拒（授权收回、没有这块板）或控制面停下时订阅结束，由 `onEnd` 交给调用方：
 * 页面改用 `presenceHeartbeat` 兜底。
 */
import { boardPresenceSchema, type BoardPresence } from "@armadra/shared";

import { controlClient } from "./client";
import { connectionOf } from "./events";
import { type Source, currentSource } from "./source";

export interface BoardPresenceWatch {
  readonly workspaceId: string;
  readonly boardId: string;
  readonly clientId: string;
  readonly deviceName: string;
  /** 订阅发往哪个源；缺省当前源。 */
  readonly source?: Source;
  /** 每一项在线表；第一项到了就是「订上了」。 */
  onPresence(presence: BoardPresence): void;
  /** 订阅结束了（被拒、控制面停下），不是被取消。 */
  onEnd(error: unknown): void;
}

/** 开一条订阅；返回取消函数（取消时 core 把这个客户端摘掉）。 */
export function watchBoardPresence(watch: BoardPresenceWatch): () => void {
  const source = watch.source ?? currentSource();
  const abort = new AbortController();
  void (async () => {
    try {
      const items = await controlClient(connectionOf(source)).boards.presence(
        {
          workspaceId: watch.workspaceId,
          boardId: watch.boardId,
          clientId: watch.clientId,
          deviceName: watch.deviceName,
        },
        { signal: abort.signal },
      );
      for await (const item of items) {
        if (abort.signal.aborted) return;
        const parsed = boardPresenceSchema.safeParse(item);
        if (parsed.success) watch.onPresence(parsed.data);
      }
      if (!abort.signal.aborted) watch.onEnd(undefined);
    } catch (error) {
      if (!abort.signal.aborted) watch.onEnd(error);
    }
  })();
  return () => abort.abort();
}
