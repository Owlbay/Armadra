import { nodeOverlay, overlayTag, tagMatches } from "../collab/overlay";
import type { HandlerResult } from "../http/router";
import { validNodeId } from "./auth";
import type { IngestContext } from "./ingest";

/**
 * `GET /node/overlay?nodeId=…` on the hook surface (contract §57.4, §58).
 *
 * Same gates as `/node/mod` and `/credential`: the app bearer (checked by the
 * caller) and a node token that verifies for the node named — an unverified
 * caller could otherwise read any node's neighbourhood. The answer is the
 * caller's own node only. `If-None-Match` with the current revision is
 * answered `304` and no body: the mod asks every few seconds and almost
 * always nothing moved.
 */
export function answerOverlay(
  context: Pick<IngestContext, "database" | "hooks" | "now">,
  request: {
    readonly nodeId: string;
    readonly nodeToken: string | undefined;
    readonly ifNoneMatch: string | undefined;
  },
): HandlerResult {
  const { nodeId } = request;
  if (
    !validNodeId(nodeId) ||
    context.hooks.verdict(nodeId, request.nodeToken) !== "verified"
  ) {
    return {
      status: 403,
      body: { code: "forbidden", message: "The node token is not valid" },
    };
  }
  const now = Math.floor((context.now?.() ?? new Date()).getTime() / 1000);
  const overlay = nodeOverlay(context.database, nodeId, now);
  if (overlay === undefined) {
    return {
      status: 404,
      body: { code: "not_found", message: "The node is not on a board" },
    };
  }
  const headers = {
    etag: overlayTag(overlay.revision),
    "cache-control": "no-store",
  };
  if (tagMatches(request.ifNoneMatch, overlay.revision)) {
    return { status: 304, headers };
  }
  return { status: 200, body: overlay, headers };
}
