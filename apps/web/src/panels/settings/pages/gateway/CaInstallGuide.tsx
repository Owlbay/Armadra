import * as React from "react";
import { ChevronDown, Download } from "lucide-react";

import { useT } from "../../../../app/preferences-store";
import { hasPairingFragment } from "../../../../api/identity";
import { RUNTIME_VIA_SERVER_SHELL } from "../../../../api/request";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

const STEPS = {
  ios: [
    "gateway.ca.ios.1",
    "gateway.ca.ios.2",
    "gateway.ca.ios.3",
    "gateway.ca.ios.4",
  ],
  android: [
    "gateway.ca.android.1",
    "gateway.ca.android.2",
    "gateway.ca.android.3",
  ],
} as const;

/** 猜一个缺省分页：只看 UA，猜错了点一下就换。 */
export function defaultPlatform(
  userAgent = globalThis.navigator?.userAgent ?? "",
): "ios" | "android" {
  return /android/i.test(userAgent) ? "android" : "ios";
}

/**
 * 配对页上的 CA 安装引导（补全架构 §7「手机网页与证书」）。
 *
 * iOS 上即使接受了证书警告，`wss` 仍会静默失败，画布实时与终端都不可用，
 * 所以经 Gateway 打开的页面要先把本地 CA 装进系统、再刷新。收起时只有一个
 * 按钮；展开是 iOS / Android 两页步骤与下载按钮。
 */
export function CaInstallGuide({
  href,
  defaultOpen = false,
  platform = defaultPlatform(),
}: {
  /** `GET /ca.crt`。 */
  href: string;
  defaultOpen?: boolean;
  platform?: "ios" | "android";
}) {
  const t = useT();
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="group/ca rounded-lg border border-border/70 bg-card"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-12 w-full justify-between rounded-lg px-4 text-[13px] font-normal"
        >
          {t("gateway.ca.title")}
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]/ca:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 px-4 pb-4">
        <Tabs defaultValue={platform}>
          <TabsList>
            <TabsTrigger value="ios">iOS</TabsTrigger>
            <TabsTrigger value="android">Android</TabsTrigger>
          </TabsList>
          {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((key) => (
            <TabsContent key={key} value={key}>
              <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-5">
                {STEPS[key].map((step) => (
                  <li key={step}>{t(step)}</li>
                ))}
              </ol>
            </TabsContent>
          ))}
        </Tabs>
        <Button asChild size="sm" className="w-fit">
          <a href={href} download="armadra-ca.crt">
            <Download data-icon="inline-start" />
            {t("gateway.ca.download")}
          </a>
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Gateway 的匿名路径（契约 §17.4），只在 Gateway 上有。 */
const CA_PATH = "/ca.crt";

/**
 * 这张页面是经 Gateway（HTTPS、页面与 core 同源）打开的、而且那边有 CA 可发时，
 * 给出安装引导。桌面窗口与本机开发页都不满足，什么也不画。带着配对片段打开
 * （刚扫完码）时默认展开。
 */
export function PageCaGuide({
  served = RUNTIME_VIA_SERVER_SHELL,
}: {
  served?: boolean;
}) {
  const [href, setHref] = React.useState<string | null>(null);
  const [pairing] = React.useState(() => hasPairingFragment());
  React.useEffect(() => {
    const location = globalThis.location;
    if (!served || location?.protocol !== "https:") return;
    const url = new URL(CA_PATH, location.origin).href;
    const controller = new AbortController();
    fetch(url, { method: "HEAD", signal: controller.signal })
      .then((response) => {
        if (response.ok) setHref(url);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [served]);
  if (!href) return null;
  return <CaInstallGuide href={href} defaultOpen={pairing} />;
}
