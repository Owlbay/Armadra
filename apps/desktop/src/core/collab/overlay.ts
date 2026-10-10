import type { DatabaseSync } from "node:sqlite";
import { getContextLinks, nodeRole } from "../canvas/context-links";
import { handlesFor } from "../canvas/handles";
import { NOT_RECEIPT } from "./mailbox";
import { loadNode } from "./nodes";

/**
 * `GET /node/overlay` on the hook surface (contract §57.4, §58): what the
 * Claude Code mod draws in the band above the prompt — the node's canvas
 * neighbourhood as names, ids and counts.
 *
 * Read-only and narrow on purpose. No message body, no path, no terminal
 * content leaves through it: the inbox is a count, the sequence of its latest
 * message and who wrote it; the links are names. Only the caller's own link
 * document is read, and a link only counts when its node is on a board of
 * the caller's own workspace — what the canvas did not connect is not here.
 */

export interface OverlayLink {
  readonly id: string;
  readonly name: string;
}

export interface NodeOverlay {
  /** A digest of everything below: equal digests, nothing to redraw. */
  readonly revision: number;
  readonly node: {
    readonly id: string;
    readonly name: string;
    readonly role: "main" | "sub" | null;
    readonly agentId: string | null;
  };
  readonly board: { readonly id: string; readonly title: string };
  readonly links: {
    readonly main: readonly OverlayLink[];
    readonly subs: readonly OverlayLink[];
    readonly peers: readonly OverlayLink[];
  };
  readonly inbox: {
    readonly pending: number;
    readonly latestSequence: number;
    readonly latestFrom: string;
  };
  readonly outbox: { readonly queued: number };
  readonly approvals: { readonly pending: number };
}

/** A band shows a handful of names; past this the rest is a count anyway. */
const MAX_LINKS = 64;

/**
 * One node's overlay at `now` (epoch seconds, the mailbox's and the queue's
 * unit), or `undefined` when the node is not on any board.
 */
export function nodeOverlay(
  database: DatabaseSync,
  nodeId: string,
  now: number,
): NodeOverlay | undefined {
  const node = loadNode(database, nodeId);
  if (node === undefined) return undefined;
  const board = database
    .prepare("SELECT name FROM boards WHERE id = ?")
    .get(node.boardId) as { name: string } | undefined;
  const ownHandle = handlesFor(database, [node.id]).get(node.id);

  const links = linkedNodes(database, node.id, node.workspaceId);
  const handles = handlesFor(
    database,
    links.map((link) => link.id),
  );
  const main: OverlayLink[] = [];
  const subs: OverlayLink[] = [];
  const peers: OverlayLink[] = [];
  for (const link of links) {
    const entry = { id: link.id, name: handles.get(link.id) ?? link.title };
    if (link.role === "main") main.push(entry);
    else if (link.role === "sub") subs.push(entry);
    else peers.push(entry);
  }

  const body = {
    node: {
      id: node.id,
      name: ownHandle ?? node.title,
      role: nodeRole(database, node.id) ?? null,
      agentId: node.agentId,
    },
    board: { id: node.boardId, title: board?.name ?? "" },
    links: { main, subs, peers },
    inbox: inboxOf(database, node.id, now),
    outbox: { queued: queuedFrom(database, node.id, now) },
    approvals: { pending: pendingApprovals(database, node.id) },
  };
  return { revision: digest(JSON.stringify(body)), ...body };
}

interface LinkedNode {
  readonly id: string;
  readonly title: string;
  readonly role: string;
}

/**
 * The node links of the caller's own document whose node is on a board of
 * the same workspace, in the document's order, each once. A `shape` link is
 * a whiteboard shape, not a node, and has no name to show.
 */
function linkedNodes(
  database: DatabaseSync,
  nodeId: string,
  workspaceId: string,
): LinkedNode[] {
  const wanted: { id: string; role: string }[] = [];
  const seen = new Set<string>([nodeId]);
  for (const link of getContextLinks(database, nodeId).links) {
    if (link.kind === "shape" || typeof link.id !== "string") continue;
    if (seen.has(link.id)) continue;
    seen.add(link.id);
    wanted.push({ id: link.id, role: link.role ?? "peer" });
    if (wanted.length >= MAX_LINKS) break;
  }
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => "?").join(",");
  const rows = database
    .prepare(
      "SELECT n.id AS id, n.title AS title FROM nodes n JOIN boards b ON b.id = n.board_id " +
        `WHERE b.workspace_id = ? AND n.id IN (${placeholders})`,
    )
    .all(workspaceId, ...wanted.map((link) => link.id)) as unknown as {
    id: string;
    title: string;
  }[];
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  return wanted.flatMap((link) => {
    const title = titles.get(link.id);
    return title === undefined ? [] : [{ ...link, title }];
  });
}

/**
 * Unread peer messages: how many, the newest one's sequence (what "a new
 * message arrived" is compared on) and who wrote it — the name, else the
 * title, as `inbox` signs every row. Never the body.
 */
function inboxOf(
  database: DatabaseSync,
  nodeId: string,
  now: number,
): NodeOverlay["inbox"] {
  const counted = database
    .prepare(
      "SELECT COUNT(*) AS total, MAX(sequence) AS latest FROM agent_mailbox " +
        "WHERE target_node_id = ? AND acknowledged_at IS NULL AND expires_at > ? " +
        `AND ${NOT_RECEIPT}`,
    )
    .get(nodeId, now) as { total: number; latest: number | null };
  const pending = Number(counted.total);
  if (pending === 0 || counted.latest === null) {
    return { pending: 0, latestSequence: 0, latestFrom: "" };
  }
  const latest = database
    .prepare(
      "SELECT COALESCE(h.handle, n.title, '') AS from_name FROM agent_mailbox m " +
        "LEFT JOIN nodes n ON n.id = m.source_node_id " +
        "LEFT JOIN node_handles h ON h.node_id = m.source_node_id " +
        "WHERE m.sequence = ?",
    )
    .get(counted.latest) as { from_name: string } | undefined;
  return {
    pending,
    latestSequence: Number(counted.latest),
    latestFrom: latest?.from_name ?? "",
  };
}

/** This node's own sends still waiting for their target. */
function queuedFrom(database: DatabaseSync, nodeId: string, now: number) {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM agent_send_queue WHERE source_node_id = ? " +
        "AND state IN ('queued','delivering') AND expires_at > ?",
    )
    .get(nodeId, now) as { total: number };
  return Number(row.total);
}

/** Permission prompts of this node still waiting for a person. */
function pendingApprovals(database: DatabaseSync, nodeId: string): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS total FROM agent_approvals WHERE node_id = ? AND answer IS NULL",
    )
    .get(nodeId) as { total: number };
  return Number(row.total);
}

/** FNV-1a over the UTF-16 units: a stable, non-negative 32-bit number. */
function digest(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** `"<revision>"`, the entity tag `If-None-Match` is compared with. */
export function overlayTag(revision: number): string {
  return `"${revision}"`;
}

/** Whether an `If-None-Match` header names this revision (or is `*`). */
export function tagMatches(
  header: string | undefined,
  revision: number,
): boolean {
  if (header === undefined) return false;
  const tag = overlayTag(revision);
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === tag || part === "*");
}
