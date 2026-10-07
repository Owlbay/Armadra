import { statSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { tempDir } from "../testing/temp-dir";
import { startControllerChannel } from "./channel";
import { CONTROLLER_PATH, CONTROLLER_PROTOCOL } from "@armadra/shared";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

async function fixture() {
  const directory = tempDir("armadra-controller-");
  const channel = await startControllerChannel({
    dataDir: directory,
    instanceId: "test-instance",
    dispatch: async (input) => ({ method: input.method }),
  });
  if (!channel) throw new Error("Unix socket required");
  closing.push(() => channel.close());
  return { directory, socket: join(directory, "controller.sock") };
}

function ask(socketPath: string, input: unknown, headers = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path: CONTROLLER_PATH,
        method: "POST",
        headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    // A socket error after the response (the request no longer listens) must
    // not become an uncaught exception; errors before it still reject below.
    call.on("socket", (socket) => socket.on("error", () => {}));
    call.on("error", reject);
    call.end(JSON.stringify(input));
  });
}

it("does not open a Windows pipe or TCP fallback", async () => {
  let dispatched = false;
  expect(
    await startControllerChannel(
      {
        dataDir: "unused",
        instanceId: "test",
        dispatch: async () => {
          dispatched = true;
        },
      },
      "win32",
    ),
  ).toBeUndefined();
  expect(dispatched).toBe(false);
});

// Unix transport and permission scenarios only exist on the supported platforms.
if (process.platform !== "win32") {
  it("uses a 0600 socket and 0700 directory; verifies the instance before dispatch", async () => {
    const { socket, directory } = await fixture();
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    const input = {
      schemaVersion: CONTROLLER_PROTOCOL,
      requestId: "one",
      instanceId: "test-instance",
      method: "doctor",
      params: {},
    };
    expect((await ask(socket, input)).body).toMatchObject({
      ok: true,
      requestId: "one",
      data: { method: "doctor" },
    });
    expect(
      (await ask(socket, { ...input, instanceId: "stale" })).body.error.code,
    ).toBe("instance_mismatch");
    expect(
      (await ask(socket, { ...input, schemaVersion: 9 })).body.error.code,
    ).toBe("protocol_mismatch");
  });

  it("rejects browser requests, unknown methods, malformed and oversized bodies", async () => {
    const { socket } = await fixture();
    const input = {
      schemaVersion: 1,
      requestId: "one",
      instanceId: "test-instance",
      method: "doctor",
      params: {},
    };
    expect(
      (await ask(socket, input, { Origin: "http://localhost" })).status,
    ).toBe(403);
    // Rejected before the body is read: the body is still drained, so the
    // client reads the 403 rather than failing its write.
    expect(
      (
        await ask(
          socket,
          { ...input, params: { text: "a".repeat(200_000) } },
          { Origin: "http://localhost" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await ask(socket, { ...input, method: "shell.exec" })).body.error.code,
    ).toBe("unknown_method");
    expect((await ask(socket, null)).status).toBe(400);
    expect(
      (await ask(socket, { ...input, params: { text: "a".repeat(270_000) } }))
        .status,
    ).toBe(413);
    await expect(
      ask(socket, { ...input, params: { text: "a".repeat(1_200_000) } }),
    ).rejects.toThrow();
  });
}
