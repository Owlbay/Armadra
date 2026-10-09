import * as React from "react";

import { syncDocumentPreferences, useT } from "../app/preferences-store";
import { RelayForm } from "../mobile/ConnectRelay";
import type { CloudSource } from "../sources/cloud-client";
import {
  type HostedFailure,
  type HostedRelay,
  hostedFailureOf,
} from "../sources/hosted";
import type { ServiceStatus } from "../services/probe";
import type { ServiceRow } from "../services/rows";
import { ServicePicker } from "../services/ServicePicker";
import { Alert, AlertTitle } from "@/ui/alert";
import { BrandMark } from "@/ui/brand-mark";
import { Spinner } from "@/ui/spinner";

export interface RelaySignInProps {
  readonly relay: Pick<HostedRelay, "issuer" | "signIn" | "enter"> &
    Partial<Pick<HostedRelay, "resume">>;
  /** 装好了本机源：进画布。 */
  readonly onEntered: () => void;
  /** 展示页用：钉住视图与内容。 */
  readonly initialHosts?: readonly CloudSource[];
  readonly initialFailure?: HostedFailure;
}

/**
 * 中继托管页面的入口（客户端包 §5）：中继账号口令登录 → 只有一台在线的主机就
 * 直接进，几台就挑一台。刷新页面时先用这个标签页记下的刷新令牌静默续上
 * （`HostedRelay.resume`），续不上才出登录。
 */
export function RelaySignIn({
  relay,
  onEntered,
  initialHosts,
  initialFailure,
}: RelaySignInProps) {
  const t = useT();
  const errorId = React.useId();
  // 画布（App）还没挂：主题、语言跟随系统与偏好由这一页先接上。
  React.useEffect(() => syncDocumentPreferences(), []);
  const [hosts, setHosts] = React.useState<readonly CloudSource[] | null>(
    initialHosts ?? null,
  );
  const [busy, setBusy] = React.useState(false);
  const [entering, setEntering] = React.useState<string | null>(null);
  // 进不去的那一台：失败挂在它那一行下面。
  const [failedId, setFailedId] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<HostedFailure | null>(
    initialFailure ?? null,
  );
  // 刷新之后先静默续上；续的时候不出表单，免得人刚开始填就被换走。
  const resume = relay.resume;
  const [resuming, setResuming] = React.useState(
    resume !== undefined && initialHosts === undefined,
  );
  const enteredRef = React.useRef(onEntered);
  enteredRef.current = onEntered;
  // 只续一次（严格模式下效果会跑两遍；刷新令牌每用一次就旋转）。
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!resuming || resume === undefined || started.current) return;
    started.current = true;
    void resume()
      .catch(() => null)
      .then((outcome) => {
        if (outcome?.kind === "entered") {
          enteredRef.current();
          return;
        }
        if (outcome?.kind === "signedIn") {
          setHosts(outcome.hosts);
          setFailure(outcome.failure);
        }
        setResuming(false);
      });
  }, [resuming, resume]);
  const message = failure === null ? null : t(`remote.error.${failure}`);
  const host = React.useMemo(() => {
    try {
      return new URL(relay.issuer).host;
    } catch {
      return relay.issuer;
    }
  }, [relay.issuer]);

  const rows = React.useMemo(
    (): ServiceRow[] =>
      (hosts ?? []).map((source) => ({
        sourceId: source.sourceId,
        name: source.name || source.sourceId.slice(0, 8),
        local: false,
        routes: [{ via: "relayed", issuer: relay.issuer, serviceName: host }],
        lastUsedAt: null,
      })),
    [hosts, relay.issuer, host],
  );
  const statuses = React.useMemo(
    () =>
      Object.fromEntries(
        (hosts ?? []).map((source): [string, ServiceStatus] => [
          source.sourceId,
          source.online ? "online" : "offline",
        ]),
      ),
    [hosts],
  );

  const enter = async (source: CloudSource) => {
    setBusy(true);
    setEntering(source.sourceId);
    setFailure(null);
    setFailedId(null);
    try {
      await relay.enter(source);
      onEntered();
    } catch (error) {
      setFailure(hostedFailureOf(error));
      setFailedId(source.sourceId);
      setBusy(false);
      setEntering(null);
    }
  };

  const signIn = async (account: string, password: string) => {
    setBusy(true);
    setFailure(null);
    setFailedId(null);
    let listed: CloudSource[];
    try {
      listed = await relay.signIn(account, password);
    } catch (error) {
      setFailure(hostedFailureOf(error));
      setBusy(false);
      return;
    }
    setHosts(listed);
    // 只有一台而且在线：不必挑，直接进（失败留在列表上，可以再点）。
    if (listed.length === 1 && listed[0]!.online) {
      await enter(listed[0]!);
      return;
    }
    if (listed.length === 0) setFailure("noSources");
    setBusy(false);
  };

  return (
    <main
      data-slot="relay-sign-in"
      className="flex min-h-[100dvh] w-full flex-col items-center overflow-y-auto bg-background pt-[max(var(--safe-top),15vh)] pr-[calc(1.5rem+var(--safe-right))] pb-[max(var(--safe-bottom),24px)] pl-[calc(1.5rem+var(--safe-left))]"
    >
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark className="size-12 rounded-[var(--r-panel)]" />
          <h1 className="text-[length:var(--text-display)] leading-tight font-semibold text-balance">
            {t(
              hosts === null
                ? "remote.hosted.title"
                : "remote.hosted.chooseHost",
            )}
          </h1>
          <p className="font-mono text-[13px] text-muted-foreground tabular-nums">
            {host}
          </p>
        </div>
        {resuming ? (
          <div className="flex justify-center py-6">
            <Spinner aria-label={t("remote.status.connecting")} />
          </div>
        ) : hosts === null ? (
          <RelayForm
            issuer={relay.issuer}
            busy={busy}
            message={message}
            errorId={errorId}
            onEdit={() => setFailure(null)}
            onSubmit={({ account, password }) => void signIn(account, password)}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {message && failedId === null && (
              <Alert variant="destructive" id={errorId}>
                <AlertTitle>{message}</AlertTitle>
              </Alert>
            )}
            <ServicePicker
              variant="page"
              rows={rows}
              statuses={statuses}
              failure={
                failedId !== null && message !== null
                  ? { sourceId: failedId, message }
                  : null
              }
              busyId={entering}
              disabled={busy}
              disableOffline
              onEnter={(sourceId) => {
                const source = hosts.find((one) => one.sourceId === sourceId);
                if (source) void enter(source);
              }}
            />
          </div>
        )}
      </div>
    </main>
  );
}
