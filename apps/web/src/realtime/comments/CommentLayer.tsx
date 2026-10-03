import * as React from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import type { BoardComment, CanvasNode, CommentAnchor } from "@armadra/shared";

import { useAccess } from "@/app/use-access";
import { useT } from "@/app/preferences-store";
import { nodeBox } from "@/canvas/geometry";
import type { Item } from "@/canvas/whiteboard/model";
import { useCanvasStore } from "@/store/canvas-store";
import { IconButton } from "@/ui/icon-button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/ui/popover";
import { ScrollArea } from "@/ui/scroll-area";
import { Separator } from "@/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useRealtimeStore } from "../session";
import { CommentComposer } from "./CommentComposer";
import { CommentPin } from "./CommentPin";
import { CommentThread, authorColor } from "./CommentThread";
import { CommentsPanelView } from "./CommentsPanel";
import {
  anchorKey,
  commentsApi,
  followBoard,
  mutateComments,
  openPin,
  setCommentMode,
  setOnlyOpen,
  startDraft,
  threadsOf,
  useCommentsStore,
  type CommentThreadData,
} from "./store";

/**
 * 画布上的评论层（补全架构 §6.3–§6.4，设计系统 §4、§5.7）。
 *
 * 挂在 React Flow 的 `<ViewportPortal>` 里：钉的坐标是画布坐标（节点与白板
 * 对象的右上角、或者点下去的那个点），相机变换由它做，钉按 `1 / zoom` 反缩放
 * ——与光标层（`CursorLayer`）同一个做法，节点框也用同一个 `nodeBox`。
 *
 * 评论模式（Dock 的「评论」）：点画布放钉——点在节点上锚节点、点在白板对象上
 * 锚对象、点在空白处锚坐标；右侧开评论抽屉。模式外钉照样画，点开看线程。
 */
export function CommentLayer() {
  const workspaceId = useCanvasStore((state) => state.workspace?.id ?? null);
  const boardId = useCanvasStore((state) => state.boardId);
  React.useEffect(
    () => followBoard(workspaceId, boardId),
    [workspaceId, boardId],
  );
  if (workspaceId === null || boardId === null) return null;
  return <Comments workspaceId={workspaceId} boardId={boardId} />;
}

/** 锚点在画布上的位置；锚的节点或对象已经不在了就是 `null`。 */
export function anchorPosition(
  anchor: CommentAnchor,
  nodes: readonly CanvasNode[],
  items: readonly Item[],
): { x: number; y: number } | null {
  if (anchor.kind === "point") return { x: anchor.x, y: anchor.y };
  if (anchor.kind === "node") {
    const node = nodes.find((one) => one.id === anchor.id);
    if (!node) return null;
    const box = nodeBox(nodes, node);
    return { x: box.x + box.width, y: box.y };
  }
  const item = items.find((one) => one.id === anchor.id);
  return item ? { x: item.x + item.w, y: item.y } : null;
}

/** 评论模式下点在哪：最上面的节点、否则最上面的白板对象、否则这个点。 */
export function anchorAt(
  point: { x: number; y: number },
  nodes: readonly CanvasNode[],
  items: readonly Item[],
): CommentAnchor {
  const inside = (x: number, y: number, w: number, h: number) =>
    point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]!;
    if (node.type === "group") continue;
    const box = nodeBox(nodes, node);
    if (inside(box.x, box.y, box.width, box.height)) {
      return { kind: "node", id: node.id };
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (inside(item.x, item.y, item.w, item.h)) {
      return { kind: "item", id: item.id };
    }
  }
  return { kind: "point", x: Math.round(point.x), y: Math.round(point.y) };
}

interface PinGroup {
  key: string;
  anchor: CommentAnchor;
  threads: CommentThreadData[];
  count: number;
  open: boolean;
  firstAuthor: string;
}

/** 同一个锚点上的线程聚成一枚钉。 */
export function pinGroups(comments: readonly BoardComment[]): PinGroup[] {
  const groups = new Map<string, PinGroup>();
  for (const thread of threadsOf(comments)) {
    const key = anchorKey(thread.root.anchor);
    const group = groups.get(key) ?? {
      key,
      anchor: thread.root.anchor,
      threads: [],
      count: 0,
      open: false,
      firstAuthor: thread.root.authorPrincipalId,
    };
    group.threads.push(thread);
    group.count += 1 + thread.replies.length;
    group.open ||= thread.root.resolvedAtMs === null;
    groups.set(key, group);
  }
  return [...groups.values()];
}

const NO_NODES: CanvasNode[] = [];

function Comments({
  workspaceId,
  boardId,
}: {
  workspaceId: string;
  boardId: string;
}) {
  const t = useT();
  const flow = useReactFlow();
  const access = useAccess();
  const comments = useCommentsStore((state) => state.comments);
  const people = useCommentsStore((state) => state.people);
  const mode = useCommentsStore((state) => state.mode);
  const onlyOpen = useCommentsStore((state) => state.onlyOpen);
  const pinKey = useCommentsStore((state) => state.openPin);
  const draft = useCommentsStore((state) => state.draft);
  const offline = useRealtimeStore((view) => view.status === "offline");
  const nodes = useCanvasStore((state) => state.document?.nodes ?? NO_NODES);
  const items = useCanvasStore((state) => state.whiteboard.items);
  const zoom = useStore((state) => state.transform[2]);
  const domNode = useStore((state) => state.domNode);

  const canWrite = access.can("canvas:write", workspaceId);
  const isOwner = !access.member;
  const selfId = access.session?.device.principalId ?? "";
  const scale = zoom > 0 ? 1 / zoom : 1;

  // 换板时退出评论模式：草稿与打开的钉都属于上一块板。
  React.useEffect(() => () => setCommentMode(false), [boardId]);

  // 评论模式：点画布放钉。捕获阶段先于 React Flow 的选择与拖动拿到按下。
  React.useEffect(() => {
    if (!mode || !domNode) return;
    const target = domNode;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const element = event.target as Element | null;
      if (element?.closest("[data-comment-pin], [data-comment-draft]")) return;
      event.preventDefault();
      event.stopPropagation();
      if (!canWrite) return;
      const point = flow.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const state = useCanvasStore.getState();
      startDraft(
        anchorAt(point, state.document?.nodes ?? [], state.whiteboard.items),
      );
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCommentMode(false);
    };
    target.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    const cursor = target.style.cursor;
    target.style.cursor = "crosshair";
    return () => {
      target.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      target.style.cursor = cursor;
    };
  }, [mode, domNode, flow, canWrite]);

  const run = React.useCallback(
    async (work: () => Promise<unknown>) => {
      try {
        await mutateComments(work);
      } catch (error) {
        toast.error(t("comments.failed"), {
          description: error instanceof Error ? error.message : undefined,
        });
        throw error;
      }
    },
    [t],
  );

  const actions = React.useMemo(
    () => ({
      onReply: (parentId: string, body: string) =>
        run(() => commentsApi.create(workspaceId, boardId, { parentId, body })),
      onResolve: (id: string, resolved: boolean) =>
        void run(() =>
          commentsApi.resolve(workspaceId, boardId, id, resolved),
        ).catch(() => undefined),
      onEdit: (id: string, body: string) =>
        run(() => commentsApi.edit(workspaceId, boardId, id, body)),
      onDelete: (id: string) =>
        void run(() => commentsApi.remove(workspaceId, boardId, id)).catch(
          () => undefined,
        ),
    }),
    [boardId, run, workspaceId],
  );

  const renderThread = (
    thread: CommentThreadData,
    { compact }: { compact: boolean },
  ) => (
    <CommentThread
      key={thread.root.id}
      thread={thread}
      people={people}
      selfId={selfId}
      canWrite={canWrite}
      isOwner={isOwner}
      offline={offline}
      compact={compact}
      {...actions}
    />
  );

  const groups = pinGroups(comments);
  const threads = threadsOf(comments);
  const dot = zoom < 0.5;

  // 评论模式下点钉：抽屉里滚到它的线程，而不是再开一个弹层。
  React.useEffect(() => {
    if (!mode || pinKey === null) return;
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-thread-anchor="${CSS.escape(pinKey)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, pinKey]);

  const draftAt = draft ? anchorPosition(draft, nodes, items) : null;

  return (
    <>
      <div
        data-slot="comment-layer"
        className="absolute top-0 left-0"
        style={{ zIndex: "var(--z-canvas-overlay)" }}
      >
        {groups.map((group) => {
          const at = anchorPosition(group.anchor, nodes, items);
          if (!at) return null;
          if (onlyOpen && mode && !group.open) return null;
          return (
            <div
              key={group.key}
              // 钉上的按下不该变成画布的框选或拖动。
              onPointerDown={(event) => event.stopPropagation()}
              className="absolute top-0 left-0 origin-top-left"
              style={{
                transform: `translate(${at.x}px, ${at.y}px) scale(${scale}) translate(-50%, -50%)`,
              }}
            >
              <Popover
                open={!mode && pinKey === group.key}
                onOpenChange={(value) => openPin(value ? group.key : null)}
              >
                <PopoverTrigger asChild>
                  <CommentPin
                    count={group.count}
                    open={group.open}
                    dot={dot}
                    color={authorColor(people, group.firstAuthor, selfId)}
                    label={t("comments.pin", { count: group.count })}
                  />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 p-0">
                  <ScrollArea className="max-h-[420px]">
                    <div className="flex flex-col gap-4 p-3">
                      {group.threads.map((thread, index) => (
                        <React.Fragment key={thread.root.id}>
                          {index > 0 && <Separator />}
                          {renderThread(thread, { compact: false })}
                        </React.Fragment>
                      ))}
                    </div>
                  </ScrollArea>
                </PopoverContent>
              </Popover>
            </div>
          );
        })}
        {draft && draftAt && (
          <Popover
            open
            onOpenChange={(value) => {
              if (!value) startDraft(null);
            }}
          >
            <PopoverAnchor asChild>
              <div
                data-comment-draft
                className="absolute size-px"
                style={{ left: draftAt.x, top: draftAt.y }}
              />
            </PopoverAnchor>
            <PopoverContent align="start" className="w-80">
              <CommentComposer
                autoFocus
                people={people}
                placeholder={t("comments.placeholder")}
                disabled={offline}
                onCancel={() => startDraft(null)}
                onSubmit={async (body) => {
                  await run(() =>
                    commentsApi.create(workspaceId, boardId, {
                      anchor: draft,
                      body,
                    }),
                  );
                  startDraft(null);
                  openPin(anchorKey(draft));
                }}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>

      <Sheet
        modal={false}
        open={mode}
        onOpenChange={(value) => !value && setCommentMode(false)}
      >
        <SheetContent
          side="right"
          className="w-[360px] gap-0 sm:max-w-[360px]"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <SheetHeader>
            <SheetTitle>{t("comments.title")}</SheetTitle>
          </SheetHeader>
          <CommentsPanelView
            threads={threads}
            onlyOpen={onlyOpen}
            onOnlyOpenChange={setOnlyOpen}
            renderThread={(thread, options) => {
              const key = anchorKey(thread.root.anchor);
              return (
                <div
                  key={thread.root.id}
                  data-thread-anchor={key}
                  data-active={key === pinKey ? "true" : undefined}
                  className="rounded-[var(--r-card)] data-[active=true]:ring-2 data-[active=true]:ring-[var(--brand)] data-[active=true]:ring-offset-4 data-[active=true]:ring-offset-popover"
                >
                  {renderThread(thread, options)}
                </div>
              );
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Dock 上的「评论」开关：开评论模式与右侧抽屉。没有打开的板时不画。 */
export function CommentModeButton() {
  const t = useT();
  const mode = useCommentsStore((state) => state.mode);
  const hasBoard = useCanvasStore((state) => state.boardId !== null);
  if (!hasBoard) return null;
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <IconButton
          size="dock"
          label={t("comments.mode")}
          active={mode}
          aria-pressed={mode}
          onClick={() => setCommentMode(!mode)}
        >
          <MessageSquarePlus />
        </IconButton>
      </TooltipTrigger>
      <TooltipContent>{t("comments.mode")}</TooltipContent>
    </Tooltip>
  );
}
