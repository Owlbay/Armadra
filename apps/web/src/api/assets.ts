import * as React from "react";

import { isNativeApp, sameOrigin } from "../mobile/native-bridge";
import { savedRuntimeOrigin } from "./runtime-url";

/**
 * 页面里 `<img src>` 指向 core 的资源（白板图片、Markdown 预览里的图，R-55）。
 *
 * 浏览器与桌面壳里直接用地址：Cookie / 回环都认。原生 App 里凭据是
 * `Authorization: Bearer`，而 `<img>` 带不了头——`installNativeTransport` 只包了
 * `fetch` 与 `WebSocket`。所以在 App 里、发往 Gateway 的地址改成先经（已带
 * Bearer 的）`fetch` 取回，再交给 `<img>` 一个 `blob:` 地址。同一个地址的几处
 * 共用一份，最后一处卸载时回收。
 */

/** 这个地址要不要经 `fetch` 取：只在原生 App 里、只对 Gateway 来源。 */
export function needsBearerFetch(
  url: string,
  native: boolean = isNativeApp(),
  origin: string | null = savedRuntimeOrigin(),
): boolean {
  return native && origin !== null && sameOrigin(url, origin);
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
  load: typeof fetch = (input, init) => globalThis.fetch(input, init),
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
