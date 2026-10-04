import * as React from "react";
import { ChevronLeft } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { MessageList } from "@/acp/MessageList";
import { PermissionCard } from "@/acp/PermissionCard";
import { PromptBox } from "@/acp/PromptBox";
import { ConnectScreen } from "@/mobile/ConnectScreen";
import {
  PushPermissionDock,
  PushPermissionPrompt,
} from "@/mobile/PushPermission";
import { CaInstallGuide } from "@/panels/settings/pages/gateway/CaInstallGuide";
import { useCompactLayout } from "@/platform/layout";
import { MobileBottomNav } from "@/shell/MobileBottomNav";
import { TerminalKeyBar } from "@/shell/MobileFocusPage";
import { Button } from "@/ui/button";
import { Select, SelectTrigger, SelectValue } from "@/ui/select";
import {
  ACP_MODES,
  ACP_PERMISSION,
  ACP_STREAMING_ITEMS,
} from "../fixtures/acp";
import {
  MOBILE_CA_HREF,
  MOBILE_CODE,
  MOBILE_LINK,
  MOBILE_ORIGIN,
  MOBILE_SAMPLES,
  type MobileSampleId,
} from "../fixtures/mobile";

const never = () => new Promise<null>(() => undefined);
const noop = () => undefined;
const sent = async () => true;

/**
 * `mobile` 分区（设计展示页 §2.1，设计系统 §5.12 末条、§5.13）。每个样本一块
 * 390×844 的「屏幕」：`transform` 让里面 `fixed` 的东西（推送提示条）以这块
 * 屏幕为参照，所以宽屏下也是手机里的样子；真在手机上就依次铺开。底部导航只在
 * 手机布局里渲染，宽屏下推送样本里没有它。
 */
export default function MobileSection() {
  const compact = useCompactLayout();
  return (
    <div className={compact ? "flex flex-col gap-6" : "flex flex-wrap gap-6"}>
      {MOBILE_SAMPLES.map((id) => (
        <Screen key={id} id={id} />
      ))}
    </div>
  );
}

/** 一屏。`inline` 时在文档流里（真手机上的分区页），否则铺满 iframe。 */
function Screen({
  id,
  inline = false,
}: {
  id: MobileSampleId;
  inline?: boolean;
}) {
  const t = useT();
  const body = (() => {
    switch (id) {
      case "native":
        return (
          <ConnectScreen
            mode="native"
            canScan
            onConnect={never}
            onScan={never}
          />
        );
      case "web":
        return (
          <ConnectScreen
            mode="web"
            origin={MOBILE_ORIGIN}
            onConnect={never}
            caGuide={
              <CaInstallGuide
                href={MOBILE_CA_HREF}
                defaultOpen
                platform="ios"
              />
            }
          />
        );
      case "code":
        return (
          <ConnectScreen
            mode="web"
            origin={MOBILE_ORIGIN}
            codeFirst
            initialCode={MOBILE_CODE}
            onCode={never}
            onSignIn={noop}
            onConnect={never}
          />
        );
      case "error":
        return (
          <ConnectScreen
            mode="native"
            canScan
            initialLink={MOBILE_LINK}
            failure="expired"
            onConnect={never}
            onScan={never}
          />
        );
      case "push":
        return (
          <div className="relative h-full bg-[var(--bg)]">
            <PushPermissionDock>
              <PushPermissionPrompt
                busy={false}
                onEnable={noop}
                onLater={noop}
              />
            </PushPermissionDock>
            <MobileBottomNav />
          </div>
        );
      case "focusAcp":
        return (
          <FocusFrame title="claude · parseConfig">
            <div
              data-slot="acp-session-view"
              className="flex min-h-0 flex-1 flex-col bg-[var(--card)] [&_textarea]:text-[length:var(--text-input-touch)]"
            >
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
                <MessageList items={ACP_STREAMING_ITEMS} streaming />
              </div>
              <PermissionCard
                permission={ACP_PERMISSION}
                canAnswer
                className="mx-2 mb-1.5"
              />
              <PromptBox
                sessionId={null}
                disabled={false}
                streaming
                modes={ACP_MODES}
                onSubmit={sent}
                onCancel={noop}
                onMode={noop}
              />
            </div>
          </FocusFrame>
        );
      case "focusTerminal":
        return (
          <FocusFrame title={t("node.terminal")}>
            <pre className="min-h-0 flex-1 overflow-hidden bg-[var(--terminal-bg,var(--card))] p-3 font-mono text-[12px] leading-5 text-foreground">
              {
                "$ pnpm test\n\n ✓ src/config.test.ts (12)\n ✓ src/loader.test.ts (7)\n\n Test Files  2 passed (2)\n      Tests  19 passed (19)\n$ "
              }
            </pre>
            <TerminalKeyBar nodeId="showcase" />
          </FocusFrame>
        );
    }
  })();
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-[12px] text-muted-foreground">
        {t(`mobileConnect.showcase.${id}`)}
      </figcaption>
      <div
        data-mobile-sample={id}
        className="relative h-[844px] w-full max-w-[390px] overflow-hidden rounded-[var(--r-panel)] border border-border bg-background [transform:translateZ(0)] sm:w-[390px] [&_[data-slot=mobile-connect]]:min-h-full"
      >
        {body}
      </div>
    </figure>
  );
}

/** 焦点页的骨架：与 `MobileFocusPage` 同一个顶栏（返回 + 节点选择）。 */
function FocusFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button size="sm" variant="ghost" className="min-h-10 shrink-0 px-2">
          <ChevronLeft aria-hidden />
          <span>{t("mobile.focus.back")}</span>
        </Button>
        <Select value="node">
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            aria-label={t("mobile.focus.switch")}
          >
            <SelectValue>{title}</SelectValue>
          </SelectTrigger>
        </Select>
      </div>
      {children}
    </div>
  );
}
