import * as React from "react";

import { type JoinLink, joinDeepLink, parseJoinLink } from "@armadra/shared";

import { localizedFailure } from "../api/request";
import { LOCAL_SOURCE_ID } from "../api/source";
import { usePreferencesStore, useT } from "../app/preferences-store";
import {
  type CloudLinkInfo,
  type CloudOptions,
  CloudError,
  browserDevice,
  cloudAcceptLink,
  cloudLinkInfo,
  coreCloudLogin,
} from "../mobile/cloud-client";
import { type RelayPageJoin, enterRelayPage } from "../mobile/relay-page";
import { openAfterJoin } from "../sources/join-intent";
import { Alert, AlertTitle } from "@/ui/alert";
import { BrandMark } from "@/ui/brand-mark";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";

/** 加入之后页面落在哪（远程服务托管的页面根，cloud-api §10）。 */
const APP_PATH = "/app/";

const ROLES = new Set(["viewer", "editor", "operator", "driver"]);

export interface JoinPageProps {
  /** 加入成功、本机源已指到那台 core：换成画布。 */
  onJoined(): void;
  /** 测试换掉网络与装配。 */
  readonly cloud?: CloudOptions;
  readonly enter?: (join: RelayPageJoin) => void;
  readonly href?: string;
}

/**
 * 失败 → 界面那句：按码取（`errors.ts`），认不出的码是「没能加入」，连不上是
 * 「连不上这台机器」。不展示对端的原话。
 */
function failureText(error: unknown, fallback: string): string {
  if (error instanceof CloudError)
    return localizedFailure(error.code, fallback);
  return localizedFailure("source_unreachable", fallback);
}

/**
 * 分享链接的落地页（客户端包 §6.1，个人中转）：远程服务托管同一份页面，打开在
 * `<issuer>/j/<linkId>#<秘密>.<邀请令牌>`。
 *
 * 1. 片段一读进内存就从地址栏抹掉（秘密不留在历史里）；`links.get` 显示指向
 *    哪台机器、什么权限、何时过期。
 * 2. 「加入」：`links.accept`（匿名，访客）→ 经 `relayBaseUrl` `cloud/login`
 *    （断言 + 邀请令牌）→ 本机源指到那台 core（会话只在内存）→ 地址换成
 *    `/app/`、就地进画布，打开链接指向的工作空间。
 * 3. 「在 Armadra 中打开」：同一条链接的 `armadra://join` 深链（桌面与手机）。
 */
export function JoinPage({
  onJoined,
  cloud,
  enter = enterRelayPage,
  href,
}: JoinPageProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const [link] = React.useState<JoinLink | null>(() =>
    parseJoinLink(href ?? globalThis.location?.href ?? ""),
  );
  const [info, setInfo] = React.useState<CloudLinkInfo | null>(null);
  const [failure, setFailure] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    try {
      globalThis.history?.replaceState(null, "", globalThis.location.pathname);
    } catch {
      /* 抹不掉不影响加入。 */
    }
  }, []);

  React.useEffect(() => {
    if (link === null) return;
    let live = true;
    cloudLinkInfo(link.issuer, link.linkId, cloud).then(
      (answer) => {
        if (!live) return;
        setInfo(answer);
        if (answer.exhausted)
          setFailure(localizedFailure("link_exhausted", ""));
      },
      (error: unknown) => {
        if (live) setFailure(failureText(error, t("links.page.failed")));
      },
    );
    return () => {
      live = false;
    };
  }, [cloud, link, t]);

  const join = async () => {
    if (link === null || busy) return;
    setBusy(true);
    setFailure("");
    try {
      const accepted = await cloudAcceptLink(
        link.issuer,
        link.linkId,
        link.secret,
        browserDevice(),
        cloud,
      );
      const core = await coreCloudLogin(
        accepted.relayBaseUrl,
        accepted.relayToken,
        accepted.assertion,
        link.invitationToken,
        cloud,
      );
      enter({ issuer: link.issuer, accepted, core });
      openAfterJoin(LOCAL_SOURCE_ID);
      try {
        globalThis.history?.replaceState(null, "", APP_PATH);
      } catch {
        /* 地址栏停在 /j/ 也能用，只是刷新会回到落地页。 */
      }
      onJoined();
    } catch (error) {
      setFailure(failureText(error, t("links.page.failed")));
      setBusy(false);
    }
  };

  const meta =
    info === null
      ? ""
      : [
          ROLES.has(info.role) ? t(`sharing.role.${info.role}`) : "",
          info.expiresAtMs > 0
            ? t("remote.invite.until", {
                time: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(info.expiresAtMs),
              })
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const name = info?.sourceName || info?.label || "";

  return (
    <main
      data-slot="join-page"
      className="flex min-h-[100dvh] w-full flex-col items-center overflow-y-auto bg-background px-6 pt-[max(env(safe-area-inset-top),15vh)] pb-[max(env(safe-area-inset-bottom),24px)]"
    >
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-12 rounded-[var(--r-panel)]" />
          <h1 className="text-[length:var(--text-display)] leading-tight font-semibold text-balance">
            {t("links.page.title")}
          </h1>
          {name && (
            <p className="text-[15px] font-medium break-words">{name}</p>
          )}
          {meta && (
            <p className="text-[13px] text-muted-foreground tabular-nums">
              {meta}
            </p>
          )}
        </div>
        {link === null ? (
          <Alert variant="destructive">
            <AlertTitle>{t("links.page.invalid")}</AlertTitle>
          </Alert>
        ) : (
          <div className="flex flex-col gap-2">
            {failure && (
              <Alert variant="destructive">
                <AlertTitle>{failure}</AlertTitle>
              </Alert>
            )}
            <Button
              type="button"
              size="lg"
              className="h-11 w-full"
              disabled={busy || info?.exhausted === true}
              onClick={() => void join()}
            >
              {busy && <Spinner data-icon="inline-start" aria-hidden />}
              {failure && !busy ? t("links.page.retry") : t("links.action")}
            </Button>
            <Button asChild size="lg" variant="ghost" className="h-11 w-full">
              <a href={joinDeepLink(link)}>{t("links.page.openApp")}</a>
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
