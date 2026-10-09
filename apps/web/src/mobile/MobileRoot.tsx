import * as React from "react";

import { App } from "../app/App";
import { syncDocumentPreferences } from "../app/preferences-store";
import { JoinPage } from "../shell/JoinPage";
import { PageCaGuide } from "../panels/settings/pages/gateway/CaInstallGuide";
import { ConnectScreen, type ConnectFailure } from "./ConnectScreen";
import {
  connectNative,
  connectWeb,
  connectWithCode,
  createRelayEnrollment,
  forgetConnection,
  openConnection,
} from "./connect";
import type { Entry } from "./entry";
import { nativeBridge } from "./native-bridge";
import { NativeMfa } from "./NativeMfa";
import { PushPermission } from "./PushPermission";
import { RelaySignIn } from "../shell/RelaySignIn";
import { hostedRelay } from "../sources/hosted";
import { usePushOpen } from "./push-open";
import { mobileCredentialProvider } from "./credentials";
import { createServiceProbe, useServiceProbe } from "../services/probe";
import { loadRecent } from "../services/recent";
import { serviceRowOf } from "../services/rows";
import { usePushRotation } from "./push-rotation";

/**
 * 入口分支（`main.tsx`）：连接页，或者画布本体加两样手机细节——推送权限提示
 * 、「点通知进焦点页」与推送令牌轮换后的重新登记。桌面窗口里 `entry` 恒为 `app`，这两样也不出现
 * （提示只在手机布局与原生 App 里问；深链只有通知会带来）。
 */
export function MobileRoot({ entry: initial }: { entry: Entry }) {
  const [entry, setEntry] = React.useState(initial);
  const relay = React.useMemo(() => createRelayEnrollment(), []);
  const [connected, setConnected] = React.useState(entry.kind === "app");
  // 主题与语言写到文档上原本只由画布（App）做：连接页与分享链接落地页在它之前，
  // 自己跟上偏好（明暗、语言），进画布后交还给 App。
  React.useEffect(
    () => (connected ? undefined : syncDocumentPreferences()),
    [connected],
  );
  if (connected) return <ConnectedApp />;
  if (entry.kind === "join")
    return <JoinPage onJoined={() => setConnected(true)} />;
  if (entry.kind === "mfa") {
    return (
      <NativeMfa
        challengeId={entry.challengeId}
        onSignedIn={() => setConnected(true)}
        onBack={() =>
          setEntry({ kind: "connect", mode: "native", origin: entry.origin })
        }
      />
    );
  }
  if (entry.kind === "relay") {
    const relay = hostedRelay();
    return relay === null ? null : (
      <RelaySignIn relay={relay} onEntered={() => setConnected(true)} />
    );
  }
  if (entry.kind !== "connect") return null;
  if (entry.mode === "web") {
    const done = (failure: ConnectFailure | null) => {
      if (failure === null) setConnected(true);
      return failure;
    };
    return (
      <ConnectScreen
        mode="web"
        origin={entry.origin}
        caGuide={<PageCaGuide />}
        onConnect={async () => done(await connectWeb())}
        {...(entry.via === "code"
          ? {
              codeFirst: true,
              onCode: async (code: string) =>
                done(await connectWithCode(code, { mode: "web" })),
              onSignIn: () => setConnected(true),
            }
          : {})}
      />
    );
  }
  return <NativeConnect entry={entry} relay={relay} />;
}

/** 原生 App 的连接页：表非空是「选择服务」（A7-1），带在线状态。 */
function NativeConnect({
  entry,
  relay,
}: {
  entry: Extract<Entry, { kind: "connect"; mode: "native" }>;
  relay: ReturnType<typeof createRelayEnrollment>;
}) {
  const bridge = nativeBridge();
  const origin = entry.origin;
  const connections = entry.connections;
  const rows = React.useMemo(() => {
    const recent = loadRecent();
    return (connections ?? []).map((row) => serviceRowOf(row, { recent }));
  }, [connections]);
  const probe = React.useMemo(() => {
    if (!connections || connections.length === 0) return null;
    const bases = new Map(
      connections.map((row) => [row.sourceId, row.baseUrl]),
    );
    return createServiceProbe((sourceId) => bases.get(sourceId) ?? "", {
      cloudAuth: mobileCredentialProvider().cloudAuth,
    });
  }, [connections]);
  const probed = useServiceProbe(rows, probe);
  return (
    <ConnectScreen
      mode="native"
      {...(origin ? { origin } : {})}
      {...(entry.link ? { initialLink: entry.link } : {})}
      {...(entry.join ? { autoJoin: true } : {})}
      {...(entry.failure ? { initialFailure: entry.failure } : {})}
      relay={relay}
      connections={rows}
      activeId={entry.activeId}
      recent={entry.recent ?? []}
      statuses={probed.statuses}
      signedOut={probed.signedOut}
      failedId={entry.failedId}
      manage={entry.manage === true}
      onOpen={(sourceId) => openConnection(sourceId)}
      onRemove={(sourceId) => {
        void forgetConnection(sourceId).then(() => {
          // 回到选择页（入口按这个片段进连接页）。
          history.replaceState(null, "", `${location.pathname}#connections`);
          location.reload();
        });
      }}
      canScan={bridge.canScan}
      onScan={() => bridge.scan()}
      onConnect={(link) => connectNative(link)}
      // 配对码只对已经钉过信任锚的 Gateway：App 不装 CA（契约 §24）。
      {...(origin
        ? {
            onCode: (code: string) =>
              connectWithCode(code, { mode: "native", origin }),
          }
        : {})}
    />
  );
}

function ConnectedApp() {
  usePushOpen();
  usePushRotation();
  // 画布里要管理连接（设置页的入口、通知）：把地址改成 `#connections` 即回连接页。
  React.useEffect(() => {
    const open = () => {
      if (location.hash === "#connections") location.reload();
    };
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return (
    <>
      <App />
      <PushPermission />
    </>
  );
}
