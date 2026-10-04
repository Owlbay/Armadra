/**
 * 邮件通道对 dev-stack 的 `mailpit` 容器（`pnpm dev-stack up mailpit`，SMTP
 * 1025、REST 8025）走一遍真 SMTP：`smtpSender` 发、Mailpit 的 REST 读回来，
 * 断言收件人、主题与正文就是 `compose` 写的那两行。
 *
 * `ARMADRA_DEV_STACK=1` 才跑；否则 skipped。地址可用 `ARMADRA_MAILPIT_SMTP` /
 * `ARMADRA_MAILPIT_API` 换。
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compose, linkFor } from "./service";
import { parseSmtpUrl, smtpSender } from "./smtp";

const enabled = process.env.ARMADRA_DEV_STACK === "1";
const smtp =
  process.env.ARMADRA_MAILPIT_SMTP?.trim() ||
  // Mailpit 收任何 AUTH（`MP_SMTP_AUTH_ACCEPT_ANY`）：口令走密钥引用那条路。
  "smtp://bot@armadra.test:secret://armadra-smtp@127.0.0.1:1025";
const api = process.env.ARMADRA_MAILPIT_API?.trim() || "http://127.0.0.1:8025";

interface Summary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

async function waitFor(address: string): Promise<Summary> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const response = await fetch(
      `${api}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const listed = (await response.json()) as { messages: Summary[] };
    const found = listed.messages.find((message) =>
      message.To.some((to) => to.Address === address),
    );
    if (found !== undefined) return found;
    if (Date.now() > deadline)
      throw new Error(`Mailpit 没收到给 ${address} 的信`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

describe.skipIf(!enabled)("dev-stack：mailpit（§28）", () => {
  it("邀请邮件经真 SMTP 到达，正文只有链接与过期时间", async () => {
    const parsed = parseSmtpUrl(smtp);
    if (!parsed.ok) throw new Error(parsed.reason);
    const send = smtpSender(parsed.config, async () => "any-password");
    const to = `invitee-${randomBytes(4).toString("hex")}@armadra.test`;
    const token = `${randomBytes(16).toString("hex")}.${randomBytes(32).toString("base64url")}`;
    const message = compose(
      "invitation",
      "zh",
      linkFor("invitation", "https://armadra.example.test", token),
      Date.UTC(2026, 9, 11, 8, 0),
    );
    await send({ from: parsed.config.settings.from, to, ...message });

    const summary = await waitFor(to);
    expect(summary.Subject).toBe("Armadra 邀请");
    const full = (await (
      await fetch(`${api}/api/v1/message/${summary.ID}`)
    ).json()) as { Text: string; From: { Address: string }; HTML: string };
    expect(full.From.Address).toBe("bot@armadra.test");
    expect(full.HTML).toBe("");
    expect(full.Text.replace(/\r\n/g, "\n")).toBe(message.text);
    await fetch(`${api}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: [summary.ID] }),
    });
  });
});
