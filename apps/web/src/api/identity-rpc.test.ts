import { afterEach, describe, expect, it, vi } from "vitest";

import { listGroups } from "./accounts";
import { issueInvitation } from "./remote-services";
import { installLocalTransport, localSource } from "./source";

/**
 * 桌面壳的页面与 core 不同端口（A1-4 记下的那处）：账号面原来带 Cookie
 * （`credentials: "include"`）跨端口发，过不了 CORS。迁到契约之后它与其余各域
 * 一样经本机源发——Bearer、不带 Cookie、不带 CSRF。服务器壳托管的页面见
 * `accounts.csrf.test.ts`。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  installLocalTransport(null);
});

describe("桌面壳里的身份三域", () => {
  it("账号与本机邀请：Bearer、不带 Cookie 与 CSRF，发往 core 的回环端口", async () => {
    installLocalTransport({
      origin: localSource.httpBase,
      authorization: () => "A".repeat(43),
      wsTicket: async () => "",
      refresh: async () => false,
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify(
            url.endsWith("/groups/list")
              ? { json: { groups: [] } }
              : {
                  json: {
                    invitationId: "i1",
                    token: "i1.secret",
                    expiresAtMs: 5,
                    role: "viewer",
                    targetGroupId: "",
                    targetWorkspaceId: "w1",
                    maxUses: null,
                  },
                },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    await listGroups();
    await issueInvitation({
      role: "viewer",
      targetWorkspaceId: "w1",
      ttlMs: 1,
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${localSource.httpBase}/api/rpc/accounts/groups/list`,
      `${localSource.httpBase}/api/rpc/accounts/invitations/issue`,
    ]);
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${"A".repeat(43)}`);
      expect(headers.get("x-armadra-csrf")).toBeNull();
      expect(init.credentials).toBe("omit");
    }
  });
});
