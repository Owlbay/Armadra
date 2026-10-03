import type { DatabaseSync } from "node:sqlite";
import {
  type ContextLink,
  getContextLinks,
  putContextLinks,
} from "../canvas/context-links";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
} from "../canvas/document-types";
import { loadBoard, saveBoard } from "../canvas/documents";
import { newNode } from "../collab/control/board";
import { ensureWorktree } from "../collab/control/worktree";
import type { Caller } from "../collab/nodes";
import { asRefused } from "../collab/refusals";
import { byId, enqueue, type QueueItem } from "../collab/send-queue";
import type { CollabContext } from "../collab/service";
import { dependencyService } from "../dependencies/registry";
import { insertLaunch, launchFor } from "../dependencies/store";
import { DomainError, rfc3339, uuidV7 } from "../workspaces/support";

/**
 * 「对一个成员节点做的事」：工作流引擎的 `prompt` / `collect` 步骤与 runner
 * （补全架构 §5.3）共用这一处，两边对成员节点做的事完全相同。
 *
 *   * **建**：一次运行在画布上的样子——一个 Frame，里面一张起点便签、每个角色
 *     一个 Agent 终端节点；便签向每个角色连一条主从线（`supervises`），草案的
 *     `links` 照原样连在角色之间。节点与边经 `saveBoard` 写，链接文档同呼吸
 *     （`collab/control/nodes.ts` 的同一条规矩）。
 *   * **起**：每个角色节点交给依赖编排的启动路径（一条没有边的启动行），由它
 *     在 core 里起终端、敲启动行——页面开不开都一样。
 *   * **投**：一条提示词就是投递队列里的一条排队项，发起方是起点便签。门链、
 *     租约、回执与 `canvas send` 是同一条；`first-task` 这一类在目标还没起来时
 *     退回排队而不是当场拒绝，正是一个刚建的角色节点需要的。
 *
 * 为什么发起方是一张便签：投递的授权来自连线（`send.ts::authorize`），而人起的
 * 一次运行没有一个「调用者节点」。便签是运行在画布上看得见的那个主，它没有
 * Agent，能力位那一关不拦它；人看得见每个角色是被谁驱动的。
 */

/** Frame 内边距与节点间距。尺寸与页面上的缺省终端（960×600）对齐。 */
const FRAME_PADDING = 40;
const ANCHOR_WIDTH = 280;
const ROLE_WIDTH = 960;
const ROLE_HEIGHT = 600;
const ROLE_GAP = 60;
const FRAME_GAP = 120;
const SAVE_ATTEMPTS = 3;

export interface LayoutRole {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly permissionMode?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly worktree?: string | null | undefined;
}

export interface LayoutLink {
  readonly from: string;
  readonly to: string;
  readonly role: "peer" | "supervises";
}

export interface RunLayout {
  readonly frameId: string;
  readonly anchorNodeId: string;
  /** 角色 id → 节点 id。 */
  readonly roles: Record<string, string>;
}

/** 起一次运行的 Frame、起点便签与角色节点。 */
export async function layoutRun(
  collab: CollabContext,
  request: {
    readonly workspaceId: string;
    readonly boardId: string;
    readonly title: string;
    readonly runId: string;
    readonly roles: readonly LayoutRole[];
    readonly links: readonly LayoutLink[];
  },
): Promise<RunLayout> {
  const { workspaceId, boardId } = request;
  // worktree 先备好：Git 拒绝就整次拒绝，画布上不留半个运行。
  const cwds = new Map<string, string>();
  for (const role of request.roles) {
    if (role.worktree === undefined || role.worktree === null) continue;
    if (cwds.has(role.worktree)) continue;
    try {
      const target = await ensureWorktree(
        collab,
        pseudoCaller(workspaceId, boardId),
        role.worktree,
      );
      cwds.set(role.worktree, target.absolute);
    } catch (error) {
      const refused = asRefused(error);
      throw new DomainError(refused.status, refused.code, refused.message);
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    const document = loadBoard(collab.database, workspaceId, boardId);
    const built = build(document, request, cwds);
    try {
      const saved = saveBoard(collab.database, workspaceId, boardId, {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: built.nodes,
        edges: built.edges,
        viewport: document.board.viewport,
      });
      writeLinks(collab.database, workspaceId, built);
      collab.publish(workspaceId, {
        type: "board.changed",
        boardId: saved.board.id,
        updatedAt: saved.board.updatedAt,
      });
      collab.publish(workspaceId, {
        type: "node.created",
        boardId: saved.board.id,
        nodeId: built.layout.frameId,
        nodeType: "group",
        originNodeId: built.layout.anchorNodeId,
      });
      return built.layout;
    } catch (error) {
      // 人刚好在这一瞬间挪了什么：重读再来，几次都撞上才放弃。
      if (
        error instanceof DomainError &&
        error.status === 409 &&
        attempt < SAVE_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
}

interface Built {
  readonly nodes: CanvasNode[];
  readonly edges: CanvasEdge[];
  readonly layout: RunLayout;
  /** 每个节点的链接文档要加的条目。 */
  readonly links: { owner: string; link: ContextLink }[];
}

function build(
  document: BoardDocument,
  request: {
    readonly title: string;
    readonly runId: string;
    readonly roles: readonly LayoutRole[];
    readonly links: readonly LayoutLink[];
  },
  cwds: ReadonlyMap<string, string>,
): Built {
  const boardId = document.board.id;
  // 放在画布上已有东西的右边，不压住任何节点。
  const right = document.nodes
    .filter((node) => node.parentId === undefined || node.parentId === null)
    .reduce(
      (most, node) =>
        Math.max(most, node.position.x + (node.size?.width ?? ROLE_WIDTH)),
      0,
    );
  const frame: CanvasNode = {
    ...newNode(
      boardId,
      "group",
      request.title,
      { x: right + FRAME_GAP, y: FRAME_PADDING },
      { kind: "group" },
    ),
    size: {
      width:
        FRAME_PADDING * 2 +
        ANCHOR_WIDTH +
        request.roles.length * (ROLE_WIDTH + ROLE_GAP),
      height: FRAME_PADDING * 2 + ROLE_HEIGHT + 40,
    },
  };
  const anchor: CanvasNode = {
    ...newNode(
      boardId,
      "sticky",
      request.title,
      { x: FRAME_PADDING, y: FRAME_PADDING + 40 },
      { kind: "sticky", content: `workflow run ${request.runId}` },
    ),
    parentId: frame.id,
  };
  const roles: Record<string, string> = {};
  const roleNodes = request.roles.map((role, index) => {
    const agent: Record<string, unknown> = { id: role.agentId };
    if (role.permissionMode != null) agent.permissionMode = role.permissionMode;
    if (role.model != null) agent.model = role.model;
    const cwd = role.worktree == null ? undefined : cwds.get(role.worktree);
    const node: CanvasNode = {
      ...newNode(
        boardId,
        "terminal",
        role.title,
        {
          x:
            FRAME_PADDING +
            ANCHOR_WIDTH +
            ROLE_GAP +
            index * (ROLE_WIDTH + ROLE_GAP),
          y: FRAME_PADDING + 40,
        },
        {
          kind: "terminal",
          agent,
          ...(cwd === undefined ? {} : { cwd }),
        },
      ),
      parentId: frame.id,
    };
    roles[role.id] = node.id;
    return node;
  });

  const now = rfc3339();
  const edge = (source: string, target: string, role: string): CanvasEdge => ({
    id: uuidV7(),
    boardId,
    source,
    target,
    kind: "link",
    role,
    createdAt: now,
    updatedAt: now,
  });
  const edges: CanvasEdge[] = [...document.edges];
  const links: { owner: string; link: ContextLink }[] = [];
  const titleOf = new Map<string, CanvasNode>(
    [anchor, ...roleNodes].map((node) => [node.id, node]),
  );
  const join = (from: string, to: string, role: "peer" | "supervises") => {
    edges.push(edge(from, to, role));
    const a = titleOf.get(from) as CanvasNode;
    const b = titleOf.get(to) as CanvasNode;
    links.push({
      owner: from,
      link: {
        id: to,
        title: b.title,
        kind: b.type,
        role: role === "supervises" ? "sub" : "peer",
      },
    });
    links.push({
      owner: to,
      link: {
        id: from,
        title: a.title,
        kind: a.type,
        role: role === "supervises" ? "main" : "peer",
      },
    });
  };
  for (const node of roleNodes) join(anchor.id, node.id, "supervises");
  for (const link of request.links) {
    const from = roles[link.from];
    const to = roles[link.to];
    if (from !== undefined && to !== undefined) join(from, to, link.role);
  }
  return {
    // 父节点排在子节点前面。
    nodes: [...document.nodes, frame, anchor, ...roleNodes],
    edges,
    layout: { frameId: frame.id, anchorNodeId: anchor.id, roles },
    links,
  };
}

function writeLinks(
  database: DatabaseSync,
  workspaceId: string,
  built: Built,
): void {
  const byOwner = new Map<string, ContextLink[]>();
  for (const { owner, link } of built.links) {
    const list = byOwner.get(owner) ?? [];
    list.push(link);
    byOwner.set(owner, list);
  }
  for (const [owner, added] of byOwner) {
    const existing = getContextLinks(database, owner).links;
    const merged = [
      ...existing.filter(
        (entry) => !added.some((link) => link.id === entry.id),
      ),
      ...added,
    ];
    putContextLinks(database, workspaceId, owner, merged);
  }
}

function pseudoCaller(workspaceId: string, boardId: string): Caller {
  return {
    node: {
      id: "",
      boardId,
      workspaceId,
      title: "",
      nodeType: "sticky",
      agentId: null,
      data: {},
    },
    verdict: "verified",
  };
}

/* --------------------------------- 起 ------------------------------------- */

/**
 * 交给依赖编排去起：一条没有边的启动行，服务看见「每条边都已满足」（没有边）
 * 就起终端、敲启动行。已经有启动行的节点不重复插（重启续跑时再调一次无害）。
 */
export function launchRoleNode(
  database: DatabaseSync,
  node: {
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly boardId: string;
  },
  nowSeconds: number,
): void {
  if (launchFor(database, node.nodeId) === undefined) {
    insertLaunch(
      database,
      {
        nodeId: node.nodeId,
        workspaceId: node.workspaceId,
        boardId: node.boardId,
        now: nowSeconds,
      },
      [],
    );
  }
  void dependencyService()?.created(node.nodeId);
}

/* --------------------------------- 投 ------------------------------------- */

export class DeliveryRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryRefused";
  }
}

/**
 * 排一条提示词。答排队项 id；排不上（目标队伍满了）抛 {@link DeliveryRefused}。
 */
export function deliverPrompt(
  collab: CollabContext,
  item: {
    readonly workspaceId: string;
    readonly sourceNodeId: string;
    readonly targetNodeId: string;
    readonly body: string;
    readonly nowSeconds: number;
  },
): string {
  const inserted = enqueue(collab.database, {
    id: uuidV7(),
    workspaceId: item.workspaceId,
    sourceNodeId: item.sourceNodeId,
    targetNodeId: item.targetNodeId,
    origin: "first-task",
    body: item.body,
    hops: 0,
    trail: [],
    now: item.nowSeconds,
    state: "queued",
  });
  if (inserted.kind !== "inserted") {
    throw new DeliveryRefused("QUEUE_FULL", "目标的投递队列满了。");
  }
  collab.nudge?.(item.targetNodeId);
  return inserted.item.id;
}

export function queueItem(
  database: DatabaseSync,
  id: string,
): QueueItem | undefined {
  return byId(database, id);
}
