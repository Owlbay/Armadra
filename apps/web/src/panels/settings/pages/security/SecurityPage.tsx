import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IdentitySessionRow } from "@armadra/shared";
import { toast } from "sonner";

import {
  permits,
  renewCsrf,
  resumeIdentity,
  type IdentitySession,
} from "../../../../api/identity";
import {
  clearLockout,
  confirmTotp,
  disableMfa,
  enrollTotp,
  listLockouts,
  listMembers,
  listPasskeys,
  listSessions,
  mfaStatus,
  oauthBindings,
  oauthProviders,
  passkeyLabel,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  regenerateRecoveryCodes,
  clearOAuthSecret,
  removeOAuthBinding,
  setOAuthSecret,
  removePasskey,
  renamePasskey,
  revokeOtherSessions,
  revokeSession,
  startOAuth,
  takeOAuthFragment,
  type OAuthOutcome,
} from "../../../../api/security";
import { RUNTIME_VIA_SERVER_SHELL } from "../../../../api/request";
import { useT } from "../../../../app/preferences-store";
import { SignIn } from "../../../../session/SignIn";
import { securityFailure } from "../../../../session/sign-in-errors";
import {
  createCredential,
  webauthnAvailable,
  webauthnCancelled,
} from "../../../../session/webauthn";
import { AuditLog } from "./AuditLog";
import { MfaSetup, type MfaStage } from "./MfaSetup";
import { OAuthBindings, OAuthProviders } from "./OAuthBindings";
import { PasskeyList } from "./PasskeyList";
import { LockoutList, SessionList } from "./SessionList";
import { Skeleton } from "@/ui/skeleton";

const KEY = ["identity", "security"] as const;

/**
 * 设置 → 安全（补全架构 §8.3，设计系统 §5.9–§5.11）。
 *
 * 所有角色都进得来（`ownerOnly: false`）：每个人都管自己的登录方式与设备。
 * 顺序：两步验证（策略要求而没开时排第一）· 通行密钥 · 第三方账号 · 会话与
 * 设备；owner 另有锁定的账号与审计。服务器壳上还没登录时这一页就是登录。
 *
 * OAuth 回调（`#oauth=`，契约 §18.5）由 `use-link-fragments` 打开到这一页，
 * 这里取走片段：登录成功换会话，`mfa` 接第二步，`bound` 提示已绑定，`error`
 * 显示原因。
 */
export function SecurityPage() {
  const t = useT();
  const client = useQueryClient();
  const [session, setSession] = React.useState<
    IdentitySession | null | undefined
  >(undefined);
  const [outcome] = React.useState<OAuthOutcome | null>(() =>
    takeOAuthFragment(),
  );

  React.useEffect(() => {
    let live = true;
    const signedIn =
      outcome?.result === "signedIn" || outcome?.result === "signedUp";
    void (async () => {
      const resumed = await resumeIdentity();
      // 回调发的是 Cookie；CSRF 只在内存里，换一枚并让各处重取。
      if (resumed && signedIn && RUNTIME_VIA_SERVER_SHELL) {
        await renewCsrf().catch(() => "");
      }
      return resumed;
    })().then(
      (value) => {
        if (!live) return;
        setSession(value);
        if (value && outcome?.result === "bound") {
          toast.success(t("security.oauth.linked"));
        } else if (value && outcome?.result === "error") {
          toast.error(oauthError(outcome.code, t));
        }
      },
      () => {
        if (live) setSession(null);
      },
    );
    return () => {
      live = false;
    };
    // 片段只在挂载时读一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (session === undefined) {
    return (
      <div className="flex flex-col gap-3" data-slot="security-page">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (session === null) {
    return (
      <div data-slot="security-page">
        <SignIn
          initial={
            outcome?.result === "mfa" && outcome.challengeId
              ? { challengeId: outcome.challengeId }
              : outcome?.result === "error"
                ? { error: oauthError(outcome.code, t) }
                : undefined
          }
          onSignedIn={(next) => {
            setSession(next);
            void client.invalidateQueries();
          }}
        />
      </div>
    );
  }
  return <SecuritySettings session={session} />;
}

function oauthError(code: string, t: ReturnType<typeof useT>): string {
  const key = `auth.error.${code}`;
  const text = t(key);
  return text === key ? t("auth.error.failed") : text;
}

function SecuritySettings({ session }: { session: IdentitySession }) {
  const t = useT();
  const client = useQueryClient();
  const manage = permits(session, "identity:manage");
  const fail = React.useCallback(
    (error: unknown) => toast.error(securityFailure(error, t)),
    [t],
  );
  const refresh = React.useCallback(
    (part: string) => client.invalidateQueries({ queryKey: [...KEY, part] }),
    [client],
  );

  const mfa = useQuery({ queryKey: [...KEY, "mfa"], queryFn: mfaStatus });
  const passkeys = useQuery({
    queryKey: [...KEY, "passkeys"],
    queryFn: listPasskeys,
  });
  const providers = useQuery({
    queryKey: [...KEY, "providers"],
    queryFn: () => oauthProviders(false),
  });
  const bindings = useQuery({
    queryKey: [...KEY, "bindings"],
    queryFn: oauthBindings,
  });
  const [everyone, setEveryone] = React.useState(false);
  const sessions = useQuery({
    queryKey: [...KEY, "sessions", everyone],
    queryFn: () => listSessions(everyone),
  });
  const lockouts = useQuery({
    queryKey: [...KEY, "lockouts"],
    queryFn: listLockouts,
    enabled: manage,
  });
  const members = useQuery({
    queryKey: [...KEY, "members"],
    queryFn: listMembers,
    enabled: manage,
  });
  const names = React.useMemo(
    () =>
      new Map(
        (members.data ?? []).map((member) => [
          member.principalId,
          member.displayName,
        ]),
      ),
    [members.data],
  );

  /* ------------------------------ 两步验证 ------------------------------ */
  const [stage, setStage] = React.useState<MfaStage>({ kind: "idle" });
  const [mfaBusy, setMfaBusy] = React.useState(false);
  const [mfaError, setMfaError] = React.useState("");
  const mfaStep = (work: () => Promise<void>) => {
    setMfaBusy(true);
    setMfaError("");
    work()
      .catch((error: unknown) => setMfaError(securityFailure(error, t)))
      .finally(() => setMfaBusy(false));
  };

  /* ------------------------------ 通行密钥 ------------------------------ */
  const [passkeyBusy, setPasskeyBusy] = React.useState<string | null>(null);
  const addPasskey = () => {
    setPasskeyBusy("add");
    const label = passkeyLabel();
    void (async () => {
      const begun = await passkeyRegisterOptions(label);
      const response = await createCredential(begun.options);
      await passkeyRegisterVerify(begun.challengeId, response, label);
    })()
      .then(
        () => toast.success(t("security.passkeys.added")),
        (error: unknown) => {
          if (!webauthnCancelled(error)) fail(error);
        },
      )
      .finally(() => {
        setPasskeyBusy(null);
        void refresh("passkeys");
      });
  };

  /* -------------------------------- 会话 -------------------------------- */
  const [sessionBusy, setSessionBusy] = React.useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = React.useState<string | null>(null);
  const [lockBusy, setLockBusy] = React.useState<string | null>(null);
  const [providerBusy, setProviderBusy] = React.useState<string | null>(null);
  const act = (
    setBusy: (value: string | null) => void,
    id: string,
    work: () => Promise<unknown>,
    part: string,
  ) => {
    setBusy(id);
    work()
      .catch(fail)
      .finally(() => {
        setBusy(null);
        void refresh(part);
      });
  };

  const mfaFirst = mfa.data?.required && !mfa.data.enrolled;
  const mfaBlock = (
    <MfaSetup
      status={mfa.data}
      stage={stage}
      busy={mfaBusy}
      error={mfaError}
      onEnable={() =>
        mfaStep(async () => {
          setStage({ kind: "enrolling", enrollment: await enrollTotp() });
        })
      }
      onConfirm={(code) =>
        mfaStep(async () => {
          const codes = await confirmTotp(code);
          setStage({ kind: "codes", codes });
          await refresh("mfa");
        })
      }
      onRequest={(purpose) => {
        setMfaError("");
        setStage({ kind: "verify", purpose });
      }}
      onVerify={(purpose, code) =>
        mfaStep(async () => {
          if (purpose === "disable") {
            await disableMfa(code);
            setStage({ kind: "idle" });
          } else {
            setStage({
              kind: "codes",
              codes: await regenerateRecoveryCodes(code),
            });
          }
          await refresh("mfa");
        })
      }
      onCancel={() => {
        setMfaError("");
        setStage({ kind: "idle" });
      }}
    />
  );

  return (
    <div data-slot="security-page" className="flex flex-col gap-6">
      {mfaFirst && mfaBlock}
      <PasskeyList
        list={passkeys.data}
        loading={passkeys.isLoading}
        supported={webauthnAvailable()}
        busy={passkeyBusy}
        onAdd={addPasskey}
        onRemove={(passkey) =>
          act(
            setPasskeyBusy,
            passkey.credentialId,
            () => removePasskey(passkey.credentialId),
            "passkeys",
          )
        }
        onRename={(passkey, label) =>
          renamePasskey(passkey.credentialId, label).then(
            async () => {
              await refresh("passkeys");
              toast.success(t("security.passkeys.renamed"));
              return true;
            },
            (error: unknown) => {
              fail(error);
              return false;
            },
          )
        }
      />
      {!mfaFirst && mfaBlock}
      <OAuthBindings
        bindings={bindings.data}
        providers={
          providers.data?.configured
            ? providers.data.providers.filter(
                (provider) => provider.usable !== false,
              )
            : []
        }
        busy={oauthBusy}
        onBind={(provider) => {
          setOauthBusy(provider.id);
          startOAuth(provider.id, "bind").catch((error: unknown) => {
            setOauthBusy(null);
            fail(error);
          });
        }}
        onUnbind={(binding) =>
          act(
            setOauthBusy,
            binding.credentialId,
            () => removeOAuthBinding(binding.credentialId),
            "bindings",
          )
        }
      />
      <SessionList
        sessions={sessions.data}
        loading={sessions.isLoading}
        everyone={everyone}
        canSeeEveryone={manage}
        names={names}
        busy={sessionBusy}
        onEveryone={setEveryone}
        onRevoke={(row: IdentitySessionRow) =>
          act(
            setSessionBusy,
            row.sessionId,
            () => revokeSession(row.sessionId),
            "sessions",
          )
        }
        onRevokeOthers={() =>
          act(
            setSessionBusy,
            "others",
            async () => {
              const count = await revokeOtherSessions();
              toast.success(t("security.sessions.signedOut", { count }));
            },
            "sessions",
          )
        }
      />
      {manage && (
        <OAuthProviders
          providers={providers.data?.providers ?? []}
          busy={providerBusy}
          onSetSecret={(provider, secret) =>
            act(
              setProviderBusy,
              provider.id,
              () => setOAuthSecret(provider.id, secret),
              "providers",
            )
          }
          onClearSecret={(provider) =>
            act(
              setProviderBusy,
              provider.id,
              () => clearOAuthSecret(provider.id),
              "providers",
            )
          }
        />
      )}
      {manage && (
        <LockoutList
          lockouts={lockouts.data}
          names={names}
          busy={lockBusy}
          onUnlock={(lockout) =>
            act(
              setLockBusy,
              lockout.principalId,
              () => clearLockout(lockout.principalId),
              "lockouts",
            )
          }
        />
      )}
      {manage && (
        <AuditLog
          members={(members.data ?? []).map((member) => ({
            principalId: member.principalId,
            displayName: member.displayName,
          }))}
        />
      )}
    </div>
  );
}
