import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodedBody,
  startFakeSmtp,
} from "../../desktop/src/core/mail/fake-smtp.fixture";
import { tempDir } from "../../desktop/src/core/testing/temp-dir";
import { serverSecrets } from "./secrets";
import { serve } from "./serve";

/**
 * 邮件通道的装配级用例（契约 §28）：`serve --smtp-url` 把配置交给 core 的邮件域，
 * 口令是 `secret://armadra-smtp`（服务器壳的密钥后端里现取），配对后的管理员签
 * 一张邀请、经 Gateway（Cookie + CSRF）调 `POST /api/mail/invitation`，信到 SMTP
 * 时正文里的链接就是这台服务器的来源加 `#invite=<令牌>`。
 *
 * SMTP 用进程内的假服务器；`ARMADRA_DEV_STACK=1` 时再对 Mailpit 走一遍，经它的
 * REST 读回收件。
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "../../desktop/src/core/db/migrations");
const devStack = process.env.ARMADRA_DEV_STACK === "1";
const mailpitApi =
  process.env.ARMADRA_MAILPIT_API?.trim() || "http://127.0.0.1:8025";

interface Answer {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function call(
  origin: string,
  path: string,
  options: {
    method?: string;
    cookie?: string;
    csrf?: string;
    body?: unknown;
  } = {},
): Promise<Answer> {
  const url = new URL(path, origin);
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((done, failed) => {
    const headers: Record<string, string> = { origin };
    if (options.cookie !== undefined) headers.cookie = options.cookie;
    if (options.csrf !== undefined) headers["x-armadra-csrf"] = options.csrf;
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const client = httpsRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method ?? "GET",
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    client.on("error", failed);
    if (payload !== undefined) client.write(payload);
    client.end();
  });
}

const stopping: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stopping.splice(0)) await stop();
});

const env = {
  ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
  ARMADRA_LOG: "error",
};

async function start(smtpUrl: string, smtpFrom?: string) {
  const dataDir = tempDir("armadra-server-mail-");
  const webRoot = tempDir("armadra-web-");
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>a</title>");
  // 口令先放进这台服务器的密钥后端：与 `secrets set armadra-smtp` 同一个后端
  // （core 按进程环境选后端，用例环境里是 `ARMADRA_SECRET_BACKEND=file`）。
  await serverSecrets(dataDir, { ...process.env, ...env }).set(
    "armadra-smtp",
    "s3cret-smtp",
  );
  const running = await serve({
    listen: { host: "127.0.0.1", port: 0 },
    publicOrigins: [],
    dataDir,
    webRoot,
    deviceName: "测试设备",
    pairing: true,
    smtpUrl,
    smtpFrom,
    env,
    stdout: () => {},
    moduleDir: here,
  });
  stopping.push(() => running.stop());
  const origin = running.origin;
  const paired = await call(origin, "/api/identity/pair", {
    method: "POST",
    body: { ticket: running.pairingTicket },
  });
  expect(paired.status).toBe(200);
  const cookie = (paired.headers["set-cookie"] as string[])
    .map((value) => (value.split(";")[0] as string).trim())
    .join("; ");
  const csrf = JSON.parse(paired.body).csrfToken as string;
  const issued = await call(origin, "/api/identity/invitations", {
    method: "POST",
    cookie,
    csrf,
    body: { role: "viewer", targetWorkspaceId: "default" },
  });
  expect(issued.status).toBe(201);
  const invitation = JSON.parse(issued.body) as {
    invitationId: string;
    token: string;
  };
  return { origin, cookie, csrf, invitation };
}

describe("serve --smtp-url", () => {
  it("配置不对是启动时的错", async () => {
    await expect(
      serve({
        listen: { host: "127.0.0.1", port: 0 },
        publicOrigins: [],
        dataDir: tempDir("armadra-server-mail-"),
        webRoot: tempDir("armadra-web-"),
        deviceName: "x",
        pairing: false,
        smtpUrl: "http://mail.example.com",
        env,
        stdout: () => {},
        moduleDir: here,
      }),
    ).rejects.toThrow(/--smtp-url/);
    await expect(
      serve({
        listen: { host: "127.0.0.1", port: 0 },
        publicOrigins: [],
        dataDir: tempDir("armadra-server-mail-"),
        webRoot: tempDir("armadra-web-"),
        deviceName: "x",
        pairing: false,
        smtpFrom: "a@b.test",
        env,
        stdout: () => {},
        moduleDir: here,
      }),
    ).rejects.toThrow(/--smtp-from/);
  });

  it("管理员发邀请邮件：AUTH 用密钥后端里的口令，正文是本机来源的邀请链接", async () => {
    const smtp = await startFakeSmtp();
    stopping.push(smtp.close);
    const { origin, cookie, csrf, invitation } = await start(
      `smtp://bot@armadra.test:secret://armadra-smtp@127.0.0.1:${smtp.port}`,
    );

    const status = await call(origin, "/api/mail/status", { cookie });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({
      configured: true,
      from: "bot@armadra.test",
    });

    const body = {
      invitationId: invitation.invitationId,
      token: invitation.token,
      to: "invitee@armadra.test",
      locale: "en",
    };
    // 写方法没有 CSRF：Gateway 的准入先挡下，信不发。
    const withoutCsrf = await call(origin, "/api/mail/invitation", {
      method: "POST",
      cookie,
      body,
    });
    expect(withoutCsrf.status).toBe(403);
    expect(smtp.received).toHaveLength(0);

    const sent = await call(origin, "/api/mail/invitation", {
      method: "POST",
      cookie,
      csrf,
      body,
    });
    expect(sent.status).toBe(200);
    expect(JSON.parse(sent.body)).toEqual({ sent: true });
    expect(smtp.received).toHaveLength(1);
    const mail = smtp.received[0];
    expect(mail?.auth).toBe("\0bot@armadra.test\0s3cret-smtp");
    expect(mail?.to).toEqual(["RCPT TO:<invitee@armadra.test>"]);
    expect(mail?.data).toMatch(/^Subject: Armadra invitation$/m);
    const text = decodedBody(mail?.data ?? "");
    expect(text.startsWith(`${origin}/#invite=${invitation.token}\n\n`)).toBe(
      true,
    );
    expect(text).toMatch(/expires at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.\n?$/);
  });

  it.skipIf(!devStack)("dev-stack：信到 Mailpit", async () => {
    const { origin, cookie, csrf, invitation } = await start(
      "smtp://bot@armadra.test:secret://armadra-smtp@127.0.0.1:1025",
    );
    const to = `invitee-${randomBytes(4).toString("hex")}@armadra.test`;
    const sent = await call(origin, "/api/mail/invitation", {
      method: "POST",
      cookie,
      csrf,
      body: {
        invitationId: invitation.invitationId,
        token: invitation.token,
        to,
        locale: "zh",
      },
    });
    expect(sent.status).toBe(200);
    const deadline = Date.now() + 10_000;
    let found: { ID: string; Subject: string } | undefined;
    while (found === undefined && Date.now() < deadline) {
      const listed = (await (
        await fetch(
          `${mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        )
      ).json()) as { messages: { ID: string; Subject: string }[] };
      found = listed.messages[0];
      if (found === undefined)
        await new Promise((done) => setTimeout(done, 200));
    }
    expect(found?.Subject).toBe("Armadra 邀请");
    const full = (await (
      await fetch(`${mailpitApi}/api/v1/message/${found?.ID}`)
    ).json()) as { Text: string };
    expect(full.Text).toContain(`${origin}/#invite=${invitation.token}`);
    await fetch(`${mailpitApi}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: [found?.ID] }),
    });
  });
});
