import {
  File,
  FileCode,
  FileImage,
  FileText,
  Globe,
  ImageOff,
  type LucideIcon,
} from "lucide-react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useCanvasStore } from "@/store/canvas-store";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/ui/item";
import { CopyAction } from "./MessageActions";
import { linkTarget, openLink } from "./open-link";
import type { AcpAttachment } from "./store";

type ImageAttachment = Extract<AcpAttachment, { type: "image" }>;
type LinkAttachment = Extract<AcpAttachment, { type: "resource_link" }>;

/** 图片缩略图：1px 的前景色 10% 描边（浅色压黑、深色压白），不进 `alt`。 */
function Thumbnail({ image }: { image: ImageAttachment }) {
  const t = useT();
  const src = image.data
    ? `data:${image.mimeType};base64,${image.data}`
    : image.uri;
  if (!src || image.dropped) {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <ImageOff aria-hidden />
        {t("acp.image.dropped")}
      </Badge>
    );
  }
  return (
    <img
      src={src}
      alt={t("acp.image.alt")}
      className="max-h-40 w-auto max-w-full self-start rounded-[var(--r-control)] object-contain outline outline-1 -outline-offset-1 outline-[color-mix(in_oklab,var(--foreground)_10%,transparent)]"
    />
  );
}

function iconOf(link: LinkAttachment): LucideIcon {
  const mime = link.mimeType ?? "";
  if (/^https?:/.test(link.uri)) return Globe;
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("text/x-") || mime.includes("javascript"))
    return FileCode;
  if (mime.startsWith("text/")) return FileText;
  return File;
}

/** 资源链接：图标按 `mimeType`、标题是名字、副标题是截断的 URI。 */
function Link({ link, compact }: { link: LinkAttachment; compact: boolean }) {
  const t = useT();
  const root = useCanvasStore((state) => state.workspace?.rootPath);
  const target = linkTarget(link.uri, root);
  const Icon = iconOf(link);
  if (compact) {
    return (
      <Badge variant="outline" className="max-w-full" title={link.uri}>
        <Icon aria-hidden />
        <span className="truncate">{link.title ?? link.name}</span>
      </Badge>
    );
  }
  return (
    <Item
      size="sm"
      variant="outline"
      className="group/act max-w-[72ch] px-2 py-1.5"
      data-slot="acp-resource-link"
    >
      <ItemMedia>
        <Icon className="size-4 text-muted-foreground" aria-hidden />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0">
        <ItemTitle className="w-full truncate text-[13px] font-normal">
          {link.title ?? link.name}
        </ItemTitle>
        <ItemDescription
          className="truncate font-mono text-[length:var(--text-caption)]"
          title={link.uri}
        >
          {link.uri}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="gap-0.5">
        {target && (
          <Button
            size="xs"
            variant="ghost"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => openLink(target)}
          >
            {t("acp.link.open")}
          </Button>
        )}
        <CopyAction text={link.uri} label={t("acp.link.copy")} />
      </ItemActions>
    </Item>
  );
}

/**
 * 一条消息里文字以外的块（契约 §49）。用户消息里画成紧凑的徽标（气泡里
 * 放不下一整行），助手消息里资源链接是一行 `Item`。
 */
export function Attachments({
  attachments,
  compact = false,
  className,
}: {
  attachments: readonly AcpAttachment[];
  compact?: boolean;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        compact && "flex-row flex-wrap items-start",
        className,
      )}
    >
      {attachments.map((attachment, index) =>
        attachment.type === "image" ? (
          <Thumbnail key={index} image={attachment} />
        ) : (
          <Link key={index} link={attachment} compact={compact} />
        ),
      )}
    </div>
  );
}
