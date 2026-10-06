import { describe, expect, it } from "vitest";

import {
  isJoinLink,
  issuerOrigin,
  joinDeepLink,
  parseJoinLink,
} from "./join-link.js";

const LINK_ID = "0123456789abcdef0123456789abcdef";
const SECRET = "A".repeat(43);
const INVITE = `${"b".repeat(32)}.${"C".repeat(43)}`;

describe("分享链接", () => {
  it("网页链接：秘密与邀请令牌在片段里，按第一个点切", () => {
    expect(
      parseJoinLink(
        `https://relay.example.com/j/${LINK_ID}#${SECRET}.${INVITE}`,
      ),
    ).toEqual({
      issuer: "https://relay.example.com",
      linkId: LINK_ID,
      secret: SECRET,
      invitationToken: INVITE,
    });
  });

  it("深链 armadra://join 同形", () => {
    const link = `armadra://join?link=${LINK_ID}&issuer=${encodeURIComponent("https://relay.example.com:8443")}&s=${encodeURIComponent(`${SECRET}.${INVITE}`)}`;
    expect(parseJoinLink(link)).toMatchObject({
      issuer: "https://relay.example.com:8443",
      linkId: LINK_ID,
      secret: SECRET,
      invitationToken: INVITE,
    });
    expect(isJoinLink(link)).toBe(true);
  });

  it("缺片段、缺秘密、不是 /j/ 路径、别的深链都不认", () => {
    expect(parseJoinLink(`https://relay.example.com/j/${LINK_ID}`)).toBeNull();
    expect(
      parseJoinLink(`https://relay.example.com/j/${LINK_ID}#.${INVITE}`),
    ).toBeNull();
    expect(
      parseJoinLink(
        `https://relay.example.com/x/${LINK_ID}#${SECRET}.${INVITE}`,
      ),
    ).toBeNull();
    expect(parseJoinLink("armadra://pair?host=h&ticket=t&fp=f")).toBeNull();
    expect(parseJoinLink("hello")).toBeNull();
  });

  it("非回环的 http 签发方不认", () => {
    expect(
      parseJoinLink(
        `http://relay.example.com/j/${LINK_ID}#${SECRET}.${INVITE}`,
      ),
    ).toBeNull();
    expect(
      parseJoinLink(`http://127.0.0.1:9000/j/${LINK_ID}#${SECRET}.${INVITE}`),
    ).toMatchObject({ issuer: "http://127.0.0.1:9000" });
  });
});

describe("签发方地址", () => {
  it("没写协议当 https；带路径、口令、查询的不要", () => {
    expect(issuerOrigin("relay.example.com")).toBe("https://relay.example.com");
    expect(issuerOrigin(" https://relay.example.com:8443/ ")).toBe(
      "https://relay.example.com:8443",
    );
    expect(issuerOrigin("https://relay.example.com/app")).toBeNull();
    expect(issuerOrigin("https://u:p@relay.example.com")).toBeNull();
    expect(issuerOrigin("https://relay.example.com/?x=1")).toBeNull();
    expect(issuerOrigin("")).toBeNull();
    expect(issuerOrigin("ftp://relay.example.com")).toBeNull();
  });
});

describe("深链写法", () => {
  it("joinDeepLink 解析回来是同一条链接", () => {
    const parsed = parseJoinLink(
      `https://relay.example.com:8443/j/${LINK_ID}#${SECRET}.${INVITE}`,
    )!;
    const deep = joinDeepLink(parsed);
    expect(deep.startsWith("armadra://join?")).toBe(true);
    expect(parseJoinLink(deep)).toEqual(parsed);
  });
});
