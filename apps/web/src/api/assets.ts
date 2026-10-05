import * as React from "react";

import { type Source, knownSources, routedFetch, sourceForUrl } from "./source";

/**
 * 页面里 `<img src>` 指向 core 的资源（白板图片、Markdown 预览里的图，R-55）。
 *
 * Cookie 会话的源（服务器壳托管的页面）直接用地址：Cookie 跟着 `<img>` 走。
 * Bearer 的源（桌面壳与原生 App 里的本机源、挂载的远程源）凭据是
 * `Authorization: Bearer`（契约 §3.2），而 `<img>` 带不了头——Bearer 只跟着
 * 源的 `fetch` 走（`api/source.ts`）。所以发往这些源的地址先经它取回，再交给
 * `<img>` 一个 `blob:` 地址。同一个地址的几处共用一份，最后一处卸载时回收。
 */

/** 这个地址要经哪个源的 `fetch` 取：它属于一个 Bearer 模式的源；否则 `null`。 */
export function bearerSourceFor(
  url: string,
  sources: readonly Source[] = knownSources(),
): Source | null {
  const source = sourceForUrl(url, sources);
  return source !== null && source.credentials.mode === "bearer"
    ? source
    : null;
}

/** 这个地址要不要经 `fetch` 取（见 {@link bearerSourceFor}）。 */
export function needsBearerFetch(
  url: string,
  sources: readonly Source[] = knownSources(),
): boolean {
  return bearerSourceFor(url, sources) !== null;
}

/**
 * 把 core 上的一个文件存到本机（编辑器的「下载」）。
 *
 * 经地址所属那个源的 `fetch` 取回再交给一个 `blob:` 链接：凭据都只跟着 `fetch`
 * 走——Bearer 的源是补上的令牌，服务器壳是同源的 Cookie。一个直接的
 * `<a href>` 在前者没有凭据，core 答 401。取不回（非 2xx、网络错误）答
 * `false`。
 */
export async function downloadRuntimeFile(
  url: string,
  filename: string,
  load: typeof fetch = routedFetch,
): Promise<boolean> {
  let blob: Blob;
  try {
    const response = await load(url, { cache: "no-store" });
    if (!response.ok) return false;
    blob = await response.blob();
  } catch {
    return false;
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return true;
}

interface Entry {
  refs: number;
  objectUrl: string | null;
  readonly ready: Promise<string | null>;
}

const entries = new Map<string, Entry>();

/**
 * 取一份 `blob:` 地址并占用它；`release` 之后最后一个占用者走时回收。取不回
 * （非 2xx、网络错误）答 `null`。
 */
export function acquireAssetUrl(
  url: string,
  load: typeof fetch = routedFetch,
): { ready: Promise<string | null>; release(): void } {
  let entry = entries.get(url);
  if (entry === undefined) {
    const created: Entry = {
      refs: 0,
      objectUrl: null,
      ready: load(url, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          const objectUrl = URL.createObjectURL(await response.blob());
          // 取回来之前所有占用者都走了：不留。
          if (entries.get(url) !== created) {
            URL.revokeObjectURL(objectUrl);
            return null;
          }
          created.objectUrl = objectUrl;
          return objectUrl;
        })
        .catch(() => null),
    };
    entries.set(url, created);
    entry = created;
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  return {
    ready: held.ready,
    release() {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      if (entries.get(url) === held) entries.delete(url);
      if (held.objectUrl !== null) URL.revokeObjectURL(held.objectUrl);
    },
  };
}

/**
 * `<img src>` 用的地址。不需要经 `fetch` 的原样返回；需要的在取回之前是
 * `undefined`，取不回是 `null`（调用方按「图坏了」处理）。
 */
export function useAssetUrl(
  url: string | null | undefined,
): string | null | undefined {
  const bearer = url ? needsBearerFetch(url) : false;
  const [resolved, setResolved] = React.useState<{
    url: string;
    src: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (!url || !bearer) return;
    let live = true;
    const held = acquireAssetUrl(url);
    void held.ready.then((src) => {
      if (live) setResolved({ url, src });
    });
    return () => {
      live = false;
      held.release();
    };
  }, [url, bearer]);

  if (!url) return null;
  if (!bearer) return url;
  return resolved?.url === url ? resolved.src : undefined;
}
