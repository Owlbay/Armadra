import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IdentitySessionRow } from "@armadra/shared";
import { toast } from "sonner";

import {
  onIdentitySessionChange,
  permits,
  resumeIdentity,
  type IdentitySession,
} from "../../../../api/identity";
import {
  listMembers,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from "../../../../api/security";
import { useT } from "../../../../app/preferences-store";
import { securityFailure } from "../../../../session/sign-in-errors";
import { SessionList } from "./SessionList";

const KEY = ["identity", "security"] as const;

/**
 * 设备与会话 → 登录会话（§2.1）。要一条身份会话；没有时（还没配对或登录）
 * 整块不出现，登录在「账号与安全」页。配对、登出之后跟着重新取一次。
 */
export function LoginSessions() {
  const [session, setSession] = React.useState<IdentitySession | null>(null);
  React.useEffect(() => {
    let live = true;
    const load = () =>
      void resumeIdentity().then(
        (value) => {
          if (live) setSession(value);
        },
        () => {
          if (live) setSession(null);
        },
      );
    load();
    // 续期（`rotated`）还是同一条会话，不必重取。
    const off = onIdentitySessionChange((change) => {
      if (change !== "rotated") load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return session ? <LoginSessionList session={session} /> : null;
}

function LoginSessionList({ session }: { session: IdentitySession }) {
  const t = useT();
  const client = useQueryClient();
  const manage = permits(session, "identity:manage");
  const [everyone, setEveryone] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const sessions = useQuery({
    queryKey: [...KEY, "sessions", everyone],
    queryFn: () => listSessions(everyone),
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
  const act = (id: string, work: () => Promise<unknown>) => {
    setBusy(id);
    work()
      .catch((error: unknown) => toast.error(securityFailure(error, t)))
      .finally(() => {
        setBusy(null);
        void client.invalidateQueries({ queryKey: [...KEY, "sessions"] });
      });
  };
  return (
    <SessionList
      sessions={sessions.data}
      loading={sessions.isLoading}
      everyone={everyone}
      canSeeEveryone={manage}
      names={names}
      busy={busy}
      onEveryone={setEveryone}
      onRevoke={(row: IdentitySessionRow) =>
        act(row.sessionId, () => revokeSession(row.sessionId))
      }
      onRevokeOthers={() =>
        act("others", async () => {
          const count = await revokeOtherSessions();
          toast.success(t("security.sessions.signedOut", { count }));
        })
      }
    />
  );
}
