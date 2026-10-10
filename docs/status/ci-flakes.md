# CI 偶发失败记录

> 状态：持续记录。与改动无关、重跑即过的失败；同一用例反复出现时开 issue 修根因（已修：设计展示页 reduced-motion #251、中继心跳 #243、Windows 产物读取 junction #270）。

- mailbox.test.ts beforeEach hook 10s 超时（Windows，#103 CI run 37197020176，2026-10-04）
- browser/headless/verbs.live.integration.test.ts Windows 两例超时（#109 run 37201663502；#101 也出现过 browser/headless/\*.live 超时）
- identity/passkey-cdp.live: Windows 上页面还在 about:blank 时就 fetch 相对 URL（Failed to parse URL from /api/identity/passkey/register/options），#115 run 37230679134
- 2026-10-07 e2e tier a: server-e2e 10 min 超时（#179）、ui-features 快捷键页载入超时（#178，两次），重跑通过
  - 快捷键页载入超时根因：设置对话框放大动画中按坐标点空；#182 改为等对话框停稳再点
- browser/headless/verbs.live.integration.test.ts macOS「drives the fixture end to end」DOM.getDocument 超时（#186 run 37533186694，重跑即过）
- 2026-10-08 macOS「Unix controller 故障探针」core_unavailable 偶发（#196、#194）；Linux web AccountsSharingPage.test 偶发（#194）
- 2026-10-09 Windows parity-acp.test.ts（ACP 回合时序）偶发一次（#201），重跑通过
- 2026-10-09 nightly windows-acceptance soak：powershell 30s 无回显（第二次出现，#190 时也见过）
- 2026-10-10 macOS relay/client.test.ts 心跳 GOAWAY 退避 'expected 1 >= 2'（#228）；macOS packaged-smoke 画布渲染超时、design-showcase 减少动效截图（#220 期间）
- 2026-10-10 macOS relay/client.test.ts 心跳计时（#235 首跑），第二次出现，需修
- 2026-10-10 e2e server-e2e「成员打开共享画布没有任何 403」403 /api/rpc/workspaces/list（#260；#237 也见过一次）；Windows parity-acp（#260）
- 2026-10-11 windows-x86_64 web AuditLog.test.tsx「缺省 7 天…」5s 超时（PR #272，与改动无关）
