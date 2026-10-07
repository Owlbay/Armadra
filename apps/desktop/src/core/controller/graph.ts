import {
  ControllerGraphSchema,
  CONTROLLER_LIMITS,
  type ControllerGraph,
} from "@armadra/shared";
import type { DatabaseSync } from "node:sqlite";
import { loadBoard, saveBoardInTransaction } from "../canvas/documents";
import { validateDocument } from "../canvas/validation";
import {
  getContextLinks,
  putContextLinks,
  type ContextLink,
} from "../canvas/context-links";
import type { BoardDocument, CanvasNode } from "../canvas/document-types";
import { newNode, placement } from "../collab/control/board";
import { getWorkspace } from "../workspaces/table";
import { rfc3339, uuidV7 } from "../workspaces/support";
import { ControllerError } from "./errors";
import { scopedPath } from "./paths";
import { ownsNode, type ControllerActor } from "./store";

export function prepareGraph(
  database: DatabaseSync,
  actor: ControllerActor,
  boardId: string,
  input: unknown,
) {
  const parsed = ControllerGraphSchema.safeParse(input);
  if (!parsed.success)
    throw new ControllerError(
      "invalid_graph",
      `Invalid graph at ${parsed.error.issues[0]?.path.join(".") ?? "input"}`,
    );
  const graph = parsed.data;
  const original = loadBoard(database, actor.workspaceId, boardId);
  if (original.board.updatedAt !== graph.expectedUpdatedAt)
    throw new ControllerError(
      "revision_conflict",
      "Board has changed; reload before applying",
      409,
    );
  const document = {
    ...original,
    nodes: [...original.nodes],
    edges: [...original.edges],
  };
  const nodeIds: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const created: string[] = [];
  const root = getWorkspace(database, actor.workspaceId).rootPath;
  const creates = graph.operations.filter((op) => op.op === "createNode");
  const links = graph.operations.filter((op) => op.op === "createContextLink");
  if (
    creates.length > CONTROLLER_LIMITS.nodes ||
    links.length > CONTROLLER_LIMITS.links
  )
    throw new ControllerError(
      "graph_limit",
      "At most 32 new nodes and 128 links per batch",
    );
  for (const op of creates) {
    if (Object.hasOwn(nodeIds, op.key))
      throw new ControllerError(
        "duplicate_key",
        `Duplicate node key: ${op.key}`,
      );
    if (op.type !== op.data.kind)
      throw new ControllerError(
        "invalid_graph",
        "Node type and data kind must match",
      );
    const data = { ...op.data } as Record<string, unknown>;
    if (op.type === "terminal") data.launchPolicy = "manual";
    for (const field of ["path", "repoPath"])
      if (typeof data[field] === "string")
        scopedPath(root, data[field] as string);
    if (op.data.kind === "diff")
      for (const path of op.data.paths ?? []) scopedPath(root, path);
    if (op.data.kind === "browser" && op.data.url) {
      let url: URL;
      try {
        url = new URL(op.data.url);
      } catch {
        throw new ControllerError(
          "invalid_graph",
          "Browser URL must be absolute HTTP or HTTPS",
        );
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new ControllerError(
          "invalid_graph",
          "Browser URL must be HTTP or HTTPS without credentials",
        );
    }
    const node = newNode(
      boardId,
      op.type,
      op.title,
      op.position ?? placement(document, ""),
      data,
    );
    nodeIds[op.key] = node.id;
    created.push(node.id);
    document.nodes.push(node);
  }
  const ref = (target: { id: string } | { key: string }): CanvasNode => {
    const id = "id" in target ? target.id : nodeIds[target.key];
    const node = document.nodes.find((n) => n.id === id);
    if (!node)
      throw new ControllerError(
        "invalid_reference",
        "Node reference must name a node on this board",
      );
    return node;
  };
  const parent = (node: CanvasNode, parentId: string | null) => {
    if (!parentId) {
      const { parentId: _, ...copy } = node;
      return copy;
    }
    const group = ref({ id: parentId });
    if (node.type === "group" || group.type !== "group" || group.parentId)
      throw new ControllerError("nested_group", "Groups cannot be nested");
    return { ...node, parentId: group.id };
  };
  const now = rfc3339();
  for (const op of graph.operations) {
    if (op.op === "createNode") {
      if (op.parent) {
        const node = ref({ key: op.key });
        document.nodes[document.nodes.indexOf(node)] = parent(
          node,
          ref(op.parent).id,
        );
      }
    } else if (op.op === "updateNode") {
      const existing = ref(op.node);
      if (
        !created.includes(existing.id) &&
        !ownsNode(database, actor, existing.id)
      )
        throw new ControllerError(
          "scope_denied",
          "Only nodes created by this profile may be edited",
          403,
        );
      let copy = { ...existing, ...op.changes, updatedAt: now } as CanvasNode;
      if (op.changes.parentId !== undefined)
        copy = parent(copy, op.changes.parentId);
      document.nodes[document.nodes.indexOf(existing)] = copy;
    } else if (op.op === "createContextLink") {
      const from = ref(op.source),
        to = ref(op.target);
      if (from.id === to.id)
        throw new ControllerError(
          "self_link",
          "Context links cannot point at the same node",
        );
      if (
        document.edges.some(
          (e) =>
            e.source === from.id && e.target === to.id && e.role === op.role,
        )
      )
        continue;
      document.edges.push({
        id: uuidV7(),
        boardId,
        source: from.id,
        target: to.id,
        kind: "link",
        role: op.role,
        createdAt: now,
        updatedAt: now,
      });
    } else if (op.op === "removeContextLink") {
      const index = document.edges.findIndex((e) => e.id === op.edgeId);
      if (index < 0)
        throw new ControllerError(
          "invalid_reference",
          "Edge reference must name an edge on this board",
        );
      document.edges.splice(index, 1);
    }
  }
  validateDocument(boardId, document.nodes, document.edges);
  return { graph, document, original, nodeIds, created };
}

export function writeGraph(
  database: DatabaseSync,
  actor: ControllerActor,
  prepared: ReturnType<typeof prepareGraph>,
) {
  const { document, original, graph } = prepared;
  const saved = saveBoardInTransaction(
    database,
    actor.workspaceId,
    document.board.id,
    {
      expectedUpdatedAt: graph.expectedUpdatedAt,
      nodes: document.nodes,
      edges: document.edges,
      viewport: original.board.viewport,
    },
  );
  for (const id of prepared.created)
    database
      .prepare("INSERT INTO controller_objects VALUES (?, ?, ?)")
      .run(id, actor.controllerId, actor.workspaceId);
  const notified: string[] = [];
  for (const node of saved.nodes) {
    const previous = new Set(
      original.edges.flatMap((e) =>
        e.source === node.id
          ? [e.target]
          : e.target === node.id
            ? [e.source]
            : [],
      ),
    );
    const peers = saved.edges.filter(
      (e) => e.source === node.id || e.target === node.id,
    );
    if (!previous.size && !peers.length) continue;
    const current: ContextLink[] = getContextLinks(
      database,
      node.id,
    ).links.filter((link) => !previous.has(link.id));
    for (const edge of peers) {
      const id = edge.source === node.id ? edge.target : edge.source;
      const other = saved.nodes.find((n) => n.id === id)!;
      const link: ContextLink = {
        id,
        title: other.title,
        kind: other.type,
        role:
          edge.role === "supervises"
            ? edge.source === node.id
              ? "sub"
              : "main"
            : "peer",
      };
      const index = current.findIndex((link) => link.id === id);
      if (index >= 0) current[index] = link;
      else current.push(link);
    }
    putContextLinks(database, actor.workspaceId, node.id, current, false);
    notified.push(node.id);
  }
  database
    .prepare(
      "INSERT INTO controller_events (controller_id, workspace_id, actor_kind, command, target_id, created_at) VALUES (?, ?, 'controller', 'graph.apply', ?, ?)",
    )
    .run(actor.controllerId, actor.workspaceId, document.board.id, rfc3339());
  return {
    boardId: saved.board.id,
    updatedAt: saved.board.updatedAt,
    nodeIds: prepared.nodeIds,
    createdNodes: prepared.created.length,
    contextLinks: saved.edges.length,
    notified,
  };
}
