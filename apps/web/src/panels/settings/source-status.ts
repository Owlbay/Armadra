import type { StatusTone } from "@/ui/status-pill";

/** 源的连接状态 → 胶囊（`sources/types.ts` 的 `SourceStatus.state`）。 */
export function sourcePill(state: string): { tone: StatusTone; key: string } {
  switch (state) {
    case "ready":
      return { tone: "done", key: "remote.status.ready" };
    case "connecting":
      return { tone: "working", key: "remote.status.connecting" };
    case "offline":
      return { tone: "failed", key: "remote.status.offline" };
    case "unauthorized":
      return { tone: "attention", key: "remote.status.unauthorized" };
    case "waitingForSource":
      return { tone: "queued", key: "remote.status.waitingForSource" };
    default:
      return { tone: "idle", key: "remote.status.idle" };
  }
}
