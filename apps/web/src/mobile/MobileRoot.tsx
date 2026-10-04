import * as React from "react";

import { App } from "../app/App";
import { PageCaGuide } from "../panels/settings/pages/gateway/CaInstallGuide";
import { ConnectScreen, type ConnectFailure } from "./ConnectScreen";
import { connectNative, connectWeb, connectWithCode } from "./connect";
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
  return (
    <ConnectScreen
      mode="native"
      {...(origin ? { origin } : {})}
      {...(entry.link ? { initialLink: entry.link } : {})}
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
  return (
    <>
      <App />
      <PushPermission />
    </>
  );
}
