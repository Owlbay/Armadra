import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { CdpConnection } from "./connection";

/** The wire trace a stalled command is explained with. */
describe("the CDP wire trace", () => {
  function wire(trace: boolean) {
    const toBrowser = new PassThrough();
    const toClient = new PassThrough();
    const sent: { id: number; method: string }[] = [];
    toBrowser.on("data", (chunk: Buffer) => {
      for (const document of chunk.toString("utf8").split("\0"))
        if (document) sent.push(JSON.parse(document));
    });
    const connection = new CdpConnection(toBrowser, toClient, { trace });
    const answer = (id: number) =>
      toClient.write(`${JSON.stringify({ id, result: { secret: "x" } })}\0`);
    const event = (method: string) =>
      toClient.write(
        `${JSON.stringify({ method, params: { url: "https://private" }, sessionId: "s1" })}\0`,
      );
    const raw = (message: unknown) =>
      toClient.write(`${JSON.stringify(message)}\0`);
    return { connection, sent, answer, event, raw };
  }
  const tick = () => new Promise((done) => setTimeout(done, 10));

  it("records methods and ids, never params or results", async () => {
    const { connection, sent, answer, event } = wire(true);
    const reply = connection.send(
      "Page.navigate",
      { url: "https://private" },
      "s1",
    );
    await tick();
    event("Page.lifecycleEvent");
    answer(sent[0]!.id);
    await reply;
    const trace = connection.traced();
    expect(trace.map((entry) => `${entry.kind} ${entry.method}`)).toEqual([
      "> Page.navigate",
      "~ Page.lifecycleEvent",
      "< Page.navigate",
    ]);
    expect(JSON.stringify(trace)).not.toContain("private");
    expect(JSON.stringify(trace)).not.toContain("secret");
    connection.close();
  });

  it("lists what is still waiting, and stays empty when tracing is off", async () => {
    const quiet = wire(false);
    void quiet.connection
      .send("Input.dispatchMouseEvent", {}, "s1")
      .catch(() => undefined);
    await tick();
    expect(quiet.connection.traced()).toEqual([]);
    expect(quiet.connection.pending()).toEqual([
      expect.objectContaining({
        method: "Input.dispatchMouseEvent",
        sessionId: "s1",
      }),
    ]);
    quiet.connection.close();
  });

  it("names the child session a target event brings, never its address", async () => {
    const { connection, raw } = wire(true);
    raw({
      method: "Target.attachedToTarget",
      sessionId: "page",
      params: {
        sessionId: "child-1",
        targetInfo: { type: "iframe", url: "https://private/frame" },
      },
    });
    raw({
      method: "Target.detachedFromTarget",
      sessionId: "page",
      params: { sessionId: "child-1" },
    });
    await tick();
    expect(connection.traced().map((entry) => entry.child)).toEqual([
      "child-1:iframe",
      "child-1",
    ]);
    expect(JSON.stringify(connection.traced())).not.toContain("private");
    connection.close();
  });

  it("marks a command that timed out", async () => {
    const { connection } = wire(true);
    await expect(
      connection.send("Runtime.evaluate", {}, "s1", 20),
    ).rejects.toThrow(/did not answer in time/);
    expect(connection.traced().at(-1)).toMatchObject({
      kind: "x",
      method: "Runtime.evaluate",
    });
    expect(connection.pending()).toEqual([]);
    connection.close();
  });
});
