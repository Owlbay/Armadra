import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeConnection,
  loadConnections,
  removeConnection,
  setActiveConnection,
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
});
