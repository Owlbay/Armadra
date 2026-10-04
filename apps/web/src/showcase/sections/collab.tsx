import { CloudOff } from "lucide-react";

import { PermissionCard } from "@/acp/PermissionCard";
import { useT } from "@/app/preferences-store";
import { RealtimePresenceView } from "@/canvas/PresenceBar";
import { FollowFrame, PeerCursor } from "@/realtime/CursorLayer";
import { Alert, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { MemberDot, memberColorVar } from "@/ui/member-dot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/ui/table";
import { CommentComposer } from "@/realtime/comments/CommentComposer";
import { CommentPin } from "@/realtime/comments/CommentPin";
import { CommentThread } from "@/realtime/comments/CommentThread";
import { CommentsPanelView } from "@/realtime/comments/CommentsPanel";
import type { CommentThreadData } from "@/realtime/comments/store";
import {
  COMMENT_NOW,
  COMMENT_PEOPLE,
  COMMENT_REPLY,
  COMMENT_RESOLVED,
  COMMENT_ROOT,
  COMMENT_SELF,
  CURSOR_PEERS,
  PEER_SETS,
  ROLE_MEMBERS,
} from "../fixtures/collab";
import { ACP_PERMISSION } from "../fixtures/acp";

/**
 * `collab` 分区（设计展示页 §2.1，设计系统 §5.6）：实时板的在线条——头像
 * 堆叠 1 / 3 / 6 人、跟随中、只读、断开——成员光标与选区外框、跟随视口
 * （画布四周一圈对方的成员色），以及「离线编辑」；评论（§5.7）：钉的四种样子、线程（可写 / 只读 / 离线）、输入框与
 * 评论抽屉（空态、有已解决的折叠区）；角色（§5.8，契约 §23）：成员表（可改 /
 * 只读）与审批卡的三种看法——driver 答谁的都行、operator 答自己起的、operator
 * 看别人起的只有「等待接管」。
 */
const noop = () => undefined;

const OPEN_THREAD: CommentThreadData = {
  root: COMMENT_ROOT,
  replies: [COMMENT_REPLY],
};
const RESOLVED_THREAD: CommentThreadData = {
  root: COMMENT_RESOLVED,
  replies: [],
};

function SampleThread({
  thread,
  canWrite = true,
  offline = false,
  compact = false,
}: {
  thread: CommentThreadData;
  canWrite?: boolean;
  offline?: boolean;
  compact?: boolean;
}) {
  return (
    <CommentThread
      thread={thread}
      people={COMMENT_PEOPLE}
      selfId={COMMENT_SELF}
      canWrite={canWrite}
      isOwner
      offline={offline}
      compact={compact}
      now={COMMENT_NOW}
      onReply={noop}
      onResolve={noop}
      onEdit={noop}
      onDelete={noop}
    />
  );
}

const FRAME =
  "w-[320px] rounded-[var(--r-card)] border border-border bg-popover p-3";

const ROLES = ["viewer", "editor", "operator", "driver"] as const;

/** 成员表：头像 名字 · 角色 · 移除；`editable` 为假时角色列只读。 */
function RoleTable({ editable }: { editable: boolean }) {
  const t = useT();
  return (
    <Table>
      <TableBody>
        {ROLE_MEMBERS.map((member) => (
          <TableRow key={member.name}>
            <TableCell>
              <span className="flex items-center gap-2">
                <MemberDot index={member.color} name={member.name} />
                {member.name}
              </span>
            </TableCell>
            <TableCell>
              {editable ? (
                <Select value={member.role}>
                  <SelectTrigger
                    size="sm"
                    className="w-[112px]"
                    aria-label={t("sharing.role")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {t(`sharing.role.${role}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="outline">
                  {t(`sharing.role.${member.role}`)}
                </Badge>
              )}
            </TableCell>
            {editable && (
              <TableCell className="text-right">
                <Button size="sm" variant="ghost" className="text-destructive">
                  {t("sharing.share.remove")}
                </Button>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
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

        <div
          data-sample="follow-viewport"
          className="relative h-[180px] w-[360px] overflow-hidden rounded-[var(--r-card)] border border-border"
          style={{ background: "var(--canvas-bg)" }}
        >
          <div
            className="absolute rounded-[var(--r-card)] border border-border bg-card"
            style={{ left: 110, top: 50, width: 140, height: 80 }}
          />
          <RealtimePresenceView
            peers={PEER_SETS[1]!}
            offline={false}
            readOnly={false}
            following={PEER_SETS[1]![0]!.clientId}
            onFollow={noop}
            className="absolute top-2 right-2"
          />
          <FollowFrame color={memberColorVar(PEER_SETS[1]![0]!.state.color)} />
        </div>

        <Alert className="w-auto self-start">
          <CloudOff />
          <AlertTitle>{t("realtime.offline")}</AlertTitle>
        </Alert>
      </div>

      <div data-sample="comment-pins" className="flex items-center gap-4">
        <CommentPin
          count={3}
          open
          color={2}
          label={t("comments.pin", { count: 3 })}
        />
        <CommentPin
          count={1}
          open
          color={4}
          label={t("comments.pin", { count: 1 })}
        />
        <CommentPin
          count={2}
          open={false}
          color={2}
          label={t("comments.pin", { count: 2 })}
        />
        <CommentPin
          count={3}
          open
          dot
          color={2}
          label={t("comments.pin", { count: 3 })}
        />
        <CommentPin
          count={2}
          open={false}
          dot
          color={2}
          label={t("comments.pin", { count: 2 })}
        />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div data-sample="comment-thread" className={FRAME}>
          <SampleThread thread={OPEN_THREAD} />
        </div>
        <div data-sample="comment-thread-readonly" className={FRAME}>
          <SampleThread thread={OPEN_THREAD} canWrite={false} />
        </div>
        <div data-sample="comment-thread-offline" className={FRAME}>
          <SampleThread thread={OPEN_THREAD} offline />
        </div>
        <div data-sample="comment-composer" className={FRAME}>
          <CommentComposer
            people={COMMENT_PEOPLE}
            placeholder={t("comments.placeholder")}
            onSubmit={noop}
            onCancel={noop}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        {[[], [OPEN_THREAD, RESOLVED_THREAD]].map((threads) => (
          <div
            key={threads.length}
            data-sample={
              threads.length === 0 ? "comments-panel-empty" : "comments-panel"
            }
            className="flex h-[440px] w-[360px] flex-col rounded-[var(--r-card)] border border-border bg-popover pt-4"
          >
            <p className="px-4 pb-2 text-base font-medium text-foreground">
              {t("comments.title")}
            </p>
            <CommentsPanelView
              threads={threads}
              onlyOpen={false}
              onOnlyOpenChange={noop}
              renderThread={(thread, { compact }) => (
                <SampleThread thread={thread} compact={compact} />
              )}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div data-sample="roles-members" className="w-[400px]">
          <RoleTable editable />
        </div>
        <div data-sample="roles-members-readonly" className="w-[320px]">
          <RoleTable editable={false} />
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <div data-sample="roles-approval-driver" className="w-[320px]">
          <PermissionCard permission={ACP_PERMISSION} canAnswer />
        </div>
        <div data-sample="roles-approval-own" className="w-[320px]">
          <PermissionCard
            permission={{ ...ACP_PERMISSION, pendingId: "p-own" }}
            canAnswer
          />
        </div>
        <div data-sample="roles-approval-others" className="w-[320px]">
          <PermissionCard
            permission={{ ...ACP_PERMISSION, pendingId: "p-others" }}
            canAnswer={false}
          />
        </div>
      </div>
    </div>
  );
}
