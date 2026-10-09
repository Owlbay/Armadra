import { afterEach, describe, expect, it } from "vitest";
import { type HookFixture, hookFixture } from "./fixture";
import { MAX_MOD_HELLOS, type ModHello } from "./service";
import { parseModHello } from "./mod-hello";

/**
 * `POST /node/mod` (contract §57.3): the hello a Claude Code mod sends when it
 * loaded. Bearer and a verified node token; kept in memory, one per node.
 */

let open: HookFixture[] = [];

function fixture(): HookFixture {
  const made = hookFixture();
  open.push(made);
  return made;
}

afterEach(() => {
  for (const one of open) one.close();
  open = [];
});

const HELLO = {
  engine: "claude",
  version: "2.1.293",
  base: "2.1.293",
  surface: "terminal",
  isInteractive: true,
  profile: "terminal",
  transport: "socket",
  modRevision: 1,
};

async function hello(
  it_: HookFixture,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  return (await it_.server.router.dispatch("POST", "/node/mod", {
    method: "POST",
    path: "/node/mod",
    query: new URLSearchParams(),
    headers: { "content-type": "application/json", ...headers },
    body: encoded,
    raw: undefined as never,
    json: <T>(): T => JSON.parse(encoded.toString("utf8")) as T,
  })) as { status: number; body: unknown };
}

describe("the mod hello", () => {
  it("is kept per node with a verified token, and replaced by the next", async () => {
    const it_ = fixture();
    const token = it_.service.issueNodeToken(it_.nodeId);
    const headers = {
      "x-armadra-hook-token": it_.bearer,
      "x-armadra-node-token": token,
    };
    expect(
      (await hello(it_, { ...HELLO, nodeId: it_.nodeId }, headers)).status,
    ).toBe(204);
    expect(it_.service.modSessions()).toMatchObject([
      { nodeId: it_.nodeId, transport: "socket", version: "2.1.293" },
    ]);
    expect(
      (
        await hello(
          it_,
          { ...HELLO, nodeId: it_.nodeId, transport: "process" },
          headers,
        )
      ).status,
    ).toBe(204);
    expect(it_.service.modSessions()).toHaveLength(1);
    expect(it_.service.modSessions()[0]?.transport).toBe("process");
  });

  it("refuses without the bearer, without a verified token, and a malformed body", async () => {
    const it_ = fixture();
    const body = { ...HELLO, nodeId: it_.nodeId };
    expect((await hello(it_, body, {})).status).toBe(403);
    expect(
      (await hello(it_, body, { "x-armadra-hook-token": it_.bearer })).status,
    ).toBe(403);
    expect(
      (
        await hello(it_, body, {
          "x-armadra-hook-token": it_.bearer,
          "x-armadra-node-token": "nope.nope",
        })
      ).status,
    ).toBe(403);
    const headers = {
      "x-armadra-hook-token": it_.bearer,
      "x-armadra-node-token": it_.service.issueNodeToken(it_.nodeId),
    };
    for (const bad of [
      { ...body, transport: "carrier-pigeon" },
      { ...body, modRevision: 0 },
      { ...body, version: "x".repeat(65) },
      { ...body, nodeId: "../etc" },
      [body],
    ]) {
      expect((await hello(it_, bad, headers)).status, JSON.stringify(bad)).toBe(
        400,
      );
    }
    expect(it_.service.modSessions()).toEqual([]);
  });

  it("keeps versions and the transport only", () => {
    const parsed = parseModHello(
      {
        ...HELLO,
        nodeId: "node-1",
        token: "secret",
        path: "/home/someone",
        surface: "somewhere",
      },
      "2026-10-10T00:00:00.000Z",
    ) as ModHello;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "base",
        "engine",
        "isInteractive",
        "modRevision",
        "nodeId",
        "profile",
        "reportedAt",
        "surface",
        "transport",
        "version",
      ].sort(),
    );
    expect(parsed.surface).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("forgets the oldest node past the cap", () => {
    const it_ = fixture();
    for (let index = 0; index <= MAX_MOD_HELLOS; index += 1) {
      it_.service.recordModHello({
        ...(parseModHello(
          { ...HELLO, nodeId: `node-${index}` },
          "2026-10-10T00:00:00.000Z",
        ) as ModHello),
      });
    }
    const sessions = it_.service.modSessions();
    expect(sessions).toHaveLength(MAX_MOD_HELLOS);
    expect(sessions[0]?.nodeId).toBe("node-1");
  });

  it("leaves GET /node/overlay to M2: in the table, answered 501", async () => {
    const it_ = fixture();
    const answer = (await it_.server.router.dispatch("GET", "/node/overlay", {
      method: "GET",
      path: "/node/overlay",
      query: new URLSearchParams(),
      headers: { "x-armadra-hook-token": it_.bearer },
      body: Buffer.alloc(0),
      raw: undefined as never,
      json: <T>(): T => null as T,
    })) as { status: number };
    expect(answer.status).toBe(501);
  });
});
