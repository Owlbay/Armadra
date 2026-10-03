import * as React from "react";
import { Check, MoreHorizontal, RotateCcw } from "lucide-react";
import type { BoardComment, CommentPerson } from "@armadra/shared";

import { useT } from "@/app/preferences-store";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { memberColorVar } from "@/ui/member-dot";
import { CommentComposer } from "./CommentComposer";
import { bodyParts, type CommentThreadData } from "./store";

/**
 * 一条评论线程（设计系统 §5.7）：头像 名字 · 时间、解决；正文；回复缩进一层；
 * 底部回复框。纯展示：数据与动作由调用方给（`CommentLayer` 与展示页）。
 *
 *   * 无写权限：回复框、解决、编辑、删除都不画。
 *   * 改正文只给作者；删除给作者与 owner（与 core 的判定一致，契约 §16.3）。
 *   * 离线：发送禁用，草稿留着。
 */
export interface CommentThreadProps {
  thread: CommentThreadData;
  people: readonly CommentPerson[];
  selfId: string;
  canWrite: boolean;
  isOwner: boolean;
  offline?: boolean;
  now?: number;
  /** 折叠：只画顶层评论，不画回复与回复框（已解决的线程）。 */
  compact?: boolean;
  onReply: (parentId: string, body: string) => Promise<unknown> | void;
  onResolve: (id: string, resolved: boolean) => void;
  onEdit: (id: string, body: string) => Promise<unknown> | void;
  onDelete: (id: string) => void;
}

/** 作者的成员色序号：在可提及的人里的位置，从 2 起（1 留给自己）。 */
export function authorColor(
  people: readonly CommentPerson[],
  principalId: string,
  selfId: string,
): number {
  if (principalId === selfId) return 1;
  const index = people.findIndex(
    (person) => person.principalId === principalId,
  );
  return index < 0 ? 2 : (index % 7) + 2;
}

export function CommentThread({
  thread,
  people,
  selfId,
  canWrite,
  isOwner,
  offline = false,
  now,
  compact = false,
  onReply,
  onResolve,
  onEdit,
  onDelete,
}: CommentThreadProps) {
  const t = useT();
  const resolved = thread.root.resolvedAtMs !== null;
  return (
    <div
      data-slot="comment-thread"
      data-resolved={resolved ? "true" : undefined}
      className="flex flex-col gap-3"
    >
      <CommentEntry
        comment={thread.root}
        people={people}
        selfId={selfId}
        canWrite={canWrite}
        isOwner={isOwner}
        offline={offline}
        now={now}
        onEdit={onEdit}
        onDelete={onDelete}
        action={
          canWrite ? (
            resolved ? (
              <IconButton
                label={t("comments.reopen")}
                disabled={offline}
                onClick={() => onResolve(thread.root.id, false)}
              >
                <RotateCcw />
              </IconButton>
            ) : (
              <IconButton
                label={t("comments.resolve")}
                disabled={offline}
                onClick={() => onResolve(thread.root.id, true)}
              >
                <Check />
              </IconButton>
            )
          ) : null
        }
      />
      {!compact &&
        thread.replies.map((reply) => (
          <div key={reply.id} className="border-l border-border pl-3">
            <CommentEntry
              comment={reply}
              people={people}
              selfId={selfId}
              canWrite={canWrite}
              isOwner={isOwner}
              offline={offline}
              now={now}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </div>
        ))}
      {!compact && canWrite && !resolved && (
        <CommentComposer
          people={people}
          placeholder={t("comments.replyPlaceholder")}
          disabled={offline}
          onSubmit={(body) => onReply(thread.root.id, body)}
        />
      )}
    </div>
  );
}

function CommentEntry({
  comment,
  people,
  selfId,
  canWrite,
  isOwner,
  offline,
  now,
  action,
  onEdit,
  onDelete,
}: {
  comment: BoardComment;
  people: readonly CommentPerson[];
  selfId: string;
  canWrite: boolean;
  isOwner: boolean;
  offline: boolean;
  now?: number;
  action?: React.ReactNode;
  onEdit: CommentThreadProps["onEdit"];
  onDelete: CommentThreadProps["onDelete"];
}) {
  const t = useT();
  const [editing, setEditing] = React.useState(false);
  const mine = comment.authorPrincipalId === selfId;
  const name = mine
    ? t("comments.you")
    : (people.find((person) => person.principalId === comment.authorPrincipalId)
        ?.name ?? t("comments.someone"));
  const color = memberColorVar(
    authorColor(people, comment.authorPrincipalId, selfId),
  );
  const canEdit = canWrite && mine;
  const canDelete = canWrite && (mine || isOwner);

  return (
    <div data-slot="comment" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Avatar
          size="sm"
          className="size-5"
          style={{ boxShadow: `0 0 0 2px ${color}` }}
        >
          <AvatarFallback className="text-[length:var(--text-caption)]">
            {[...name][0] ?? "?"}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-[length:var(--text-caption)] text-muted-foreground">
          {formatRelativeTime(comment.createdAtMs, now)}
        </span>
        <div className="ml-auto flex items-center">
          {action}
          {(canEdit || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t("comments.actions")} disabled={offline}>
                  <MoreHorizontal />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem onSelect={() => setEditing(true)}>
                    {t("comments.edit")}
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onDelete(comment.id)}
                  >
                    {t("comments.delete")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {editing ? (
        <CommentComposer
          people={people}
          initial={comment.body}
          placeholder={t("comments.placeholder")}
          submitLabel={t("comments.save")}
          disabled={offline}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            await onEdit(comment.id, body);
            setEditing(false);
          }}
        />
      ) : (
        <CommentBody body={comment.body} />
      )}
    </div>
  );
}

/** 正文：纯文本保留换行，提及画成 `@名字`。 */
export function CommentBody({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-sm break-words whitespace-pre-wrap text-foreground",
        className,
      )}
    >
      {bodyParts(body).map((part, index) =>
        part.kind === "text" ? (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        ) : (
          <span
            key={index}
            data-mention={part.id}
            className="font-medium text-[var(--brand-text)]"
          >
            @{part.name}
          </span>
        ),
      )}
    </p>
  );
}
