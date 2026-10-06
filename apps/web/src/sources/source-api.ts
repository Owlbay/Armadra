import { agentsApiFor } from "../api/agents";
import { boardsApiFor } from "../api/boards";
import { clientFor } from "../api/client";
import type { Source } from "../api/source";
import { terminalsApiFor } from "../api/terminals";
import { activeSource } from "./scope";

/**
 * 绑定到一个源的调用面（客户端包 §2）：按源记账的读数（依赖等待、会话列表、
 * 实时协同的复核）一律经 `clientFor(source)` 发往读数所属的那个源，而不是
 * `runtimeApi` 背后此刻的当前源——两者在事件派发与切源的那一瞬会不同，
 * 发错了就是把别的源的答案记进这个源的键里。
 *
 * 只收已经迁到契约上的域（agents、boards、terminals）；同一个源同一份。
 */
function build(source: Source) {
  const rpc = (override?: Source) => clientFor(override ?? source);
  return {
    ...agentsApiFor(rpc),
    ...boardsApiFor(rpc),
    ...terminalsApiFor(() => clientFor(source)),
  };
}

export type SourceApi = ReturnType<typeof build>;

const facades = new WeakMap<Source, SourceApi>();

/** 这个源的调用面；省略是此刻默认的源（事件派发中是事件所属的源）。 */
export function sourceApi(source: Source = activeSource()): SourceApi {
  let api = facades.get(source);
  if (api === undefined) {
    api = build(source);
    facades.set(source, api);
  }
  return api;
}
