import { useEffect, useId, useRef, useState } from "react";

import {
  hasSessionCapability,
  IdentityRequestError,
  IdentityTransportError,
  logoutIdentity,
  pairIdentity,
  resumeIdentity,
  takePairingTicket,
  type IdentityHello,
  type IdentitySession,
} from "../../../api/identity";
import { usePreferencesStore, useT } from "../../../app/preferences-store";
import {
  isNativeShell,
  nativeSessionFailureKey,
} from "../../../host/native-session";
import { Alert, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Textarea } from "@/ui/textarea";
import { SettingsGroup } from "../SettingsGroup";

export interface HostIdentityPanelProps {
  hello?: IdentityHello;
  /**
   * 会话变了（取回、配对、登出）时报一次。已配对设备表只有一份，在对外服务
   * 那一块（`GatewayDevices`）；它靠这个知道哪一行是「当前」、能不能撤销。
   */
  onSession?(session: IdentitySession | null): void;
}

/** 身份面用不上的原因；`null` 表示可以用。 */
function availability(hello: IdentityHello | undefined): string | null {
  if (!hello?.hostId || !hello.hostInstanceId)
    return "hostIdentity.checkRequired";
  if (!hasSessionCapability(hello)) return "hostIdentity.unsupported";
  return null;
}

function failureKey(error: unknown): string {
  // 壳里票据由壳自己签；它的失败有自己那句话，好让人知道该看哪一边。
  const native = nativeSessionFailureKey(error);
  if (native) return native;
  if (error instanceof IdentityTransportError)
    return "hostIdentity.error.network";
  if (!(error instanceof IdentityRequestError))
    return "hostIdentity.error.response";
  if (error.status === 401) return "hostIdentity.error.auth";
  if (error.status === 403) return "hostIdentity.error.permission";
  if (error.status === 409) return "hostIdentity.error.conflict";
  if (error.status === 400) return "hostIdentity.error.invalid";
  return "hostIdentity.error.network";
}

export function HostIdentityPanel({
  hello,
  onSession,
}: HostIdentityPanelProps) {
  const t = useT();
  const locale = usePreferencesStore((state) => state.locale);
  const id = useId();
  const unavailable = availability(hello);
  const ready = unavailable === null;
  const working = useRef(false);
  const generation = useRef(0);
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const live = (mark: number) => generation.current === mark;

  // 报给父组件的回调不进 effect 依赖：它每次渲染都是新函数。
  const report = useRef(onSession);
  report.current = onSession;

  async function accept(mark: number, value: IdentitySession | null) {
    if (!live(mark)) return;
    setSession(value);
    report.current?.(value);
  }

  async function run(action: (mark: number) => Promise<void>) {
    const mark = generation.current;
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action(mark);
    } catch (failure) {
      if (live(mark)) setError(failureKey(failure));
    } finally {
      if (live(mark)) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    generation.current += 1;
    const mark = generation.current;
    working.current = false;
    setSession(null);
    report.current?.(null);
    setTicket("");
    setError(null);
    setNotice(null);
    setBusy(false);
    if (!ready) return;
    // 服务器壳把票放在地址栏的片段里（`…/#pair=<票>`）。读到就直接配对：
    // 让人把一串票自己复制一遍，只会多一次出错的机会。
    const pending = takePairingTicket();
    void run(async (current) =>
      accept(
        current,
        pending ? await pairIdentity(pending) : await resumeIdentity(),
      ),
    );
    return () => {
      generation.current += 1;
    };
    // 这条会话只跟着「身份面能不能用」走，不跟着语言或响应对象的身份走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const expiry =
    session && session.expiresAtUnixMs > 0
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(session.expiresAtUnixMs)
      : "—";

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
      <h3 id={`${id}-title`} className="text-[13px] font-medium">
        {t("hostIdentity.title")}
      </h3>
      {unavailable ? (
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(unavailable)}
        </p>
      ) : (
        <SettingsGroup>
          <div className="min-w-0 space-y-4 px-4 py-3" aria-busy={busy}>
            {error ? (
              <Alert variant="destructive" role="status" aria-live="polite">
                <AlertTitle className="text-[12px] leading-5 font-normal break-words">
                  {t(error)}
                </AlertTitle>
              </Alert>
            ) : (
              <p
                role="status"
                aria-live="polite"
                className="break-words text-[12px] leading-5 text-muted-foreground"
              >
                {t(
                  busy
                    ? session
                      ? "hostIdentity.busy"
                      : "hostIdentity.loading"
                    : (notice ??
                        (!session
                          ? "hostIdentity.signedOut"
                          : "hostIdentity.current")),
                )}
              </p>
            )}
            {!session ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || !ticket.trim()) return;
                  const material = ticket;
                  setTicket("");
                  void run(async (mark) =>
                    accept(mark, await pairIdentity(material)),
                  );
                }}
              >
                <label
                  htmlFor={`${id}-ticket`}
                  className="block text-[13px] font-medium"
                >
                  {t("hostIdentity.ticket")}
                </label>
                <Textarea
                  id={`${id}-ticket`}
                  rows={3}
                  maxLength={8192}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={ticket}
                  disabled={busy}
                  aria-describedby={`${id}-ticket-help`}
                  onChange={(event) => setTicket(event.target.value)}
                  className="min-w-0 resize-y text-[12px]"
                />
                <p
                  id={`${id}-ticket-help`}
                  className="text-[11px] leading-4 text-muted-foreground"
                >
                  {t(
                    isNativeShell()
                      ? "hostIdentity.ticketHelp"
                      : "hostIdentity.ticketHelp.server",
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    className="min-h-10"
                    disabled={busy || !ticket.trim()}
                  >
                    {t("hostIdentity.pair")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() =>
                      void run(async (mark) =>
                        accept(mark, await resumeIdentity()),
                      )
                    }
                  >
                    {t("hostIdentity.restore")}
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <dl className="grid min-w-0 gap-3 text-[12px]">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("hostIdentity.current")}
                    </dt>
                    <dd className="mt-1 break-words font-medium">
                      {session.device.displayName} · {t("hostIdentity.owner")}
                    </dd>
                    <dd className="mt-1 break-all text-muted-foreground select-text">
                      {session.device.deviceId}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("hostIdentity.expires")}
                    </dt>
                    <dd className="mt-1">{expiry}</dd>
                  </div>
                </dl>
                <details>
                  <summary className="cursor-pointer text-[12px] focus-visible:outline-2 focus-visible:outline-ring">
                    {t("hostIdentity.permissions")}
                  </summary>
                  <ul className="mt-2 space-y-2 text-[12px]">
                    {session.scopes.map((scope, index) => (
                      <li
                        key={`${scope.permission}-${index}`}
                        className="break-words"
                      >
                        {t(`hostIdentity.scope.${scope.permission}`)} ·{" "}
                        {scope.workspaceId
                          ? t("hostIdentity.workspace", {
                              id: scope.workspaceId,
                            })
                          : t("hostIdentity.allWorkspaces")}
                        {scope.executionHostId && (
                          <>
                            {" "}
                            ·{" "}
                            {t("hostIdentity.executionHost", {
                              id: scope.executionHostId,
                            })}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() =>
                      void run(async (mark) =>
                        accept(mark, await resumeIdentity()),
                      )
                    }
                  >
                    {t("hostIdentity.restore")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-10"
                    disabled={busy}
                    onClick={() =>
                      void run(async (mark) => {
                        await logoutIdentity();
                        await accept(mark, null);
                        if (live(mark)) setNotice("hostIdentity.loggedOut");
                      })
                    }
                  >
                    {t("hostIdentity.logout")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </SettingsGroup>
      )}
    </section>
  );
}
