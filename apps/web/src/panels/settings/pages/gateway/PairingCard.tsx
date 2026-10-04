import * as React from "react";
import { Copy, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { GatewayPairingPayload } from "@armadra/shared";

import { useT } from "../../../../app/preferences-store";
import { encodeQr, pairingQrText, qrPath } from "../../../../host/qr";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { Kbd } from "@/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Spinner } from "@/ui/spinner";

/** 二维码四周留四个模块的静区（规范要求），否则贴着卡片边扫不出来。 */
const QUIET = 4;

/**
 * 白底黑码，不随主题变（设计系统 §5.12：扫码可靠性优先）。整块图一条 path。
 */
export function QrImage({
  text,
  label,
  dimmed = false,
}: {
  text: string;
  label: string;
  dimmed?: boolean;
}) {
  const code = React.useMemo(() => encodeQr(text), [text]);
  if (!code) return null;
  const extent = code.size + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-text={text}
      viewBox={`${-QUIET} ${-QUIET} ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className={`size-[200px] shrink-0 rounded-md transition-opacity ${dimmed ? "opacity-20" : ""}`}
    >
      <rect x={-QUIET} y={-QUIET} width={extent} height={extent} fill="white" />
      <path d={qrPath(code)} fill="black" />
    </svg>
  );
}

/** `m:ss`。 */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 每秒走一次的「现在」；`active` 为假时停表。 */
function useNow(active: boolean, initial?: number): number {
  const [now, setNow] = React.useState(() => initial ?? Date.now());
  React.useEffect(() => {
    if (!active || initial !== undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, initial]);
  return initial ?? now;
}

export interface PairingCardProps {
  pairing: GatewayPairingPayload | null;
  /** 正在铸票。 */
  busy: boolean;
  /** 可选的来源；多于一个时给一个下拉框。 */
  origins: readonly string[];
  fingerprint: string | null;
  /** `GET /ca.crt` 的地址；没有 CA 可发时为 `null`。 */
  caHref: string | null;
  onNewPairing(origin?: string): void;
  /** 展示页用：钉住时钟。 */
  now?: number;
}

/**
 * 配对卡：二维码 · 地址 · 复制链接 / 新配对码 · 配对码与倒计时 · 指纹与 CA
 * 下载（设计系统 §5.12）。
 *
 * 票两分钟一次性（契约 §17.3）；私网档位上同时有一枚 8 位配对码（§24），与票
 * 同生同灭，过期时随倒计时一起收起。归零后图变淡、按钮变成主按钮；不自动续，
 * 免得一张开着没人看的页面每两分钟铸一张票。
 */
export function PairingCard({
  pairing,
  busy,
  origins,
  fingerprint,
  caHref,
  onNewPairing,
  now: fixedNow,
}: PairingCardProps) {
  const t = useT();
  const expiresAt = pairing ? Date.parse(pairing.expiresAt) : 0;
  const now = useNow(pairing !== null, fixedNow);
  const remaining = expiresAt - now;
  const expired = pairing !== null && remaining <= 0;

  async function copy() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.webUrl);
      toast.success(t("gateway.pair.copied"));
    } catch {
      toast.error(t("gateway.pair.copyFailed"));
    }
  }

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4 px-4 sm:flex-row sm:items-start">
        <div className="flex size-[200px] shrink-0 items-center justify-center self-center sm:self-start">
          {pairing ? (
            <QrImage
              text={pairingQrText(pairing)}
              label={t("gateway.pair.qr")}
              dimmed={expired}
            />
          ) : busy ? (
            <Spinner aria-label={t("gateway.pairCode.new")} />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {origins.length > 1 ? (
            <Select
              value={pairing?.origin ?? origins[0]}
              disabled={busy}
              onValueChange={(origin) => onNewPairing(origin)}
            >
              <SelectTrigger
                size="sm"
                aria-label={t("gateway.pair.origin")}
                className="w-full max-w-full font-mono text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {origins.map((origin) => (
                  <SelectItem
                    key={origin}
                    value={origin}
                    className="font-mono text-[12px]"
                  >
                    {origin}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="break-all font-mono text-[13px] select-text">
              {pairing?.origin ?? origins[0]}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!pairing || expired}
              onClick={() => void copy()}
            >
              <Copy data-icon="inline-start" />
              {t("gateway.pair.copy")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={expired || !pairing ? "default" : "outline"}
              disabled={busy}
              onClick={() => onNewPairing(pairing?.origin)}
            >
              <RefreshCw data-icon="inline-start" />
              {t("gateway.pairCode.new")}
            </Button>
          </div>
          {pairing && (
            <div
              className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums"
              aria-live="off"
            >
              {pairing.code && !expired && (
                <>
                  <span className="text-muted-foreground">
                    {t("gateway.pairCode.label")}
                  </span>
                  <Kbd
                    data-pairing-code
                    className="h-6 px-1.5 font-mono text-[13px] tracking-[0.12em] text-foreground select-text"
                  >
                    {pairing.code}
                  </Kbd>
                </>
              )}
              <span
                className={
                  expired ? "text-destructive" : "text-muted-foreground"
                }
              >
                {expired
                  ? t("gateway.pair.expired")
                  : pairing.code
                    ? countdown(remaining)
                    : t("gateway.pair.expiresIn", {
                        time: countdown(remaining),
                      })}
              </span>
            </div>
          )}
          {fingerprint && (
            <div className="mt-auto flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3">
              <div className="min-w-0 text-[12px]">
                <span className="text-muted-foreground">
                  {t("gateway.fingerprint")}
                </span>
                <p className="mt-1 break-all font-mono text-[11px] leading-4 select-text">
                  {groupFingerprint(fingerprint)}
                </p>
              </div>
              {caHref && (
                <Button asChild size="sm" variant="ghost" className="w-fit">
                  <a href={caHref} download="armadra-ca.crt">
                    <Download data-icon="inline-start" />
                    {t("gateway.ca.download")}
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** 64 位十六进制按两位一组、冒号分开，和系统证书详情里的写法一样，好对照。 */
export function groupFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":");
}
