import * as React from "react";

import { App } from "../app/App";
import { PageCaGuide } from "../panels/settings/pages/gateway/CaInstallGuide";
import { ConnectScreen } from "./ConnectScreen";
import { connectNative, connectWeb } from "./connect";
import type { Entry } from "./entry";
import { nativeBridge } from "./native-bridge";
import { PushPermission } from "./PushPermission";
import { usePushOpen } from "./push-open";

/**
 * 入口分支（`main.tsx`）：连接页，或者画布本体加两样手机细节——推送权限提示
 * 与「点通知进焦点页」。桌面窗口里 `entry` 恒为 `app`，这两样也不出现
 * （提示只在手机布局与原生 App 里问；深链只有通知会带来）。
 */
export function MobileRoot({ entry }: { entry: Entry }) {
  const [connected, setConnected] = React.useState(entry.kind === "app");
  if (connected) return <ConnectedApp />;
  if (entry.kind !== "connect") return null;
  if (entry.mode === "web")
    return (
      <ConnectScreen
        mode="web"
        origin={entry.origin}
        caGuide={<PageCaGuide />}
        onConnect={async () => {
          const failure = await connectWeb();
          if (failure === null) setConnected(true);
          return failure;
        }}
      />
    );
  const bridge = nativeBridge();
  return (
    <ConnectScreen
      mode="native"
      {...(entry.origin ? { origin: entry.origin } : {})}
      canScan={bridge.canScan}
      onScan={() => bridge.scan()}
      onConnect={(link) => connectNative(link)}
    />
  );
}

function ConnectedApp() {
  usePushOpen();
  return (
    <>
      <App />
      <PushPermission />
    </>
  );
}
