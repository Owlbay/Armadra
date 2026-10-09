import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { tempDir } from "../testing/temp-dir";
import {
  controllerSocketPath,
  maxSocketPath,
  startControllerChannel,
} from "./channel";
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
  const label = `${JSON.stringify(input)?.length ?? 0}B ${JSON.stringify(headers)}`;
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path: CONTROLLER_PATH,
        method: "POST",
        headers,
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
    call.on("error", (error) =>
      reject(new Error(`${label}: ${error.message}`, { cause: error })),
    );
    call.end(JSON.stringify(input));
  });
}

// 路径按 POSIX 拼（Windows 上不开这条通道）。
it.skipIf(process.platform === "win32")(
  "keeps the socket in the data directory while it fits sun_path, else moves it to a short per-directory path",
  () => {
    expect(controllerSocketPath("/data", "darwin", "/tmp")).toBe(
      "/data/controller.sock",
    );
    const deep = `/${"d".repeat(100)}`;
    const moved = controllerSocketPath(deep, "darwin", "/tmp");
    expect(moved).toMatch(/^\/tmp\/armadra-ctl-[0-9a-f]{16}\/c\.sock$/);
    expect(Buffer.byteLength(moved)).toBeLessThanOrEqual(
      maxSocketPath("darwin"),
    );
    // 同一个数据目录总落在同一处，不同的数据目录互不相撞。
    expect(controllerSocketPath(deep, "darwin", "/tmp")).toBe(moved);
    expect(controllerSocketPath(`${deep}2`, "darwin", "/tmp")).not.toBe(moved);
    // Linux 的 sun_path 多 4 个字节。
    const edge = `/${"e".repeat(105 - "/controller.sock".length)}`;
    expect(controllerSocketPath(edge, "linux", "/tmp")).toBe(
      `${edge}/controller.sock`,
    );
    expect(controllerSocketPath(edge, "darwin", "/tmp")).not.toBe(
      `${edge}/controller.sock`,
    );
  },
);

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
  it("binds a 0600 socket in a 0700 directory of ours when the data directory is too deep", async () => {
    const directory = join(tempDir("armadra-controller-"), "y".repeat(90));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const channel = await startControllerChannel({
      dataDir: directory,
      instanceId: "test-instance",
      dispatch: async (input) => ({ method: input.method }),
    });
    if (!channel || channel.spec.kind !== "unix")
      throw new Error("Unix socket required");
    closing.push(() => channel.close());
    const socket = channel.spec.path;
    expect(socket.startsWith(directory)).toBe(false);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(socket)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(socket)).uid).toBe(process.getuid?.());
  });

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
