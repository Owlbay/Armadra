import { useT } from "../app/preferences-store";
import {
  ChallengeFrame,
  type ChallengeFrameProps,
} from "../challenge/ChallengeFrame";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "../panels/ResponsiveDialog";

export interface ChallengeSheetProps
  extends Pick<ChallengeFrameProps, "issuer" | "siteKey" | "origin" | "load"> {
  readonly open: boolean;
  readonly onToken: (token: string) => void;
  readonly onCancel: () => void;
}

/**
 * 登录要过人机验证时升起的面板（契约 §62.2）：手机上贴底成抽屉，宽屏是对话框
 * （`ResponsiveDialog`）。手机连接页、中继托管页面与设置里的中转账号登录框共用。
 * 拿到令牌即交回，由调用方带着重提交。
 */
export function ChallengeSheet({
  open,
  onToken,
  onCancel,
  ...frame
}: ChallengeSheetProps) {
  const t = useT();
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <ResponsiveDialogContent className="z-[var(--z-dialog)] gap-3 sm:max-w-[360px]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{t("challenge.title")}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ChallengeFrame {...frame} onToken={onToken} />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
