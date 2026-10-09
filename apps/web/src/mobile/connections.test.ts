import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeConnection,
  loadConnections,
  remoteSlotOf,
  removeConnection,
  setActiveConnection,
  setRemoteSlot,
  touchRoute,
  upsertConnection,
} from "./connections";
import { memoryStorage } from "./testing";

const DIRECT = {
  sourceId: "h1",
  label: "",
  baseUrl: "https://192.168.1.8:8443",
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "ab".repeat(32),
};
const RELAYED = {
  sourceId: "h1",
  label: "MacBook",
  baseUrl: "",
  relayOrigin: "https://relay.example.com",
  cloudIssuer: "https://relay.example.com",
  fingerprint: "",
};

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("手机的连接表", () => {
  it("同一个源两种到达合并成一行：两条路都在，标签取新的", () => {
    upsertConnection(DIRECT);
    upsertConnection(RELAYED);
    const rows = loadConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: "h1",
      kind: "relayed",
      label: "MacBook",
      baseUrl: "https://192.168.1.8:8443",
      relayOrigin: "https://relay.example.com",
      cloudIssuer: "https://relay.example.com",
      fingerprint: "ab".repeat(32),
      orderIndex: 0,
    });
  });

  it("先中继后局域网也合并；已有的路不被空值抹掉", () => {
    upsertConnection(RELAYED);
    upsertConnection(DIRECT);
    expect(loadConnections()).toHaveLength(1);
    expect(loadConnections()[0]).toMatchObject({
      label: "MacBook",
      relayOrigin: "https://relay.example.com",
      baseUrl: "https://192.168.1.8:8443",
    });
  });

  it("不同的源各一行，按加入顺序；当前连接缺省第一个", () => {
    upsertConnection(DIRECT);
    upsertConnection({ ...DIRECT, sourceId: "h2" });
    expect(loadConnections().map((row) => row.sourceId)).toEqual(["h1", "h2"]);
    expect(activeConnection()?.sourceId).toBe("h1");
    setActiveConnection("h2");
    expect(activeConnection()?.sourceId).toBe("h2");
    removeConnection("h2");
    expect(activeConnection()?.sourceId).toBe("h1");
  });

  it("表里不放任何凭据，损坏的行与整张坏表都不抛", () => {
    upsertConnection(RELAYED);
    expect(JSON.stringify(localStorage.getItem("armadra.sources"))).not.toMatch(
      /token|secret|password/i,
    );
    localStorage.setItem(
      "armadra.sources",
      JSON.stringify([{ sourceId: "" }, 3, { sourceId: "x" }, RELAYED]),
    );
    expect(loadConnections().map((row) => row.sourceId)).toEqual(["h1"]);
    localStorage.setItem("armadra.sources", "{oops");
    expect(loadConnections()).toEqual([]);
  });

  it("远程服务的槽：按连接记一份，移除连接时一并忘掉；旧数据没有记录答 null", () => {
    upsertConnection(RELAYED);
    upsertConnection({ ...RELAYED, sourceId: "h2" });
    expect(remoteSlotOf("h1")).toBeNull();
    setRemoteSlot("h1", "personal:relay.example.com:acct-1");
    setRemoteSlot("h2", "personal:relay.example.com:guest.h2");
    expect(remoteSlotOf("h1")).toBe("personal:relay.example.com:acct-1");
    removeConnection("h2");
    expect(remoteSlotOf("h2")).toBeNull();
    expect(remoteSlotOf("h1")).toBe("personal:relay.example.com:acct-1");
    // 槽的记录里只有键名，没有凭据；坏了当作没有。
    expect(localStorage.getItem("armadra.sources.remoteSlots")).not.toMatch(
      /token|secret|password/i,
    );
    localStorage.setItem("armadra.sources.remoteSlots", "[1,2]");
    expect(remoteSlotOf("h1")).toBeNull();
    localStorage.setItem("armadra.sources.remoteSlots", "{oops");
    expect(remoteSlotOf("h1")).toBeNull();
  });
});

describe("连接表 v2：一源多路（§55）", () => {
  const LAN = "https://192.168.0.107:8443";
  const VIA_LAN = { ...RELAYED, relayOrigin: LAN, cloudIssuer: LAN };

  it("同一台主机经两个中继：两条中继都在，先到的仍是首选、镜像不变", () => {
    upsertConnection(RELAYED);
    const row = upsertConnection(VIA_LAN);
    expect(loadConnections()).toHaveLength(1);
    expect(row).toMatchObject({
      kind: "relayed",
      relayOrigin: RELAYED.relayOrigin,
      cloudIssuer: RELAYED.cloudIssuer,
    });
    expect(
      row.routes?.map(({ via, origin, cloudIssuer, preferred }) => ({
        via,
        origin,
        cloudIssuer,
        preferred,
      })),
    ).toEqual([
      {
        via: "relayed",
        origin: RELAYED.relayOrigin,
        cloudIssuer: RELAYED.cloudIssuer,
        preferred: true,
      },
      { via: "relayed", origin: LAN, cloudIssuer: LAN, preferred: false },
    ]);
    // 再经同一个中继来一次不多一条。
    expect(upsertConnection(VIA_LAN).routes).toHaveLength(2);
  });

  it("槽按（源, 来源）：两个中继各一份，删连接一并删", () => {
    upsertConnection(RELAYED);
    upsertConnection(VIA_LAN);
    setRemoteSlot(
      "h1",
      "personal:relay.example.com:acct-1",
      RELAYED.relayOrigin,
    );
    setRemoteSlot("h1", "personal:192.168.0.107:8443:acct-1", LAN);
    expect(remoteSlotOf("h1", LAN)).toBe("personal:192.168.0.107:8443:acct-1");
    expect(remoteSlotOf("h1", RELAYED.relayOrigin)).toBe(
      "personal:relay.example.com:acct-1",
    );
    // 不给来源：首选那条中继的。
    expect(remoteSlotOf("h1")).toBe("personal:relay.example.com:acct-1");
    removeConnection("h1");
    expect(remoteSlotOf("h1", LAN)).toBeNull();
    expect(localStorage.getItem("armadra.sources.remoteSlots")).toBe("{}");
  });

  it("v1 的表一次性升到 v2：行拆成路，按源记的槽搬到那条中继上，什么都不丢", () => {
    localStorage.setItem(
      "armadra.sources",
      JSON.stringify([
        {
          ...DIRECT,
          ...RELAYED,
          baseUrl: DIRECT.baseUrl,
          fingerprint: DIRECT.fingerprint,
          kind: "relayed",
          orderIndex: 0,
        },
        { ...RELAYED, sourceId: "h2", kind: "relayed", orderIndex: 1 },
      ]),
    );
    localStorage.setItem(
      "armadra.sources.remoteSlots",
      JSON.stringify({ h1: "personal:relay.example.com:acct-1", gone: "x" }),
    );
    const rows = loadConnections();
    expect(localStorage.getItem("armadra.sources.version")).toBe("2");
    expect(rows.map((row) => row.sourceId)).toEqual(["h1", "h2"]);
    expect(rows[0]).toMatchObject({
      kind: "relayed",
      baseUrl: DIRECT.baseUrl,
      relayOrigin: RELAYED.relayOrigin,
      fingerprint: DIRECT.fingerprint,
    });
    expect(
      rows[0]?.routes?.map((route) => [route.via, route.preferred]),
    ).toEqual([
      ["direct", true],
      ["relayed", false],
    ]);
    expect(
      rows[1]?.routes?.map((route) => [route.via, route.preferred]),
    ).toEqual([["relayed", true]]);
    const stored = JSON.parse(
      localStorage.getItem("armadra.sources") ?? "[]",
    ) as { routes?: unknown[] }[];
    expect(stored.every((row) => Array.isArray(row.routes))).toBe(true);
    expect(remoteSlotOf("h1", RELAYED.relayOrigin)).toBe(
      "personal:relay.example.com:acct-1",
    );
    expect(
      JSON.parse(localStorage.getItem("armadra.sources.remoteSlots") ?? "{}"),
    ).toEqual({
      [`h1\u0000${RELAYED.relayOrigin}`]: "personal:relay.example.com:acct-1",
      gone: "x",
    });
    // 再读一遍不再搬。
    expect(loadConnections()).toEqual(rows);
  });

  it("读不出来的旧表不升版本、不改写", () => {
    localStorage.setItem("armadra.sources", "{oops");
    expect(loadConnections()).toEqual([]);
    expect(localStorage.getItem("armadra.sources.version")).toBeNull();
    expect(localStorage.getItem("armadra.sources")).toBe("{oops");
  });

  it("touchRoute 记下最近连通", () => {
    upsertConnection(RELAYED);
    upsertConnection(VIA_LAN);
    touchRoute("h1", "relayed", LAN, 42);
    expect(
      loadConnections()[0]?.routes?.find((route) => route.origin === LAN)
        ?.lastOkAtMs,
    ).toBe(42);
  });
});
