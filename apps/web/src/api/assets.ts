import * as React from "react";

import {
  type Source,
  currentSource,
  knownSources,
  routedFetch,
  sourceForUrl,
} from "./source";

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

/** 中继上签媒体票的路径（armadra-cloud cloud-api §12），相对源地址。 */
export const RELAY_MEDIA_TICKET_PATH = "/_relay/media-tickets";

export type MediaDisposition = "inline" | "attachment";

/** 向 core 换一张媒体票（`files.mediaTicket`，契约 §37.4）。 */
export type IssueMediaTicket = (
  workspaceId: string,
  path: string,
  disposition: MediaDisposition,
) => Promise<{ readonly url: string }>;

/**
 * 一个浏览器能直接取的地址（`<video src>`、`<img src>`、`<a href>`），不带头、
 * 按 `Range` 取，不把文件读进页面（契约 §37.4）：
 *
 * 1. 经带凭据的 `files.mediaTicket` 换 core 的 `/api/media/<票>`；
 * 2. 这个源眼下经中继到达时，再用带中继令牌的请求换一张中继的票
 *    （`POST <源地址>/_relay/media-tickets`），地址成了 `<源地址>/_relay/m/<票>`。
 *
 * 地址里只有票：凭据、工作空间与文件路径都不在 URL 上。老 core（没有这条
 * procedure）、老中继或任何一步失败答 `null`，调用方退回取回成 `blob:`。
 */
export async function directFileUrl(
  workspaceId: string,
  path: string,
  disposition: MediaDisposition,
  issue: IssueMediaTicket,
  source: Source = currentSource(),
): Promise<string | null> {
  let ticket: { readonly url: string };
  try {
    ticket = await issue(workspaceId, path, disposition);
  } catch {
    return null;
  }
  if (!ticket.url.startsWith("/api/media/")) return null;
  const base = source.httpBase.replace(/\/+$/, "");
  if (source.relayed?.() !== true) return `${base}${ticket.url}`;
  try {
    const response = await source.fetch(`${base}${RELAY_MEDIA_TICKET_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ticket.url }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { path?: unknown };
    return typeof body.path === "string" && body.path.startsWith("/_relay/m/")
      ? `${base}${body.path}`
      : null;
  } catch {
    return null;
  }
}

/** File System Access 的保存对话框（`showSaveFilePicker`）里用到的那一点。 */
export interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
  /** Chromium 有、标准里还没有：写失败时删掉对话框已经建出来的空文件。 */
  remove?(): Promise<void>;
}

export type SaveFilePicker = (options: {
  suggestedName: string;
}) => Promise<SaveFileHandle>;

/** 这个页面能不能把下载流直接写进用户选的文件；不能答 `null`。 */
export function saveFilePicker(): SaveFilePicker | null {
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  return typeof picker === "function" ? picker.bind(globalThis) : null;
}

export interface DownloadOptions {
  /** 缺省取 {@link saveFilePicker}；给 `null` 即不用保存对话框。 */
  readonly picker?: SaveFilePicker | null;
  readonly sources?: readonly Source[];
  /** 页面自己的来源；缺省 `location.origin`。 */
  readonly origin?: string;
  /**
   * 换一个不带头就能取的下载地址（媒体票，{@link directFileUrl}）。Bearer 的源
   * 没有保存对话框时（iPad 上的原生 App）用它让浏览器边收边写，而不是先取回成
   * `Blob`；答 `null` 再退回 `Blob`。
   */
  readonly direct?: () => Promise<string | null>;
}

/**
 * 把 core 上的一个文件存到本机（编辑器的「下载」）。不把整个文件读进内存，
 * 能流就流，三条路按顺序试：
 *
 * 1. 有 File System Access（Chromium、桌面壳）：先弹保存对话框——要趁点击的
 *    用户激活还在——再经地址所属那个源的 `fetch` 取，响应体直接
 *    `pipeTo` 进选中的文件。用户取消答 `true`（不是失败）。
 * 2. 同源、不是 Bearer 的源（服务器壳托管的页面，凭据是 Cookie）：先取一次只看
 *    状态，拿到响应头就中止，再交给浏览器自己的下载（core 答
 *    `content-disposition: attachment`），由浏览器边收边写盘。
 * 3. 其余（Bearer 的源，且没有保存对话框，比如 iPad 上的原生 App）：凭据只跟着
 *    `fetch` 走，一个直接的 `<a href>` 会是 401。给了 `direct` 就换一个媒体票的
 *    下载地址（契约 §37.4，`attachment`）交给链接，由浏览器边收边写；换不到才
 *    取回成 `Blob` 再交给一个 `blob:` 链接——那一条仍占内存。
 *
 * 取不回（非 2xx、网络错误、写盘失败）答 `false`。
 */
export async function downloadRuntimeFile(
  url: string,
  filename: string,
  load: typeof fetch = routedFetch,
  options: DownloadOptions = {},
): Promise<boolean> {
  const picker =
    options.picker === undefined ? saveFilePicker() : options.picker;
  if (picker !== null) {
    let handle: SaveFileHandle;
    try {
      handle = await picker({ suggestedName: filename });
    } catch (error) {
      if (isAbort(error)) return true;
      // 没有用户激活、被策略拦下等：退到下面两条。
      return downloadWithoutPicker(url, filename, load, options);
    }
    return streamInto(handle, url, load);
  }
  return downloadWithoutPicker(url, filename, load, options);
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function streamInto(
  handle: SaveFileHandle,
  url: string,
  load: typeof fetch,
): Promise<boolean> {
  try {
    const response = await load(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const writable = await handle.createWritable();
    if (response.body === null) {
      // 没有流（某些包装过的 fetch）：一次写完，至少不在页面里再复制一份。
      const writer = writable.getWriter();
      await writer.write(new Uint8Array(await response.arrayBuffer()));
      await writer.close();
    } else {
      // 出错时 `pipeTo` 中止可写流，半截的临时文件不会替换目标。
      await response.body.pipeTo(writable);
    }
    return true;
  } catch {
    await handle.remove?.().catch(() => undefined);
    return false;
  }
}

async function downloadWithoutPicker(
  url: string,
  filename: string,
  load: typeof fetch,
  options: DownloadOptions,
): Promise<boolean> {
  const origin = options.origin ?? globalThis.location?.origin;
  const sources = options.sources ?? knownSources();
  if (
    origin !== undefined &&
    sameOriginAs(url, origin) &&
    bearerSourceFor(url, sources) === null
  ) {
    const controller = new AbortController();
    try {
      const response = await load(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return false;
    } catch {
      return false;
    } finally {
      // 只要状态；正文交给浏览器的下载。
      controller.abort();
    }
    clickLink(url, filename);
    return true;
  }
  const direct = await options.direct?.().catch(() => null);
  if (typeof direct === "string") {
    clickLink(direct, filename);
    return true;
  }
  let blob: Blob;
  try {
    const response = await load(url, { cache: "no-store" });
    if (!response.ok) return false;
    blob = await response.blob();
  } catch {
    return false;
  }
  const objectUrl = URL.createObjectURL(blob);
  clickLink(objectUrl, filename);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return true;
}

function sameOriginAs(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

function clickLink(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
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
