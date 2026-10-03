import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 账号 / 组 / 共享这一面的写在 Cookie 会话上要 CSRF（契约 §10）。令牌被别处
 * 换掉（另一个标签页、另一个窗口）时 403：换一枚重发一次，与 `api/request.ts`
 * 同一个做法——请求没进处理逻辑，不会执行两次；再 403 就照实报。
 */

const csrf = vi.hoisted(() => ({
  value: "a".repeat(43),
  ensure: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("./identity", async (original) => ({
  ...(await original<typeof import("./identity")>()),
  ensureCsrf: () => csrf.ensure() as Promise<string>,
  replaceRejectedCsrf: (rejected: string) =>
    csrf.replace(rejected) as Promise<string>,
}));

const { createGroup, listGroups } = await import("./accounts");

let calls: { url: string; init: RequestInit }[];
let status: number[];

beforeEach(() => {
  calls = [];
  status = [200];
  csrf.ensure.mockReset().mockResolvedValue(csrf.value);
  csrf.replace.mockReset().mockResolvedValue("b".repeat(43));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const code = status.shift() ?? 200;
      return {
        ok: code >= 200 && code < 300,
        status: code,
        json: async () =>
          code === 403
            ? { code: "PERMISSION_DENIED", message: "" }
            : { groups: [] },
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const header = (index: number) =>
  (calls[index]?.init.headers as Record<string, string>)["X-Armadra-CSRF"];

describe("账号面的 CSRF", () => {
  it("读不带、写带", async () => {
    await listGroups();
    await createGroup("x");
    expect(header(0)).toBe(undefined);
    expect(header(1)).toBe(csrf.value);
  });

  it("写被 403 时换一枚重发一次", async () => {
    status = [403, 200];
    await createGroup("x");
    expect(csrf.replace).toHaveBeenCalledWith(csrf.value);
    expect(calls).toHaveLength(2);
    expect(header(1)).toBe("b".repeat(43));
  });

  it("重发仍 403 就照实报，不再重试", async () => {
    status = [403, 403];
    await expect(createGroup("x")).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(2);
  });

  it("读的 403 不重试", async () => {
    status = [403];
    await expect(listGroups()).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
    expect(csrf.replace).not.toHaveBeenCalled();
  });
});
