import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { MAX_ACP_IMAGE_BYTES } from "@armadra/shared";

import type { StoredUpload } from "../files/uploads";
import type { MirrorMediaBlock } from "../history/acp-mirror";
import { AcpError } from "./client";
import type { AcpContentBlock } from "./types";

/**
 * 一条 prompt 带的上传（契约 §55）→ 发给 Agent 的内容块，以及记进镜像、发给
 * 别的设备的那一份。
 *
 *   * 图片（PNG / JPEG / GIF / WebP）→ `image` 块，base64 正文；Agent 在
 *     `initialize` 里没声明 `promptCapabilities.image` 时拒绝（`acp_image_unsupported`），
 *     不悄悄换成链接——人以为它看见了图，它其实没有。
 *   * 别的文件：Agent 声明了 `embeddedContext`、文件是不大的 UTF-8 文本时
 *     → 内嵌的 `resource`（带正文）；否则 → `resource_link`（`file://` 路径，
 *     ACP 的基线能力，每家都收）。SSH 节点的 Agent 在另一台机器上，本机路径对它
 *     没有意义：这时只能内嵌，内嵌不了就拒绝（`acp_attachment_unsupported`）。
 *   * **镜像与事件里只有链接**：图片与文件正文只进 Agent 的这一次 prompt，不进
 *     镜像、`acp.update` 与日志；重载后用户消息里是一枚带名字的徽标。
 */

/** 图片块收的四种（各家模型都认的那几种）。 */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** 内嵌正文的文本文件最多这么大。 */
export const MAX_EMBEDDED_TEXT_BYTES = 256 * 1024;

const TEXT_TYPES = [
  /^text\//,
  /^application\/(json|xml|javascript|x-javascript|typescript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php)$/,
  /\+(json|xml)$/,
];

export interface PromptCapabilities {
  readonly image: boolean;
  readonly embeddedContext: boolean;
}

export interface AttachmentBlocks {
  /** 发给 Agent 的块，按上传的次序。 */
  readonly blocks: readonly AcpContentBlock[];
  /** 记进镜像、随 `user_message_chunk` 发出去的那一份：只有名字与位置。 */
  readonly links: readonly Extract<
    MirrorMediaBlock,
    { type: "resource_link" }
  >[];
}

function textual(mimeType: string): boolean {
  return TEXT_TYPES.some((pattern) => pattern.test(mimeType));
}

/** UTF-8 能解、没有 NUL：当文本。 */
function asText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function attachmentBlocks(
  uploads: readonly StoredUpload[],
  capabilities: PromptCapabilities | null,
  remote: boolean,
  read: (path: string) => Buffer = (path) => readFileSync(path),
): AttachmentBlocks {
  const blocks: AcpContentBlock[] = [];
  const links: AttachmentBlocks["links"][number][] = [];
  for (const upload of uploads) {
    const uri = pathToFileURL(upload.path).href;
    const link = {
      type: "resource_link" as const,
      uri,
      name: upload.name,
      mimeType: upload.mimeType,
    };
    if (IMAGE_TYPES.has(upload.mimeType)) {
      if (capabilities?.image !== true) {
        throw new AcpError(
          "acp_image_unsupported",
          "this agent does not take images",
        );
      }
      if (upload.bytes > MAX_ACP_IMAGE_BYTES) {
        throw new AcpError(
          "acp_attachment_too_large",
          "the image is too large",
        );
      }
      blocks.push({
        type: "image",
        mimeType: upload.mimeType,
        data: read(upload.path).toString("base64"),
        ...(remote ? {} : { uri }),
      });
      links.push(link);
      continue;
    }
    const embeddable =
      capabilities?.embeddedContext === true &&
      upload.bytes <= MAX_EMBEDDED_TEXT_BYTES &&
      (textual(upload.mimeType) ||
        upload.mimeType === "application/octet-stream");
    const text = embeddable ? asText(read(upload.path)) : undefined;
    if (text !== undefined) {
      blocks.push({
        type: "resource",
        resource: {
          uri,
          text,
          ...(upload.mimeType === "application/octet-stream"
            ? { mimeType: "text/plain" }
            : { mimeType: upload.mimeType }),
        },
      });
    } else if (remote) {
      throw new AcpError(
        "acp_attachment_unsupported",
        "this agent runs on another host and cannot open a local file",
      );
    } else {
      blocks.push({ ...link, size: upload.bytes });
    }
    links.push(link);
  }
  return { blocks, links };
}
