import { CloudOff } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { RealtimePresenceView } from "@/canvas/PresenceBar";
import { PeerCursor } from "@/realtime/CursorLayer";
import { Alert, AlertTitle } from "@/ui/alert";
import { memberColorVar } from "@/ui/member-dot";
import { CURSOR_PEERS, PEER_SETS } from "../fixtures/collab";

/**
 * `collab` 分区（设计展示页 §2.1，设计系统 §5.6）：实时板的在线条——头像
 * 堆叠 1 / 3 / 6 人、跟随中、只读、断开——成员光标与选区外框，以及「离线
 * 编辑」。评论（§5.7）与角色（§5.8）的样本由各自的实现包加在后面。
 */
const noop = () => undefined;
const BAR = "relative top-auto right-auto self-start";

export default function CollabSection() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        {PEER_SETS.map((peers) => (
          <RealtimePresenceView
            key={peers.length}
            peers={peers}
            offline={false}
            readOnly={false}
            following={null}
            onFollow={noop}
            className={BAR}
          />
        ))}
        <RealtimePresenceView
          peers={PEER_SETS[1]!}
          offline={false}
          readOnly={false}
          following={PEER_SETS[1]![0]!.clientId}
          onFollow={noop}
          className={BAR}
        />
        <RealtimePresenceView
          peers={PEER_SETS[0]!}
          offline={false}
          readOnly
          following={null}
          onFollow={noop}
          className={BAR}
        />
        <RealtimePresenceView
          peers={PEER_SETS[1]!}
          offline
          readOnly={false}
          following={null}
          onFollow={noop}
          className={BAR}
        />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div
          className="relative h-[180px] w-[360px] overflow-hidden rounded-[var(--r-card)] border border-border"
          style={{ background: "var(--canvas-bg)" }}
        >
          <div
            className="absolute rounded-[var(--r-card)] border border-border bg-card"
            style={{ left: 150, top: 60, width: 140, height: 80 }}
          />
          <div
            data-peer-selection
            className="absolute rounded-[var(--r-card)]"
            style={{
              left: 148,
              top: 58,
              width: 144,
              height: 84,
              border: `1.5px dashed ${memberColorVar(3)}`,
            }}
          />
          {CURSOR_PEERS.map((peer) => (
            <PeerCursor
              key={peer.clientId}
              color={memberColorVar(peer.state.color)}
              name={peer.state.name}
              x={peer.state.cursor!.x}
              y={peer.state.cursor!.y}
            />
          ))}
        </div>

        <Alert className="w-auto self-start">
          <CloudOff />
          <AlertTitle>{t("realtime.offline")}</AlertTitle>
        </Alert>
      </div>
    </div>
  );
}
