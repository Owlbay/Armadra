import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "./client";
import { RuntimeRequestError, isConflict } from "./request";
import { setCurrentSourceResolver, type Source, localSource } from "./source";

/**
 * files 域的页面一侧（契约 §37）：JSON 面都发 `POST /api/rpc/files/<动词>`，体是
 * `{ json: { workspaceId, … } }`，答案过页面自己的 schema；字节流（下载的 URL、
 * 多部分上传）留在 REST，发往当前源。
 */

const workspaceId = "019ff7d1-0d12-7421-833d-2c5e8d64ed21";
const sha = "a".repeat(64);

type Call = { url: string; init: RequestInit };
let calls: Call[];

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stub(respond: (call: Call) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: input instanceof Request ? input.url : String(input),
        init: init ?? {},
      };
      calls.push(call);
      return respond(call);
    }),
  );
}

const sent = (index = 0): unknown =>
  JSON.parse(String(calls[index]?.init.body ?? "null"));

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentSourceResolver(null);
});

describe("files：JSON 面经 RPC", () => {
  it("listFiles / readFile / fileInfo / fileVersion 各发自己的 procedure", async () => {
    const replies: Record<string, unknown> = {
      list: { path: ".", entries: [], truncated: false },
      read: {
        path: "a.ts",
        mimeType: "text/plain",
        content: "x",
        size: 1,
        sha256: sha,
      },
      info: {
        path: "a.ts",
        name: "a.ts",
        size: 1,
        mimeType: "text/plain",
        preview: "text",
      },
      version: { path: "a.ts", exists: false },
    };
    stub((call) =>
      answer(200, { json: replies[call.url.split("/").pop() as string] }),
    );

    await runtimeApi.listFiles(workspaceId);
    await runtimeApi.readFile(workspaceId, "a.ts");
    await runtimeApi.fileInfo(workspaceId, "a.ts");
    await runtimeApi.fileVersion(workspaceId, "a.ts");

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:43120/api/rpc/files/list",
      "http://127.0.0.1:43120/api/rpc/files/read",
      "http://127.0.0.1:43120/api/rpc/files/info",
      "http://127.0.0.1:43120/api/rpc/files/version",
    ]);
    expect(sent(0)).toEqual({ json: { workspaceId, path: "." } });
    expect(sent(1)).toEqual({ json: { workspaceId, path: "a.ts" } });
  });

  it("条目操作：新建、改名、回收站、恢复", async () => {
    stub(() => answer(200, { json: { path: "a", kind: "file" } }));
    await runtimeApi.createFileEntry(workspaceId, "a", "file");
    await runtimeApi.renameFileEntry(workspaceId, "a", "b");
    await runtimeApi.restoreTrash(workspaceId, "t1");
    expect(calls.map((call) => call.url.split("/api/rpc/")[1])).toEqual([
      "files/create",
      "files/rename",
      "files/restore",
    ]);
    expect(sent(0)).toEqual({
      json: { workspaceId, path: "a", kind: "file" },
    });
    expect(sent(1)).toEqual({ json: { workspaceId, from: "a", to: "b" } });
    expect(sent(2)).toEqual({ json: { workspaceId, id: "t1" } });
  });

  it("unwatchFile 发 files.unwatch，答 undefined", async () => {
    stub(() => answer(200, {}));
    await expect(
      runtimeApi.unwatchFile(workspaceId, "a.ts", "node-1"),
    ).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("http://127.0.0.1:43120/api/rpc/files/unwatch");
    expect(sent()).toEqual({
      json: { workspaceId, path: "a.ts", nodeId: "node-1" },
    });
  });

  it("searchFiles 把 signal 交给请求，fileIndex 的 limit 缺省不发", async () => {
    stub((call) =>
      answer(200, {
        json: call.url.endsWith("search")
          ? {
              files: [],
              totalMatches: 0,
              truncated: false,
              timedOut: false,
              skipped: 0,
              scanned: 0,
            }
          : { entries: [], truncated: false, scanned: 0 },
      }),
    );
    const controller = new AbortController();
    await runtimeApi.searchFiles(
      workspaceId,
      { query: "needle" },
      controller.signal,
    );
    await runtimeApi.fileIndex(workspaceId, "no");
    expect(calls[0]?.url).toBe("http://127.0.0.1:43120/api/rpc/files/search");
    expect(calls[0]?.init.signal).toBeDefined();
    expect(sent(0)).toEqual({ json: { workspaceId, query: "needle" } });
    expect(sent(1)).toEqual({ json: { workspaceId, query: "no" } });
  });

  it("409 是可判别的冲突，envelope 的码原样带出", async () => {
    stub(() =>
      answer(409, { code: "conflict", message: "x", requestId: "r1" }),
    );
    const error = await runtimeApi
      .createFileEntry(workspaceId, "a", "file")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RuntimeRequestError);
    expect(isConflict(error)).toBe(true);
  });
});

describe("files：留在 REST 的字节流", () => {
  it("下载地址指向当前源，不经 RPC", () => {
    expect(runtimeApi.fileDownloadUrl(workspaceId, "a b.txt")).toBe(
      `http://127.0.0.1:43120/api/workspaces/${workspaceId}/file-download?path=a%20b.txt`,
    );
  });

  it("JSON 面发往当前源：换了源，请求跟着去", async () => {
    const other: Source = {
      ...localSource,
      sourceId: "remote-1",
      httpBase: "https://core.example",
      wsBase: "wss://core.example",
    };
    setCurrentSourceResolver(() => other);
    stub(() =>
      answer(200, { json: { path: ".", entries: [], truncated: false } }),
    );
    await runtimeApi.listFiles(workspaceId);
    expect(calls[0]?.url).toBe("https://core.example/api/rpc/files/list");
    expect(runtimeApi.fileDownloadUrl(workspaceId, "a")).toMatch(
      /^https:\/\/core\.example\/api\/workspaces\//,
    );
  });
});
