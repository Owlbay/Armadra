import type { ReactNode } from "react";

import { useT } from "@/app/preferences-store";
import { AuditLog } from "@/panels/settings/pages/security/AuditLog";
import { MfaSetup } from "@/panels/settings/pages/security/MfaSetup";
import {
  OAuthBindings,
  OAuthProviders,
} from "@/panels/settings/pages/security/OAuthBindings";
import { PasskeyList } from "@/panels/settings/pages/security/PasskeyList";
import {
  LockoutList,
  SessionList,
} from "@/panels/settings/pages/security/SessionList";
import { ResetPassword } from "@/session/ResetPassword";
import { SignIn } from "@/session/SignIn";
import {
  ALL_SESSIONS,
  AUDIT,
  BINDINGS,
  ENROLLMENT,
  LOCKOUTS,
  MANAGED_PROVIDERS,
  MEMBERS,
  MFA_ON,
  MFA_REQUIRED,
  NOW,
  PASSKEYS,
  PASSKEYS_ON_IP,
  PROVIDERS,
  RECOVERY_CODES,
  SESSIONS,
} from "../fixtures/auth";

const noop = () => undefined;
const names = new Map(
  MEMBERS.map((member) => [member.principalId, member.displayName]),
);

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

/** 登录样本坐在一张卡上，和设置对话框里的底色一样。 */
function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/70 bg-[var(--surface-card)] px-4">
      {children}
    </div>
  );
}

const mfa = {
  busy: false,
  error: "",
  onEnable: noop,
  onConfirm: noop,
  onVerify: noop,
  onRequest: noop,
  onCancel: noop,
};

/**
 * `auth` 分区（设计展示页 §2.1，设计系统 §5.9–§5.11）：真的登录组件与设置 →
 * 安全里的各块，喂假数据。
 *
 * 登录：整页（服务器壳没有会话时，无侧栏）· 账号（含通行密钥与第三方账号）·
 * 口令错误 · 忘记口令 · 两步验证 · 恢复码 · 锁定 · 离线。重置页：设新口令 ·
 * 链接失效 · 设好且泄露检查 `warn` 档命中。安全页：通行密钥（列表、IP 访问）· 两步验证（要求、登记、恢复码、
 * 已开启）· 第三方账号 · 会话与设备（所有成员）· 锁定的账号 · 审计（展开一行
 * 由交互决定，这里是收起的首屏）。时钟钉住，截图稳定。
 */
export default function AuthSection() {
  const t = useT();
  return (
    <div className="flex flex-col gap-8">
      <Sample caption={t("security.showcase.fullPage")}>
        {/* 整页登录（`app/IdentityGate`）：没有侧栏，一列在视口里居中。 */}
        <div className="flex h-[560px] overflow-hidden rounded-lg border border-border/70 bg-background px-6">
          <div className="m-auto w-full">
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={PROVIDERS}
              passkey
            />
          </div>
        </div>
      </Sample>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Sample caption={t("reset.title")}>
          <Card>
            <ResetPassword
              token="showcase"
              autoFocus={false}
              onSignIn={noop}
              initial={{
                kind: "ready",
                info: { displayName: "陈一", expiresAtMs: NOW + 86_400_000 },
              }}
            />
          </Card>
        </Sample>
        <Sample caption={t("reset.invalid")}>
          <Card>
            <ResetPassword
              token="showcase"
              autoFocus={false}
              onSignIn={noop}
              initial={{ kind: "invalid" }}
            />
          </Card>
        </Sample>
        <Sample caption={t("security.showcase.breached")}>
          <Card>
            <ResetPassword
              token="showcase"
              autoFocus={false}
              onSignIn={noop}
              initial={{ kind: "done", principalId: "", breached: true }}
            />
          </Card>
        </Sample>
      </div>
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <Sample caption={t("auth.title")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={PROVIDERS}
              passkey
            />
          </Card>
        </Sample>
        <Sample caption={t("security.showcase.passwordError")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={[]}
              passkey={false}
              initial={{
                step: "password",
                account: "chen.yi",
                error: t("auth.error.credentials"),
              }}
            />
          </Card>
        </Sample>
        <Sample caption={t("auth.forgot")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={[]}
              passkey={false}
              initial={{ step: "password", account: "chen.yi", forgot: true }}
            />
          </Card>
        </Sample>
        <Sample caption={t("auth.mfa.title")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={[]}
              passkey={false}
              initial={{ challengeId: "showcase" }}
            />
          </Card>
        </Sample>
        <Sample caption={t("auth.mfa.recovery")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={[]}
              passkey={false}
              initial={{
                step: "recovery",
                challengeId: "showcase",
                error: t("auth.error.code"),
              }}
            />
          </Card>
        </Sample>
        <Sample caption={t("security.showcase.locked")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={PROVIDERS}
              passkey
              now={NOW}
              initial={{
                step: "password",
                account: "zhao.san",
                lockedUntilMs: NOW + 4 * 60_000,
              }}
            />
          </Card>
        </Sample>
        <Sample caption={t("security.showcase.offline")}>
          <Card>
            <SignIn
              autoFocus={false}
              onSignedIn={noop}
              providers={PROVIDERS}
              passkey
              initial={{ offline: true }}
            />
          </Card>
        </Sample>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Sample caption={t("security.passkeys")}>
            <PasskeyList
              list={PASSKEYS}
              supported
              busy={PASSKEYS.passkeys[1]!.credentialId}
              onAdd={noop}
              onRemove={noop}
              onRename={async () => true}
            />
          </Sample>
          <Sample caption={t("security.showcase.ipHost")}>
            <PasskeyList
              list={PASSKEYS_ON_IP}
              supported
              busy={null}
              onAdd={noop}
              onRemove={noop}
            />
          </Sample>
          <Sample caption={t("security.mfa.required")}>
            <MfaSetup {...mfa} status={MFA_REQUIRED} stage={{ kind: "idle" }} />
          </Sample>
          <Sample caption={t("security.showcase.enrolling")}>
            <MfaSetup
              {...mfa}
              status={MFA_REQUIRED}
              stage={{ kind: "enrolling", enrollment: ENROLLMENT }}
            />
          </Sample>
          <Sample caption={t("security.mfa.codesTitle")}>
            <MfaSetup
              {...mfa}
              status={MFA_ON}
              stage={{ kind: "codes", codes: RECOVERY_CODES }}
            />
          </Sample>
          <Sample caption={t("security.mfa.on")}>
            <MfaSetup {...mfa} status={MFA_ON} stage={{ kind: "idle" }} />
          </Sample>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Sample caption={t("security.oauth")}>
            <OAuthBindings
              bindings={BINDINGS}
              providers={PROVIDERS}
              busy={null}
              onBind={noop}
              onUnbind={noop}
            />
          </Sample>
          <Sample caption={t("security.providers")}>
            <OAuthProviders
              providers={MANAGED_PROVIDERS}
              busy={null}
              onSetSecret={noop}
              onClearSecret={noop}
            />
          </Sample>
          <Sample caption={t("security.sessions")}>
            <SessionList
              sessions={SESSIONS}
              everyone={false}
              canSeeEveryone
              busy="s3"
              onEveryone={noop}
              onRevoke={noop}
              onRevokeOthers={noop}
            />
          </Sample>
          <Sample caption={t("security.sessions.everyone")}>
            <SessionList
              sessions={ALL_SESSIONS}
              everyone
              canSeeEveryone
              names={names}
              busy={null}
              onEveryone={noop}
              onRevoke={noop}
              onRevokeOthers={noop}
            />
          </Sample>
          <Sample caption={t("security.lockouts")}>
            <LockoutList
              lockouts={LOCKOUTS}
              names={names}
              busy={null}
              onUnlock={noop}
            />
          </Sample>
          <Sample caption={t("security.audit")}>
            <AuditLog
              members={MEMBERS}
              now={NOW}
              initial={AUDIT}
              load={async () => AUDIT}
              exportCsv={async () => ""}
            />
          </Sample>
        </div>
      </div>
    </div>
  );
}
