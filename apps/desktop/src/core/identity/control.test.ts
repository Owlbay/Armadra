import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/open";
import {
  TICKET_MESSAGE,
  controlSocketPath,
  startControlChannel,
  startTicketIpc,
} from "./control";
import { IdentityService } from "./service";
import { IdentityStore } from "./store";
import { tempDir } from "../testing/temp-dir";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const INSTANCE = "0123456789abcdef0123456789abcdef";
const ORIGIN = "http://127.0.0.1:1420";

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed.
    }
  }
});

async function channel() {
  const dataDir = tempDir("armadra-control-");
  const opened = openDatabase({
    file: join(dataDir, "canvas.db"),
    migrationsDir,
  });
  closing.push(opened.close);
  const service = new IdentityService(
    new IdentityStore(opened.database),
    INSTANCE,
  );
  const started = await startControlChannel({
    service,
    instanceId: INSTANCE,
    dataDir,
  });
  if (started === undefined) throw new Error("no control channel");
  closing.push(() => started.close());
  return { dataDir, service, socket: controlSocketPath(dataDir) };
}

async function ask(
  socketPath: string,
  body: unknown,
  path = "/control/identity/ticket",
  method = "POST",
): Promise<{ status: number; body: unknown }> {
  const { request } = await import("node:http");
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((done, fail) => {
    const call = request(
      {
        socketPath,
        path,
        method,
        headers: { "content-length": payload.length },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
          }),
        );
      },
    );
    call.on("error", fail);
    call.end(payload);
  });
}

describe.skipIf(process.platform === "win32")(
  "the private control channel",
  () => {
    it("is a socket only this user can open", async () => {
      const fixture = await channel();
      const stats = statSync(fixture.socket);
      expect(stats.isSocket()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("mints a ticket in the shape the page already accepts", async () => {
      const fixture = await channel();
      const answer = await ask(fixture.socket, {
        origin: ORIGIN,
        deviceName: "本机桌面",
      });
      expect(answer.status).toBe(200);
      const ticket = answer.body as Record<string, string>;
      expect(ticket.hostId).toBe(fixture.service.hostId());
      expect(ticket.hostInstanceId).toBe(INSTANCE);
      expect(ticket.origin).toBe(ORIGIN);
      expect(ticket.ticket).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
      // 毫秒是十进制字符串，因为页面拿 bigint 比较它。
      expect(ticket.expiresAtUnixMs).toMatch(/^\d+$/);
    });

    it("mints a fresh ticket every time, and the old one still works once", async () => {
      const fixture = await channel();
      const first = (
        await ask(fixture.socket, {
          origin: ORIGIN,
          deviceName: "本机桌面",
        })
      ).body as Record<string, string>;
      const second = (
        await ask(fixture.socket, {
          origin: ORIGIN,
          deviceName: "本机桌面",
        })
      ).body as Record<string, string>;
      expect(first.ticket).not.toBe(second.ticket);
      const spend = (ticket: string) =>
        fixture.service.consumeBootstrap({
          ticket,
          hostId: fixture.service.hostId(),
          instanceId: INSTANCE,
          origin: ORIGIN,
        });
      expect(() => spend(first.ticket as string)).not.toThrow();
      expect(() => spend(first.ticket as string)).toThrow();
      expect(() => spend(second.ticket as string)).not.toThrow();
    });

    it("refuses an origin no shell could present", async () => {
      const fixture = await channel();
      const answer = await ask(fixture.socket, {
        origin: "https://example.com",
        deviceName: "本机桌面",
      });
      expect(answer.status).toBe(400);
    });

    it("refuses a body that is not a ticket request", async () => {
      const fixture = await channel();
      expect((await ask(fixture.socket, { origin: ORIGIN })).status).toBe(400);
      expect(
        (await ask(fixture.socket, { origin: ORIGIN, deviceName: " x" }))
          .status,
      ).toBe(400);
    });

    it("answers nothing but its one method", async () => {
      const fixture = await channel();
      expect((await ask(fixture.socket, {}, "/control/anything")).status).toBe(
        404,
      );
      expect(
        (await ask(fixture.socket, {}, "/control/identity/ticket", "GET"))
          .status,
      ).toBe(405);
    });
  },
);

/**
 * Windows 上的取票路：fork 的 IPC 通道（契约 §3.2，安全审查 L9）。与平台无关
 * 地验——通道是注入的。
 */
describe("fork 的 IPC 通道上签票", () => {
  function ipc() {
    const dataDir = tempDir("armadra-control-ipc-");
    const opened = openDatabase({
      file: join(dataDir, "canvas.db"),
      migrationsDir,
    });
    closing.push(opened.close);
    const service = new IdentityService(
      new IdentityStore(opened.database),
      INSTANCE,
    );
    const listeners: ((message: unknown) => void)[] = [];
    const sent: unknown[] = [];
    const channel = {
      connected: true,
      send: (message: unknown) => {
        sent.push(message);
        return true;
      },
      on: (_event: "message", listener: (message: unknown) => void) => {
        listeners.push(listener);
      },
    };
    expect(startTicketIpc({ service, instanceId: INSTANCE }, channel)).toBe(
      true,
    );
    const deliver = (message: unknown) => {
      for (const listener of listeners) listener(message);
    };
    return { service, sent, deliver };
  }

  it("答私有通道同一个形状，按 id 对上；别的消息不理", () => {
    const { service, sent, deliver } = ipc();
    deliver({ type: "armadra:secrets", id: 1, op: "seal", data: "" });
    expect(sent).toEqual([]);
    deliver({
      type: TICKET_MESSAGE,
      id: 7,
      origin: ORIGIN,
      deviceName: "本机桌面",
    });
    expect(sent).toHaveLength(1);
    const answer = sent[0] as {
      type: string;
      id: number;
      status: number;
      body: Record<string, unknown>;
    };
    expect(answer.type).toBe(TICKET_MESSAGE);
    expect(answer.id).toBe(7);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      hostId: service.hostId(),
      hostInstanceId: INSTANCE,
      origin: ORIGIN,
    });
    expect(String(answer.body.ticket)).toMatch(
      /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/,
    );
  });

  it("壳呈现不了的来源照样拒", () => {
    const { sent, deliver } = ipc();
    deliver({
      type: TICKET_MESSAGE,
      id: 1,
      origin: "https://example.com",
      deviceName: "x",
    });
    expect((sent[0] as { status: number }).status).toBe(400);
  });

  it("不是 fork 出来的进程（没有通道）不开", () => {
    expect(
      startTicketIpc(
        {
          service: undefined as never,
          instanceId: INSTANCE,
        },
        { on: () => undefined },
      ),
    ).toBe(false);
  });
});
