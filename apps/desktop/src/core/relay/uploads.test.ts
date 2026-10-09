import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_AGENT_UPLOAD_BYTES } from "@armadra/shared";

import { install as installUploads } from "../files/upload-routes";
import { UPLOADS_DIRECTORY } from "../files/uploads";
import { ISSUER, type RelayCore, relayCore, until } from "./core.fixture";
import type { FakeTunnel } from "./fake-relay.fixture";

/**
 * 经中继到达的源上传 Agent 附件（契约 §56）：页面发往远程源，请求经隧道到那台
 * core，字节落在**那台 core 的数据目录**里——不是发起页面的机器。体比一个流窗口
 * 大，走完整的流控。
 */

let world: RelayCore;
let tunnel: FakeTunnel;
const WORKSPACE = "ws-relay-upload";

beforeEach(async () => {
  world = await relayCore();
  installUploads(world.core);
  world.core.database
    .prepare(
      "INSERT INTO workspaces (id, name, root_path, permissions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      WORKSPACE,
      WORKSPACE,
      world.core.directory,
      JSON.stringify({ read: true, write: true, execute: true }),
      "2026-10-10T00:00:00Z",
      "2026-10-10T00:00:00Z",
    );
  await world.register();
  tunnel = await world.relay.nextTunnel(0);
  const issuer = world.cloud.registrations()[0]!.issuer;
  await until(() => world.tunnels.status(issuer).state === "ready");
});

afterEach(async () => {
  await world.close();
});

describe("agent uploads through the relay (§56)", () => {
  it("lands the bytes in the remote core's data directory", async () => {
    const token = world.session(ISSUER);
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const answer = await tunnel.request({
      method: "POST",
      path: `/api/workspaces/${WORKSPACE}/agent-uploads?name=${encodeURIComponent("截图 1.png")}`,
      headers: {
        origin: ISSUER,
        authorization: `Bearer ${token}`,
        "content-type": "image/png",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    });
    expect(answer.status, answer.body.toString("utf8")).toBe(200);
    const stored = answer.json<{
      id: string;
      path: string;
      name: string;
      bytes: number;
      mimeType: string;
    }>();
    expect(stored).toMatchObject({
      name: "1.png",
      bytes: bytes.byteLength,
      mimeType: "image/png",
    });
    expect(stored.path).toBe(
      join(
        world.core.directory,
        UPLOADS_DIRECTORY,
        WORKSPACE,
        stored.id,
        "1.png",
      ),
    );
    expect(readFileSync(stored.path).equals(bytes)).toBe(true);
  });

  it("refuses an unauthenticated upload and one over the limit", async () => {
    const anonymous = await tunnel.request({
      method: "POST",
      path: `/api/workspaces/${WORKSPACE}/agent-uploads?name=a.txt`,
      headers: { origin: ISSUER, "content-type": "text/plain" },
      body: "hello",
    });
    expect(anonymous.status).toBe(401);

    const token = world.session(ISSUER);
    const big = Buffer.alloc(MAX_AGENT_UPLOAD_BYTES + 128 * 1024);
    const refused = await tunnel.request({
      method: "POST",
      path: `/api/workspaces/${WORKSPACE}/agent-uploads?name=big.bin`,
      headers: {
        origin: ISSUER,
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": String(big.byteLength),
      },
      body: big,
    });
    expect(refused.status).toBe(413);
  });
});
