import { describe, expect, it } from "vitest";

import {
  JOIN_LINK_MAX,
  PendingJoinLink,
  deepJoinLink,
  joinLinkFromArgv,
} from "./join-link";

const DEEP = `armadra://join?link=0123456789abcdef&issuer=${encodeURIComponent("https://relay.example.com")}&s=${encodeURIComponent(`${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`)}`;

describe("分享深链", () => {
  it("只认 armadra://join 且参数齐全的", () => {
    expect(deepJoinLink(DEEP)).toBe(DEEP);
    expect(deepJoinLink("armadra://pair?host=h&ticket=t")).toBeNull();
    expect(deepJoinLink("armadra://join?link=x&issuer=y")).toBeNull();
    expect(deepJoinLink("https://relay.example.com/j/x#a.b")).toBeNull();
    expect(deepJoinLink(`${DEEP}${"x".repeat(JOIN_LINK_MAX)}`)).toBeNull();
    expect(deepJoinLink(42)).toBeNull();
  });

  it("启动参数里取最后一条认得出的", () => {
    expect(joinLinkFromArgv(["/Applications/Armadra", "--flag"])).toBeNull();
    expect(joinLinkFromArgv(["armadra", "armadra://pair?x=1", DEEP])).toBe(
      DEEP,
    );
  });

  it("待转交：只留最新一条，取走即清", () => {
    const pending = new PendingJoinLink(null);
    expect(pending.offer("armadra://other")).toBe(false);
    expect(pending.offer(DEEP)).toBe(true);
    expect(pending.take()).toBe(DEEP);
    expect(pending.take()).toBeNull();
  });
});
