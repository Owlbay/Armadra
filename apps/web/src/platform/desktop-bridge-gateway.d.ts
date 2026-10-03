/**
 * `window.armadra.gateway` — the tray's "external service" item reads the
 * gateway state on a timer; the page tells it to re-read after a change so
 * the check mark does not lag (`apps/desktop/src/preload/index.ts`).
 */
interface ArmadraBridge {
  readonly gateway?: {
    refresh(): Promise<{ readonly ok: boolean }>;
  };
}
