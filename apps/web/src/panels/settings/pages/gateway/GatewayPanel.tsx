import * as React from "react";
import { ChevronRight } from "lucide-react";
import {
  GATEWAY_LISTEN_CHOICES,
  GATEWAY_TLS_SOURCES,
  type GatewayConfigPatch,
  type GatewayPairingPayload,
  type GatewayStatus,
} from "@armadra/shared";

import { usePreferencesStore, useT } from "../../../../app/preferences-store";
import { CONTROL_WIDTH } from "../GeneralPage";
import { SettingsGroup } from "../../SettingsGroup";
import { SettingsRow } from "../../SettingsRow";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Input } from "@/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";
import { Switch } from "@/ui/switch";
import {
  GatewayDevices,
  type GatewayDevice,
  type GatewayDevicesProps,
} from "./GatewayDevices";
import { PairingCard } from "./PairingCard";

const KNOWN_ERRORS = new Set([
  "acme_misconfigured",
  "acme_port_unavailable",
  "acme_failed",
  "tls_files_missing",
  "port_in_use",
  "port_forbidden",
  "identity_unavailable",
  "gateway_failed",
]);

/** 契约 §17.1 的 `error.code` → 文案键；不认识的码归到「没能开启」。 */
export function gatewayErrorKey(code: string): string {
  return `gateway.error.${KNOWN_ERRORS.has(code) ? code : "gateway_failed"}`;
}

/** 失焦或回车时才提交的输入框；外面的值变了就跟着换。 */
function CommitInput({
  value,
  onCommit,
  label,
  ...rest
}: {
  value: string;
  onCommit(value: string): void;
  label: string;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      {...rest}
      aria-label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
      }}
    />
  );
}

export interface GatewayPanelProps {
  status: GatewayStatus;
  /** 正在写配置。 */
  saving: boolean;
  onConfigure(patch: GatewayConfigPatch): void;
  pairing: GatewayPairingPayload | null;
  pairingBusy: boolean;
  onNewPairing(origin?: string): void;
  /** `null`：没有会话、读不到——整块不出现。 */
  devices: readonly GatewayDevice[] | null;
  revoking: string | null;
  onRevoke(device: GatewayDevice): void;
  /** 设备表的其余选项：当前设备、撤销权、分页。 */
  deviceOptions?: Omit<
    GatewayDevicesProps,
    "devices" | "revoking" | "onRevoke"
  >;
  /** 展示页用：钉住时钟、展开「更多选项」。 */
  now?: number;
  defaultMoreOpen?: boolean;
  /**
   * 页面正经这个对外服务直连到主机：开关与监听配置一改就是自断，只读。
   * 配对与设备表照常。
   */
  inUse?: boolean;
}

/**
 * 设置 → 后台服务与对外服务 → 对外服务（设计系统 §5.12，补全架构 §7）。
 *
 * 关着时只有开关那一行（不写「未开启」）；开着时是监听地址、更多选项、
 * 配对卡。已配对设备与开关无关，一直在。服务器壳托管时（`managedBy:
 * shell`）配置来自命令行，控件全部只读，配对照常。
 */
export function GatewayPanel({
  status,
  saving,
  onConfigure,
  pairing,
  pairingBusy,
  onNewPairing,
  devices,
  revoking,
  onRevoke,
  deviceOptions,
  now,
  defaultMoreOpen = false,
  inUse = false,
}: GatewayPanelProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const locked = status.managedBy === "shell" || saving || inUse;
  const tlsSource =
    status.tls.source === "selfSigned" ? "localCa" : status.tls.source;
  const starting = status.enabled && !status.running && !status.error;
  // ACME 续期失败时旧证书继续服务（契约 §17.1 `tls.acme`）；这里只说发生了
  // 什么与下次什么时候再试，没有失败就什么都不画。
  const acme = status.enabled && status.running ? status.tls.acme : null;
  const renewFailed = acme ? acme.failures > 0 : false;
  const retryAt = renewFailed && acme?.renewAt ? new Date(acme.renewAt) : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SettingsGroup>
        <SettingsRow
          label={t("gateway.title")}
          {...(inUse ? { footnote: t("remote.inUse") } : {})}
        >
          <div className="flex items-center gap-2">
            {saving && <Spinner aria-label={t("gateway.title")} />}
            <Switch
              checked={status.enabled}
              disabled={locked}
              aria-label={t("gateway.title")}
              onCheckedChange={(enabled) => onConfigure({ enabled })}
            />
          </div>
        </SettingsRow>
        {status.enabled && (
          <>
            <SettingsRow label={t("gateway.listen")}>
              <Select
                value={status.listen}
                disabled={locked}
                onValueChange={(listen) =>
                  onConfigure({
                    listen: listen as GatewayStatus["listen"],
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label={t("gateway.listen")}
                  className={CONTROL_WIDTH}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[var(--z-dialog)]">
                  {GATEWAY_LISTEN_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {t(`gateway.listen.${choice}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
            <Collapsible
              defaultOpen={defaultMoreOpen}
              className="group/more divide-y divide-border/60"
            >
              <div className="px-4 py-1.5">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 text-[13px] font-normal text-muted-foreground"
                  >
                    <ChevronRight className="transition-transform group-data-[state=open]/more:rotate-90" />
                    {t("gateway.more")}
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="divide-y divide-border/60">
                <SettingsRow label={t("gateway.port")}>
                  <CommitInput
                    label={t("gateway.port")}
                    inputMode="numeric"
                    disabled={locked}
                    placeholder={t("gateway.port.auto")}
                    className={`${CONTROL_WIDTH} h-8 tabular-nums`}
                    value={status.port === 0 ? "" : String(status.port)}
                    onCommit={(text) => {
                      const port = text === "" ? 0 : Number(text);
                      if (Number.isInteger(port) && port >= 0 && port <= 65_535)
                        onConfigure({ port });
                    }}
                  />
                </SettingsRow>
                <SettingsRow label={t("gateway.publicOrigin")}>
                  <CommitInput
                    label={t("gateway.publicOrigin")}
                    disabled={locked}
                    inputMode="url"
                    placeholder="https://armadra.example"
                    className="h-8 w-[240px] max-w-full"
                    value={status.publicOrigin}
                    onCommit={(publicOrigin) => onConfigure({ publicOrigin })}
                  />
                </SettingsRow>
                <SettingsRow label={t("gateway.tls")}>
                  <Select
                    value={tlsSource}
                    disabled={locked}
                    onValueChange={(source) =>
                      onConfigure({
                        tls: {
                          source:
                            source as (typeof GATEWAY_TLS_SOURCES)[number],
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={t("gateway.tls")}
                      className={CONTROL_WIDTH}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[var(--z-dialog)]">
                      {GATEWAY_TLS_SOURCES.map((source) => (
                        <SelectItem key={source} value={source}>
                          {t(`gateway.tls.${source}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
                {tlsSource === "file" &&
                  (["certFile", "keyFile"] as const).map((key) => (
                    <SettingsRow key={key} label={t(`gateway.tls.${key}`)}>
                      <CommitInput
                        label={t(`gateway.tls.${key}`)}
                        disabled={locked}
                        className="h-8 w-[240px] max-w-full font-mono text-[12px]"
                        value={status.tls[key]}
                        onCommit={(value) =>
                          onConfigure({ tls: { [key]: value } })
                        }
                      />
                    </SettingsRow>
                  ))}
                {tlsSource === "acme" && (
                  <SettingsRow label={t("gateway.tls.acmeEmail")}>
                    <CommitInput
                      label={t("gateway.tls.acmeEmail")}
                      disabled={locked}
                      type="email"
                      className="h-8 w-[240px] max-w-full"
                      value={status.tls.acmeEmail}
                      onCommit={(acmeEmail) =>
                        onConfigure({ tls: { acmeEmail } })
                      }
                    />
                  </SettingsRow>
                )}
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </SettingsGroup>

      {status.enabled && status.error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t(gatewayErrorKey(status.error.code))}</AlertTitle>
        </Alert>
      )}
      {renewFailed && (
        <Alert variant="destructive" data-slot="gateway-acme-renew-failed">
          <AlertTitle>{t("gateway.acme.renewFailed")}</AlertTitle>
          {retryAt && (
            <AlertDescription className="tabular-nums">
              {t("gateway.acme.retryAt", {
                time: retryAt.toLocaleString(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </AlertDescription>
          )}
        </Alert>
      )}
      {starting && (
        <Alert>
          <Spinner aria-hidden />
          <AlertTitle>{t("gateway.starting")}</AlertTitle>
        </Alert>
      )}
      {status.enabled && status.running && (
        <PairingCard
          pairing={pairing}
          busy={pairingBusy}
          origins={status.origins}
          fingerprint={status.tls.fingerprint}
          caHref={
            status.tls.caAvailable && status.origin
              ? `${status.origin}/ca.crt`
              : null
          }
          onNewPairing={onNewPairing}
          now={now}
        />
      )}
      {devices && (
        <GatewayDevices
          devices={devices}
          revoking={revoking}
          onRevoke={onRevoke}
          {...deviceOptions}
        />
      )}
    </div>
  );
}
