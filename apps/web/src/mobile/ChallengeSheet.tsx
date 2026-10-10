import { useT } from "../app/preferences-store";
import {
  ChallengeFrame,
  type ChallengeFrameProps,
} from "../challenge/ChallengeFrame";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet";

export interface ChallengeSheetProps
  extends Pick<ChallengeFrameProps, "issuer" | "siteKey" | "origin" | "load"> {
  readonly open: boolean;
  readonly onToken: (token: string) => void;
  readonly onCancel: () => void;
}

/**
 * 登录要过人机验证时从底部升起的面板（契约 §62.2）：手机连接页、中继托管页面与
 * 设置里的中转账号登录框共用。拿到令牌即交回，由调用方带着重提交。
 */
export function ChallengeSheet({
  open,
  onToken,
  onCancel,
  ...frame
}: ChallengeSheetProps) {
  const t = useT();
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <SheetContent side="bottom" className="z-[var(--z-dialog)] gap-3 p-4">
        <SheetHeader className="p-0">
          <SheetTitle>{t("challenge.title")}</SheetTitle>
        </SheetHeader>
        <ChallengeFrame {...frame} onToken={onToken} />
      </SheetContent>
    </Sheet>
  );
}
