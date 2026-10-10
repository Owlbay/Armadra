/**
 * The band above the prompt, the toast and the board's name in the status
 * line (docs/design/claude-mods.md §4.2, contract §57.4 / §58), package M2.
 *
 * Every few seconds an interactive terminal session asks the core for its
 * node's overlay (`GET /node/overlay`, names and counts only, answered `304`
 * when nothing moved) and keeps it in `$.state`, which the band reads while
 * drawing — a write redraws it, and a hot reload keeps it. A peer message
 * newer than the last one seen raises one toast with the sender's name.
 *
 * Words: none. Names, numbers and four glyphs (↑ main, ↓ subs, ↔ peers,
 * ✉ unread), so nothing here depends on a language. No button: the band's
 * own `[-]` folds it. Nothing here answers, refuses or writes anything.
 *
 * Text for `template.ts`, by the same rules as `transport.ts`; it uses that
 * segment's `armadraSession` and `armadraIsId`, and `status.ts`'s
 * `armadraStatus` and `armadraInteractive`.
 */
export const UI_DECLARATIONS = String.raw`
// The overlay the band draws from, and the newest message sequence a toast
// was raised for: session state the host keeps across a reload.
const ARMADRA_OVERLAY = { plugin: "armadra-mod", key: "overlay" } as const;
const ARMADRA_SEEN = { plugin: "armadra-mod", key: "seen" } as const;

// Every 3 s: the core answers 304 almost always.
const ARMADRA_POLL_MS = 3000;
// Narrower than this the peers are left out of the band.
const ARMADRA_NARROW = 40;

let armadraPollTimer: { cancel: () => void } | undefined;
let armadraPolling = false;

function armadraText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function armadraCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function armadraLinks(value: unknown): ArmadraModLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const link = entry as Record<string, unknown>;
    return typeof link.id === "string" ? [{ id: link.id, name: armadraText(link.name).trim() }] : [];
  });
}

function armadraObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// The answer, kept to the fields the band reads; anything else is dropped.
function armadraOverlayOf(text: string): ArmadraModOverlay | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const body = armadraObject(raw);
  if (typeof body.revision !== "number") return undefined;
  const node = armadraObject(body.node);
  const board = armadraObject(body.board);
  const links = armadraObject(body.links);
  const inbox = armadraObject(body.inbox);
  return {
    revision: body.revision,
    name: armadraText(node.name).trim(),
    board: armadraText(board.title).trim(),
    main: armadraLinks(links.main),
    subs: armadraLinks(links.subs),
    peers: armadraLinks(links.peers),
    pending: armadraCount(inbox.pending),
    latestSequence: armadraCount(inbox.latestSequence),
    latestFrom: armadraText(inbox.latestFrom).trim(),
  };
}

// One GET through the host's fetch, the socket first and the port second.
async function armadraGet(
  $: EngineInterface,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string } | undefined> {
  const session = await armadraSession($);
  if (session === undefined) return undefined;
  const all = { ...session.headers, ...headers };
  delete all["Content-Type"];
  if (session.sock !== undefined) {
    try {
      return await $.http.fetch("http://armadra" + pathname, {
        method: "GET",
        headers: all,
        socketPath: session.sock,
      });
    } catch {
      // Refused or unreachable: try the port.
    }
  }
  if (session.port !== undefined) {
    try {
      return await $.http.fetch("http://127.0.0.1:" + String(session.port) + pathname, {
        method: "GET",
        headers: all,
      });
    } catch {
      // The next tick tries again.
    }
  }
  return undefined;
}

async function armadraPoll($: EngineInterface): Promise<void> {
  if (armadraPolling) return;
  armadraPolling = true;
  try {
    const nodeId = await $.env.get("ARMADRA_NODE_ID");
    if (!armadraIsId(nodeId)) return;
    const held = (await $.state.get(ARMADRA_OVERLAY)).value ?? null;
    const headers: Record<string, string> =
      held === null ? {} : { "If-None-Match": '"' + String(held.revision) + '"' };
    const answer = await armadraGet($, "/node/overlay?nodeId=" + nodeId, headers);
    if (answer === undefined || answer.status !== 200) return;
    const overlay = armadraOverlayOf(answer.text);
    if (overlay === undefined) return;
    await $.state.set(ARMADRA_OVERLAY, overlay);
    await armadraStatus($);
    await armadraArrived($, overlay, held === null);
  } catch {
    // The band keeps what it last drew.
  } finally {
    armadraPolling = false;
  }
}

// A peer message newer than the last one seen: one toast, the sender's name
// only. The first answer of a session sets the mark without a toast — what
// was already waiting is the band's ✉, not news.
async function armadraArrived(
  $: EngineInterface,
  overlay: ArmadraModOverlay,
  first: boolean,
): Promise<void> {
  const seen = await $.state.get(ARMADRA_SEEN);
  const mark = seen.value ?? 0;
  if (overlay.latestSequence <= mark) return;
  await $.state.set(ARMADRA_SEEN, overlay.latestSequence);
  if (first && seen.version === 0) return;
  if (overlay.pending === 0) return;
  $.ui.toast(overlay.latestFrom === "" ? "✉" : "✉ " + overlay.latestFrom);
}

function armadraWatch($: EngineInterface): void {
  armadraPollTimer?.cancel();
  void armadraPoll($);
  armadraPollTimer = $.clock.every(ARMADRA_POLL_MS, () => {
    void armadraPoll($);
  });
}

// Up to two names, then a count of the rest; a list of unnamed nodes is
// its count alone.
function armadraNames(links: readonly ArmadraModLink[]): string {
  const named = links.filter((link) => link.name !== "").slice(0, 2);
  if (named.length === 0) return String(links.length);
  const rest = links.length - named.length;
  return named.map((link) => link.name).join(", ") + (rest > 0 ? ", +" + String(rest) : "");
}

// The band's one line, or "" for nothing to draw.
function armadraBand(overlay: ArmadraModOverlay | null, columns: number): string {
  if (overlay === null) return "";
  const parts: string[] = [];
  if (overlay.main.length > 0) parts.push("↑ " + armadraNames(overlay.main));
  if (overlay.subs.length > 0) parts.push("↓ " + armadraNames(overlay.subs));
  if (overlay.peers.length > 0 && columns >= ARMADRA_NARROW) {
    parts.push("↔ " + armadraNames(overlay.peers));
  }
  if (overlay.pending > 0) parts.push("✉ " + String(overlay.pending));
  return parts.join("   ");
}
`;

/**
 * The band: a `ui.render` hook on `AbovePrompt`. With nothing linked and
 * nothing unread (or a survey holding the band) it hands the band on, and
 * the band stays empty.
 */
export const UI_REGISTRATIONS = String.raw`
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const overlay = (await $.state.get(ARMADRA_OVERLAY)).value ?? null;
    const line = armadraBand(overlay, e.props.bodyColumns);
    if (line === "") return next(e);
    const { Text } = $.ui.resolve(e);
    // h() is typed as any node; a Text is an element.
    return h(Text, { dimColor: true, wrap: "truncate" }, line) as RenderElement;
  }).catch(($, e, next) => next(e));
`;

/**
 * The state contract, `hooks/armadra-state.d.ts` beside the module: what
 * `claude plugin validate` holds every `$.state` key the module names to.
 * Self-contained, no import, as the engine reads it.
 */
export const UI_TYPES = `// Armadra — the state of the Claude Code mod (armadra-mod).
// Generated by the Armadra core and rewritten at every start; edits are lost.
// Names and counts only: no message, no path, no terminal content.

/** One linked node: its id and its name (its title when it has none). */
export type ArmadraModLink = { id: string; name: string };

/** What the band draws: GET /node/overlay, kept to the fields it reads. */
export type ArmadraModOverlay = {
  revision: number;
  name: string;
  board: string;
  main: ArmadraModLink[];
  subs: ArmadraModLink[];
  peers: ArmadraModLink[];
  pending: number;
  latestSequence: number;
  latestFrom: string;
};

declare module "claude-code" {
  interface PluginState {
    "armadra-mod": {
      overlay: ArmadraModOverlay | null;
      seen: number;
    };
  }
}
`;
