import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openFreshDatabase } from "../db/fresh.fixture";
import type { OpenedDatabase } from "../db/open";
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
  RELAYED_ID,
  RELAY_FP,
  type FakeWorld,
  fakeWorld,
  memoryBackend,
} from "./fake.fixture";
import { RemoteClient } from "./remote-client";
import { SourceSecrets } from "./secrets";
import { SourcesService } from "./service";
import { SourceClient } from "./source-client";
import { SourcesStore } from "./store";

/**
 * 源与远程服务的名字（契约 §61）：缺省名取服务端报的（hello `hostName`、
 * platform.info `name`、目录里的源名称、本机的「主机名称」），改名只在本机、
 * 清空恢复缺省名，再次添加时改过的名字留着、没改过的跟着服务端走。
 */

const HOST_ID = "f".repeat(32);

let opened: OpenedDatabase;
let world: FakeWorld;
let service: SourcesService;
let hostLabel: string;

function code(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof CoreFailure ? error.code : String(error),
  );
}

beforeEach(() => {
  const directory = tempDir("armadra-naming-");
  opened = openFreshDatabase(join(directory, "canvas.db"), migrationsDir());
  world = fakeWorld();
  hostLabel = "this-mac";
  const backend = memoryBackend();
  const log = () => {};
  service = new SourcesService({
    store: new SourcesStore(opened.database),
    secrets: new SourceSecrets(() => backend),
    remote: new RemoteClient(world.transport, {
      platform: "desktop",
      name: "test",
    }),
    peer: new SourceClient(world.transport),
    hostId: () => HOST_ID,
    hostLabel: () => hostLabel,
    log: { info: log, warn: log },
  });
  service.ensureLocal();
});

afterEach(() => opened.close());

const pairLink = `${GATEWAY}/#pair=ticket-1&fp=${GATEWAY_FP}`;

function addRemote() {
  return service.remoteAdd({
    kind: "personal",
    issuer: ISSUER,
    account: ACCOUNT,
    password: PASSWORD,
    fingerprint: RELAY_FP,
  });
}

async function local() {
  const { sources } = await service.list();
  return sources.find((one) => one.kind === "local");
}

describe("本机行", () => {
  it("缺省名跟着主机名称；改过名的留着，清空恢复", async () => {
    expect(await local()).toMatchObject({
      label: "this-mac",
      defaultLabel: "this-mac",
    });
    hostLabel = "书房";
    expect(await local()).toMatchObject({
      label: "书房",
      defaultLabel: "书房",
    });
    await service.update({ sourceId: HOST_ID, label: "我的电脑" });
    hostLabel = "客厅";
    expect(await local()).toMatchObject({
      label: "我的电脑",
      defaultLabel: "客厅",
    });
    await service.update({ sourceId: HOST_ID, label: "" });
    expect(await local()).toMatchObject({
      label: "客厅",
      defaultLabel: "客厅",
    });
  });
});

describe("直连源", () => {
  it("缺省名取对端 hello 的 hostName；旧对端不报时用地址", async () => {
    world.cores.get(GATEWAY)!.hostName = "laptop-pro";
    const added = await service.addDirect({ pairLink });
    expect(added).toMatchObject({
      label: "laptop-pro",
      defaultLabel: "laptop-pro",
    });

    world.cores.get(GATEWAY)!.hostName = undefined;
    await service.remove(PEER_ID);
    world.cores.get(GATEWAY)!.tickets.add("ticket-1");
    const legacy = await service.addDirect({ pairLink });
    expect(legacy).toMatchObject({
      label: new URL(GATEWAY).host,
      defaultLabel: new URL(GATEWAY).host,
    });
  });

  it("改名在重新配对后保留；对端改了主机名称只更新缺省名", async () => {
    world.cores.get(GATEWAY)!.hostName = "laptop";
    await service.addDirect({ pairLink });
    await service.update({ sourceId: PEER_ID, label: "  工作机 " });
    world.cores.get(GATEWAY)!.hostName = "laptop-2";
    world.cores.get(GATEWAY)!.tickets.add("ticket-1");
    const again = await service.addDirect({ pairLink });
    expect(again).toMatchObject({ label: "工作机", defaultLabel: "laptop-2" });
    const restored = await service.update({ sourceId: PEER_ID, label: "" });
    expect(restored).toMatchObject({
      label: "laptop-2",
      defaultLabel: "laptop-2",
    });
  });
});

describe("远程服务", () => {
  it("缺省名取 platform.info 的 name；旧中继不报时用地址", async () => {
    const legacy = await addRemote();
    expect(legacy.remote).toMatchObject({
      label: new URL(ISSUER).host,
      defaultLabel: new URL(ISSUER).host,
    });
    world.cloud.name = "家里的中转";
    const named = await addRemote();
    expect(named.remote).toMatchObject({
      label: "家里的中转",
      defaultLabel: "家里的中转",
    });
  });

  it("remoteUpdate：改名、清空恢复；重新登录不覆盖改过的名字", async () => {
    world.cloud.name = "home";
    const { remote } = await addRemote();
    const renamed = await service.remoteUpdate({
      serviceId: remote.serviceId,
      label: "公司中转",
    });
    expect(renamed).toMatchObject({ label: "公司中转", defaultLabel: "home" });
    world.cloud.name = "home-2";
    const again = await addRemote();
    expect(again.remote).toMatchObject({
      label: "公司中转",
      defaultLabel: "home-2",
    });
    expect(
      await service.remoteUpdate({ serviceId: remote.serviceId, label: " " }),
    ).toMatchObject({ label: "home-2" });
    expect(
      await code(
        service.remoteUpdate({
          serviceId: remote.serviceId,
          label: "x".repeat(129),
        }),
      ),
    ).toBe("bad_request");
    expect(
      await code(service.remoteUpdate({ serviceId: "nope", label: "x" })),
    ).toBe("not_found");
  });

  it("挂载的源缺省名取目录里的名称，改名后再挂载不覆盖", async () => {
    const { remote } = await addRemote();
    const mounted = await service.mount({
      serviceId: remote.serviceId,
      sourceId: RELAYED_ID,
    });
    expect(mounted).toMatchObject({ label: "studio", defaultLabel: "studio" });
    await service.update({ sourceId: RELAYED_ID, label: "工作室" });
    world.cloud.sources[0]!.name = "studio-2";
    const again = await service.mount({
      serviceId: remote.serviceId,
      sourceId: RELAYED_ID,
    });
    expect(again).toMatchObject({ label: "工作室", defaultLabel: "studio-2" });
  });
});
