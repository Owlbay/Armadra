import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 账号面经契约客户端发（契约 §42.3）。服务器壳托管的页面是 Cookie 会话：
 * procedure 一律是 POST，门对每一条都核 `X-Armadra-CSRF`，所以读写都带。令牌
 * 被别处换掉（另一个标签页、另一个窗口）时 403：换一枚重发一次——门在处理之前
 * 就拒了，不会执行两次；再 403 就照实报（`IdentityRequestError`）。桌面壳是
 * Bearer，不带 Cookie 也不带 CSRF（`identity.test.ts`）。
 */

vi.mock("./local-runtime", () => ({
  localRuntime: () => ({
    httpBase: "https://box.example",
    wsBase: "wss://box.example",
    viaServerShell: true,
  }),
  resetLocalRuntime: () => undefined,
}));

const { createGroup, listGroups } = await import("./accounts");
const { IdentityRequestError, resetIdentityCredentials } = await import(
  "./identity"
);

/** `session/csrf` 依次换出的令牌（刷新页面之后凭 refresh Cookie 换）。 */
const TOKENS = ["a".repeat(43), "b".repeat(43)];

let calls: { url: string; init: RequestInit }[];
let renewals: number;
let status: number[];

beforeEach(() => {
  resetIdentityCredentials();
  calls = [];
  renewals = 0;
  status = [200];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const answer = (code: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status: code,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/api/identity/session/csrf")) {
        return answer(200, { csrfToken: TOKENS[renewals++] });
      }
      calls.push({ url, init });
      const code = status.shift() ?? 200;
      return answer(
        code,
        code === 403
          ? { code: "forbidden", message: "CSRF 校验未通过" }
          : url.endsWith("/list")
            ? { json: { groups: [] } }
            : { json: { groupId: "g", name: "x", createdAtMs: 1 } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetIdentityCredentials();
});

const header = (index: number) =>
  new Headers(calls[index]?.init.headers).get("x-armadra-csrf");

describe("账号面的 CSRF（Cookie 会话）", () => {
  it("同源发往 procedure，读写都带 CSRF", async () => {
    await listGroups();
    await createGroup("x");
    expect(calls.map((call) => call.url)).toEqual([
      "https://box.example/api/rpc/accounts/groups/list",
      "https://box.example/api/rpc/accounts/groups/create",
    ]);
    // 内存里没有令牌时凭 refresh Cookie 换一枚，之后读写都用它。
    expect(renewals).toBe(1);
    expect(header(0)).toBe(TOKENS[0]);
    expect(header(1)).toBe(TOKENS[0]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      json: { name: "x" },
    });
  });

  it("被拒时换一枚重发一次", async () => {
    status = [403, 200];
    await createGroup("x");
    expect(calls).toHaveLength(2);
    expect(header(0)).toBe(TOKENS[0]);
    expect(header(1)).toBe(TOKENS[1]);
  });

  it("重发仍 403 就照实报，不再重试", async () => {
    status = [403, 403];
    const failure = await createGroup("x").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityRequestError);
    expect(failure).toMatchObject({ status: 403, code: "forbidden" });
    expect(calls).toHaveLength(2);
  });
});
