import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { install as installFiles } from "./routes";
import { releaseWorkspace } from "./watch";
import {
  MEDIA_TICKET_IDLE_MS,
  MEDIA_TICKET_MAX_MS,
  MediaTickets,
  byteHeaders,
  inlineType,
  mediaTicketOf,
  parseRange,
} from "./media";
import { installContract } from "../http/rpc";
import { installRouteGuard, resetRouteGuard } from "../identity/gate";
import { mediaPath } from "../identity/transport";
import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";

describe("parseRange", () => {
  it("认单个区间、开放区间与后缀区间", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("起点越过文件尾是 416，没有头、多个区间与坏形状按整份", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeUndefined();
    expect(parseRange("items=0-1", 100)).toBeUndefined();
    expect(parseRange("bytes=9-3", 100)).toBeUndefined();
  });
});

describe("MediaTickets", () => {
  it("闲置期内可多次用、每次续期，闲置或签出过久作废", () => {
    let now = 0;
    const tickets = new MediaTickets(() => now);
    const grant = {
      workspaceId: "w",
      path: "a.mp4",
      disposition: "inline" as const,
      identity: undefined,
    };
    const { ticket } = tickets.issue(grant);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    now += MEDIA_TICKET_IDLE_MS - 1;
    expect(tickets.use(ticket)?.path).toBe("a.mp4");
    now += MEDIA_TICKET_IDLE_MS - 1;
    expect(tickets.use(ticket)?.path).toBe("a.mp4");
    now += MEDIA_TICKET_IDLE_MS;
    expect(tickets.use(ticket)).toBeUndefined();

    const again = tickets.issue(grant).ticket;
    for (let at = 0; at < MEDIA_TICKET_MAX_MS; at += MEDIA_TICKET_IDLE_MS / 2) {
      now += MEDIA_TICKET_IDLE_MS / 2;
      tickets.use(again);
    }
    expect(tickets.use(again)).toBeUndefined();
    expect(tickets.use("nope")).toBeUndefined();
  });

  it("路径里只认一段形状对的票", () => {
    expect(mediaTicketOf("/api/media/abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(mediaTicketOf("/api/media/short")).toBe("");
    expect(mediaTicketOf("/api/media/abcdefghijklmnop/x")).toBe("");
    expect(mediaPath("/api/media/abc")).toBe(true);
    expect(mediaPath("/api/media/abc/def")).toBe(false);
    expect(mediaPath("/api/mediax/abc")).toBe(false);
  });
});

describe("byteHeaders", () => {
  it("只有图片（除 SVG）与音视频内联，其余附件", () => {
    expect(inlineType("clip.mp4")).toBe("video/mp4");
    expect(inlineType("song.mp3")).toBe("audio/mpeg");
    expect(inlineType("photo.png")).toBe("image/png");
    expect(inlineType("logo.svg")).toBeUndefined();
    expect(inlineType("page.html")).toBeUndefined();
    expect(inlineType("doc.pdf")).toBeUndefined();
    const inline = byteHeaders("clip.mp4", "inline");
    expect(inline["content-type"]).toBe("video/mp4");
    expect(inline["content-disposition"]).toMatch(/^inline;/);
    const html = byteHeaders("page.html", "inline");
    expect(html["content-type"]).toBe("application/octet-stream");
    expect(html["content-disposition"]).toMatch(/^attachment;/);
    expect(html["content-security-policy"]).toContain("sandbox");
    expect(
      byteHeaders("clip.mp4", "attachment")["content-disposition"],
    ).toMatch(/^attachment;/);
  });
});

describe("媒体票与 Range（HTTP）", () => {
  let core: Fixture;
  let base: string;
  let id: string;
  const bytes = Buffer.from(
    Array.from({ length: 1000 }, (_, index) => index % 251),
  );

  beforeAll(async () => {
    core = fixture([installWorkspaces, installFiles]);
    installContract(core.server, {
      validateOutput: true,
      platform: core.platform,
    });
    const listener = core.server.createListener();
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const root = join(core.directory, "project");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "clip.mp4"), bytes);
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    id = (
      (
        await core.call("POST", "/api/workspaces", {
          name: "media",
          rootPath: root,
        })
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    resetRouteGuard();
    releaseWorkspace(id);
    await core.server.close();
    core.close();
  });

  const ticket = async (
    path: string,
    disposition?: "inline" | "attachment",
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${base}/api/rpc/files/mediaTicket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: {
          workspaceId: id,
          path,
          ...(disposition ? { disposition } : {}),
        },
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return {
      status: response.status,
      body: (response.ok ? body.json : body) as Record<string, unknown>,
    };
  };

  it("换票答相对地址，URL 里没有文件路径", async () => {
    const answer = await ticket("clip.mp4");
    expect(answer.status).toBe(200);
    const url = answer.body.url as string;
    expect(url).toMatch(/^\/api\/media\/[A-Za-z0-9_-]{43}$/);
    expect(url).not.toContain("clip");
    expect(answer.body.size).toBe(1000);
    expect(answer.body.mimeType).toBe("video/mp4");
    expect(Date.parse(answer.body.expiresAt as string)).toBeGreaterThan(
      Date.now(),
    );
  });

  it("不存在的文件不签票", async () => {
    const answer = await ticket("missing.mp4");
    expect(answer.status).toBeGreaterThanOrEqual(400);
  });

  it("整份 200、Range 206、越界 416、HEAD 只给头", async () => {
    const { url } = (await ticket("clip.mp4")).body as { url: string };
    const whole = await fetch(`${base}${url}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);

    const part = await fetch(`${base}${url}`, {
      headers: { range: "bytes=100-199" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(part.headers.get("content-length")).toBe("100");
    expect(
      Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200)),
    ).toBe(true);

    const tail = await fetch(`${base}${url}`, {
      headers: { range: "bytes=-10" },
    });
    expect(tail.status).toBe(206);
    expect(
      Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(990)),
    ).toBe(true);

    const beyond = await fetch(`${base}${url}`, {
      headers: { range: "bytes=5000-" },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */1000");

    const head = await fetch(`${base}${url}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");

    const post = await fetch(`${base}${url}`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("下载用法与不能内联的类型都是附件", async () => {
    const download = (await ticket("clip.mp4", "attachment")).body as {
      url: string;
    };
    const one = await fetch(`${base}${download.url}`);
    expect(one.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(one.headers.get("content-type")).toBe("application/octet-stream");
    await one.arrayBuffer();
    const html = (await ticket("page.html")).body as { url: string };
    const two = await fetch(`${base}${html.url}`);
    expect(two.headers.get("content-type")).toBe("application/octet-stream");
    expect(two.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(two.headers.get("x-content-type-options")).toBe("nosniff");
    await two.arrayBuffer();
  });

  it("不认识的票 404，体是 { code, message }", async () => {
    const response = await fetch(
      `${base}/api/media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("not_found");
    expect(typeof body.message).toBe("string");
  });

  it("路由门按签票文件的下载路由判：被拒时 403", async () => {
    const { url } = (await ticket("clip.mp4")).body as { url: string };
    const seen: string[] = [];
    installRouteGuard((request) => {
      seen.push(`${request.method} ${request.path}`);
      // 真实的门对 `/api/media/` 放行（SELF_GUARDED），对下载路由按权限判。
      return { allowed: !request.path.endsWith("/file-download") };
    });
    try {
      const response = await fetch(`${base}${url}`);
      expect(response.status).toBe(403);
      expect(seen).toContain(`GET /api/workspaces/${id}/file-download`);
    } finally {
      resetRouteGuard();
    }
  });

  it("file-download 也认 Range", async () => {
    const path = `/api/workspaces/${id}/file-download?path=clip.mp4`;
    const part = await fetch(`${base}${path}`, {
      headers: { range: "bytes=10-19" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(part.headers.get("content-type")).toBe("application/octet-stream");
    expect(
      Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20)),
    ).toBe(true);
    const whole = await fetch(`${base}${path}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    const beyond = await fetch(`${base}${path}`, {
      headers: { range: "bytes=2000-" },
    });
    expect(beyond.status).toBe(416);
  });
});
