import type { ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { CaInstallGuide } from "@/panels/settings/pages/gateway/CaInstallGuide";
import { GatewayPanel } from "@/panels/settings/pages/gateway/GatewayPanel";
import { PairingCard } from "@/panels/settings/pages/gateway/PairingCard";
import {
  CA_HREF,
  CURRENT_DEVICE,
  DEVICES,
  EXPIRED_NOW,
  FAILED,
  NOW,
  OFF,
  PAIRING,
  RENEW_FAILED,
  RUNNING,
  STARTING,
} from "../fixtures/gateway";

const noop = () => undefined;

function Sample({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-[12px] text-muted-foreground">
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

/**
 * `gateway` 分区（设计展示页 §2.1，设计系统 §5.12）：设置页里真的
 * `GatewayPanel` / `PairingCard` / `CaInstallGuide`，喂假数据。
 *
 * 关闭（只有开关一行）· 运行中（二维码、倒计时、指纹与 CA、设备表——当前
 * 设备带「当前」、一行正在撤销、底部「加载更多」）· 正在生成证书 · 没能开启 ·
 * ACME 续期失败 · 配对码过期 · 手机配对页的 CA 引导。时钟钉住，截图稳定。
 */
export default function GatewaySection() {
  const t = useT();
  const panel = {
    saving: false,
    onConfigure: noop,
    pairing: null,
    pairingBusy: false,
    onNewPairing: noop,
    devices: null,
    revoking: null,
    onRevoke: noop,
    now: NOW,
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("gateway.showcase.off")}>
          <GatewayPanel {...panel} status={OFF} />
        </Sample>
        <Sample caption={t("showcase.state.loading")}>
          <GatewayPanel {...panel} status={STARTING} />
        </Sample>
        <Sample caption={t("gateway.showcase.error")}>
          <GatewayPanel {...panel} status={FAILED} />
        </Sample>
        <Sample caption={t("gateway.pair.expired")}>
          <PairingCard
            pairing={PAIRING}
            busy={false}
            origins={[PAIRING.origin]}
            fingerprint={PAIRING.fingerprint}
            caHref={null}
            onNewPairing={noop}
            now={EXPIRED_NOW}
          />
        </Sample>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <Sample caption={t("gateway.showcase.running")}>
          <GatewayPanel
            {...panel}
            status={RUNNING}
            pairing={PAIRING}
            devices={DEVICES}
            revoking="dev-ipad"
            deviceOptions={{
              currentDeviceId: CURRENT_DEVICE,
              hasMore: true,
              onMore: noop,
            }}
          />
        </Sample>
        <Sample caption={t("gateway.acme.renewFailed")}>
          <GatewayPanel {...panel} status={RENEW_FAILED} />
        </Sample>
        <Sample caption={t("gateway.showcase.phone")}>
          <div className="w-full max-w-[390px]">
            <CaInstallGuide href={CA_HREF} defaultOpen platform="ios" />
          </div>
        </Sample>
      </div>
    </div>
  );
}
