import * as React from "react";

import { App } from "../app/App";
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
import type { ConnectionRow } from "./ConnectRelay";
import type { Entry } from "./entry";
import { nativeBridge } from "./native-bridge";
import { NativeMfa } from "./NativeMfa";
import { PushPermission } from "./PushPermission";
import { RelaySignIn } from "../shell/RelaySignIn";
import { hostedRelay } from "../sources/hosted";
import { usePushOpen } from "./push-open";
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
  if (connected) return <ConnectedApp />;
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
  const bridge = nativeBridge();
  const origin = entry.origin;
  const rows: ConnectionRow[] = (entry.connections ?? []).map((row) => ({
    sourceId: row.sourceId,
    label: row.label,
    host: hostOfBase(row.baseUrl || row.relayOrigin),
    direct: row.baseUrl !== "",
    relayed: row.relayOrigin !== "",
  }));
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
      onOpen={(sourceId) => openConnection(sourceId)}
      onRemove={(sourceId) => {
        void forgetConnection(sourceId).then(() => {
          // 回到管理页（入口按这个片段进连接页）。
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

function hostOfBase(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
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
