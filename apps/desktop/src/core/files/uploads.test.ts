import { existsSync, readFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_AGENT_UPLOAD_BYTES } from "@armadra/shared";

import { type Fixture, fixture } from "../workspaces/fixture";
import { install as installWorkspaces } from "../workspaces/routes";
import { install } from "./upload-routes";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  UPLOADS_DIRECTORY,
  UPLOAD_TTL_MS,
  pruneUploads,
  resolveUpload,
  sanitizeUploadName,
  storeUpload,
} from "./uploads";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const WS = "0190a0b0-0000-7000-8000-000000000001";

describe("sanitizeUploadName", () => {
  it("keeps only safe characters and the extension", () => {
    expect(sanitizeUploadName("截图 2026-10-10 下午3.04.12.png")).toBe(
      "2026-10-10_3.04.12.png",
    );
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("C:\\Users\\a\\b c.txt")).toBe("b_c.txt");
    expect(sanitizeUploadName(".env")).toBe("env");
    expect(sanitizeUploadName("con.txt")).toBe("_con.txt");
  });

  it("names a clipboard image after its type", () => {
    expect(sanitizeUploadName("", "image/png")).toBe("image.png");
    expect(sanitizeUploadName(undefined, "image/jpeg")).toBe("image.jpg");
    expect(sanitizeUploadName("", "application/octet-stream")).toBe("file");
  });

  it("caps the length but keeps the extension", () => {
    const name = sanitizeUploadName(`${"a".repeat(200)}.tar.gz`);
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith(".gz")).toBe(true);
  });
});

describe("the upload store", () => {
  let core: Fixture;
  beforeEach(() => {
    core = fixture([]);
  });
  afterEach(() => core.close());

  it("stores under the data directory and resolves by workspace and id", () => {
    const stored = storeUpload(core.directory, WS, "shot.png", "", PNG);
    expect(stored.id).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.path).toBe(
      join(core.directory, UPLOADS_DIRECTORY, WS, stored.id, "shot.png"),
    );
    expect(stored.mimeType).toBe("image/png");
    expect(stored.bytes).toBe(PNG.byteLength);
    expect(readFileSync(stored.path)).toEqual(PNG);
    expect(resolveUpload(core.directory, WS, stored.id)).toEqual(stored);
    // 另一个工作空间认不出这个 id。
    expect(() =>
      resolveUpload(
        core.directory,
        "0190a0b0-0000-7000-8000-000000000002",
        stored.id,
      ),
    ).toThrow(/not found/);
    expect(() => resolveUpload(core.directory, WS, "../x")).toThrow(/invalid/);
    expect(() => storeUpload(core.directory, "../x", "a", "", PNG)).toThrow(
      /invalid/,
    );
  });

  it("refuses empty and oversized bodies", () => {
    expect(() =>
      storeUpload(core.directory, WS, "a.txt", "", Buffer.alloc(0)),
    ).toThrow(/empty/);
    expect(() =>
      storeUpload(
        core.directory,
        WS,
        "a.bin",
        "",
        Buffer.alloc(MAX_AGENT_UPLOAD_BYTES + 1),
      ),
    ).toThrow(/too large/);
  });

  it("prunes expired uploads and the oldest over the workspace cap", () => {
    const old = storeUpload(
      core.directory,
      WS,
      "old.txt",
      "",
      Buffer.from("o"),
    );
    const stale = new Date(Date.now() - UPLOAD_TTL_MS - 60_000);
    utimesSync(dirname(old.path), stale, stale);
    const kept = storeUpload(
      core.directory,
      WS,
      "new.txt",
      "",
      Buffer.from("n"),
    );
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);

    // 合计超上限：从最旧的删起，刚存的那一份留着。
    const big = Buffer.alloc(20 * 1024 * 1024);
    const count = Math.ceil(MAX_WORKSPACE_UPLOAD_BYTES / big.byteLength) + 1;
    const all = [];
    for (let index = 0; index < count; index += 1) {
      const at = new Date(Date.now() - (count - index) * 1000);
      const one = storeUpload(core.directory, WS, `b${index}.bin`, "", big);
      utimesSync(dirname(one.path), at, at);
      all.push(one);
    }
    pruneUploads(core.directory, WS);
    expect(existsSync(all[0]!.path)).toBe(false);
    expect(existsSync(all.at(-1)!.path)).toBe(true);
  });
});

describe("POST /api/workspaces/{id}/agent-uploads", () => {
  let core: Fixture;
  let workspaceId: string;

  beforeEach(async () => {
    core = fixture([installWorkspaces, install]);
    const created = await core.call("POST", "/api/workspaces", {
      name: "Canvas",
      rootPath: core.directory,
      permissions: { read: true, write: true, execute: true },
    });
    workspaceId = (created.body as { id: string }).id;
  });
  afterEach(() => core.close());

  it("stores the raw body and answers where it landed", async () => {
    const answer = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/agent-uploads?name=${encodeURIComponent("my shot.png")}`,
      PNG,
      { "content-type": "image/png" },
    );
    expect(answer.status).toBe(200);
    const body = answer.body as { id: string; path: string; name: string };
    expect(body.name).toBe("my_shot.png");
    expect(body.path.startsWith(join(core.directory, UPLOADS_DIRECTORY))).toBe(
      true,
    );
    // 工作区里什么都没写。
    expect(existsSync(join(core.directory, ".armadra", "uploads"))).toBe(false);
    expect(readFileSync(body.path)).toEqual(PNG);
  });

  it("answers 404 for an unknown workspace and 400 for an empty body", async () => {
    const missing = await core.call(
      "POST",
      "/api/workspaces/0190a0b0-0000-7000-8000-00000000dead/agent-uploads",
      PNG,
      { "content-type": "image/png" },
    );
    expect(missing.status).toBe(404);
    const empty = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/agent-uploads?name=a.txt`,
      Buffer.alloc(0),
      { "content-type": "text/plain" },
    );
    expect(empty.status).toBe(400);
  });

  it("refuses a workspace that does not allow running agents", async () => {
    await core.call("PATCH", `/api/workspaces/${workspaceId}`, {
      permissions: { read: true, write: true, execute: false },
    });
    const refused = await core.call(
      "POST",
      `/api/workspaces/${workspaceId}/agent-uploads?name=a.png`,
      PNG,
      { "content-type": "image/png" },
    );
    expect(refused.status).toBe(403);
  });
});
