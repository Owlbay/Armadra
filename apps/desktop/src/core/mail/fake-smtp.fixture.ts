import { type Server, type Socket, createServer } from "node:net";

/**
 * 一台够 nodemailer 用的假 SMTP（只给用例）：EHLO、AUTH PLAIN、MAIL、RCPT、
 * DATA、QUIT，监听回环的随机端口。`received` 记每封信的 AUTH 明文（`\0用户\0口令`）、
 * 信封与 DATA 原文。
 */

export interface ReceivedMail {
  readonly auth: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
}

export interface FakeSmtp {
  readonly port: number;
  readonly received: ReceivedMail[];
  close(): Promise<void>;
}

export async function startFakeSmtp(
  options: { rejectAuth?: boolean } = {},
): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let inData = false;
    let auth = "";
    let from = "";
    let to: string[] = [];
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 fake ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push({ auth, from, to, data: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          from = "";
          to = [];
          reply("250 queued");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const verb = line.split(" ")[0]?.toUpperCase();
        if (verb === "EHLO") {
          reply("250-fake");
          reply("250-AUTH PLAIN");
          reply("250 8BITMIME");
        } else if (verb === "AUTH") {
          if (options.rejectAuth === true) {
            reply("535 authentication failed");
            continue;
          }
          auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString(
            "utf8",
          );
          reply("235 ok");
        } else if (verb === "MAIL") {
          from = line;
          reply("250 ok");
        } else if (verb === "RCPT") {
          to.push(line);
          reply("250 ok");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (verb === "QUIT") {
          reply("221 bye");
          socket.end();
        } else {
          reply("250 ok");
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    received,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/** DATA 原文里的正文解出来（quoted-printable 或 base64），换行归一成 `\n`。 */
export function decodedBody(data: string): string {
  const separator = data.indexOf("\r\n\r\n");
  const head = data.slice(0, separator);
  const body = data.slice(separator + 4);
  const decoded = /Content-Transfer-Encoding: base64/i.test(head)
    ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8")
    : Buffer.from(
        body
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          ),
        "latin1",
      ).toString("utf8");
  return decoded.replace(/\r\n/g, "\n");
}
