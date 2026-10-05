import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import { CoreFailure } from "../http/errors";
import { tempDir } from "../testing/temp-dir";
import { migrationsDir } from "../workspaces/fixture";
import {
  ACCOUNT,
  GATEWAY,
  GATEWAY_FP,
  ISSUER,
  PASSWORD,
  PEER_ID,
  RELAY_FP,
  type FakeWorld,
  fakeWorld,
  memoryBackend,
} from "./fake.fixture";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { DIRECT_PROBE_MS, SourcesService } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * `sources.session` 的选路（平台规格 core 包 §1.5、D27）：一个既能直连又挂在
 * 远程服务上的源，`via` 省略时并行问直连 hello 与远程服务的断言。
 */

let world: FakeWorld;
let service: SourcesService;

beforeEach(async () => {
  const opened = openFreshDatabase(
    join(tempDir("armadra-broker-"), "canvas.db"),
    migrationsDir(),
  );
  world = fakeWorld();
  const backend = memoryBackend();
  service = new SourcesService({
    store: new SourcesStore(opened.database),
    secrets: new SourceSecrets(() => backend),
    remote: new RemoteClient(world.transport, {
      platform: "desktop",
      name: "t",
    }),
    peer: new SourceClient(world.transport),
    hostId: () => "f".repeat(32),
    hostLabel: () => "this-mac",
    log: { info: () => undefined, warn: () => undefined },
  });
  service.ensureLocal();
  await service.addDirect({
    pairLink: `${GATEWAY}/#pair=ticket-1&fp=${GATEWAY_FP}`,
  });
  const { remote } = await service.remoteAdd({
    kind: "personal",
    issuer: ISSUER,
    account: ACCOUNT,
    password: PASSWORD,
    fingerprint: RELAY_FP,
  });
  await service.mount({ serviceId: remote.serviceId, sourceId: PEER_ID });
  return () => opened.close();
});

describe("选路", () => {
  it("直连通、hostId 对得上 → 直连", async () => {
    const session = await service.session(PEER_ID);
    expect(session.via).toBe("direct");
    expect(session.httpBase).toBe(GATEWAY);
    expect(session.relayToken).toBeUndefined();
  });

  it("直连的 hostId 不是这个源（地址被别的 core 占了）→ 中继", async () => {
    (world.cores.get(GATEWAY) as { hostId: string }).hostId = "3".repeat(32);
    const session = await service.session(PEER_ID);
    expect(session.via).toBe("relayed");
    expect(session.httpBase).toBe(`${ISSUER}/s/${PEER_ID}`);
  });

  it(`直连 ${DIRECT_PROBE_MS} 毫秒不答 → 中继`, async () => {
    world.slow.add(GATEWAY);
    const started = Date.now();
    const session = await service.session(PEER_ID);
    expect(session.via).toBe("relayed");
    expect(Date.now() - started).toBeLessThan(DIRECT_PROBE_MS + 1_000);
  });

  it("都不通 → source_unreachable", async () => {
    world.down.add(GATEWAY);
    world.down.add(ISSUER);
    const failure = await service
      .session(PEER_ID)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreFailure);
    expect((failure as CoreFailure).code).toBe("source_unreachable");
  });

  it("via 指定就只走那一条", async () => {
    expect((await service.session(PEER_ID, "relayed")).via).toBe("relayed");
    world.down.add(ISSUER);
    expect((await service.session(PEER_ID, "direct")).via).toBe("direct");
    const failure = await service
      .session(PEER_ID, "relayed")
      .catch((error: unknown) => error);
    expect((failure as CoreFailure).code).toBe("source_unreachable");
  });
});
