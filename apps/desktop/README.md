# 桌面壳与 core

`@armadra/desktop` 同时装着两样东西：

- **`src/core/`**：Electron-free 的 TypeScript core，Armadra 唯一的业务执行者。服务器壳
  （[apps/server](../server/README.md)）装配的也是它。不 import `electron`、`../main/` 或
  `../shell-core/`，由 `core/no-electron.test.ts` 的源码扫描守住。
- **Electron 薄壳**：窗口、托盘、通知、对话框、菜单、全局热键与浏览器节点的 `<webview>`；
  产品与主可执行文件统一为 **Armadra**（Windows 为 `Armadra.exe`）。

| 目录                | 职责                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `src/core/`         | 画布、终端、文件、Git、GitHub、调度、语言服务、浏览器、Hook、身份、远端     |
| `src/main/`         | 主进程：窗口、托盘、菜单、静态服务、拉起 core、浏览器 CDP、更新             |
| `src/preload/`      | 页面桥；能给页面的只有 `src/shared/ipc.ts` 那张表                           |
| `src/shell-core/`   | 主进程与测试共用的纯逻辑（CSP、快捷键、生命周期状态），不 import `electron` |
| `src/cli/`          | `armadra-hook`：各 CLI 的 Hook 回调与 `canvas` / `browser` 动词客户端       |
| `src/session-host/` | Windows 上持有 ConPTY 会话的独立进程，比壳活得久                            |
| `scripts/`          | 打包、签名计划、after-pack 与原生模块准备                                   |

## 命令

```sh
pnpm --filter @armadra/desktop dev         # electron-vite dev，默认连外部 core
pnpm --filter @armadra/desktop build       # 产出 out/（含 out/core/main.js）
pnpm --filter @armadra/desktop dist        # 签名计划 → build → electron-builder
pnpm --filter @armadra/desktop test        # vitest + live 用例 + scripts/*.test.mjs
pnpm --filter @armadra/desktop typecheck
```

跑测试前先 `pnpm libs:build`，否则依赖 `@armadra/shared` 产物的用例会整文件失败。
日常开发用仓库根的 `./armadra.sh run desktop`，它让壳持有自己的 core；直接 `dev` 需要先按
[开发指南](../../docs/guides/development.md#分步启动)起一个外部 core，或设 `ARMADRA_DESKTOP_OWNS_RUNTIME=1`。

## 生命周期与传输

- 壳以 `ELECTRON_RUN_AS_NODE` 子进程拉起 core，`--listen tcp:127.0.0.1:0` 由内核分配端口，
  core 在 stdout 公告实例与端口；健康检查只认自己拉起的那个 instanceId。
- 页面由主进程的回环静态服务提供，经 preload 的 `transport:endpoints` 取得
  `{ httpBase, wsBase, dataDir }` 后直连 core。没有自定义协议，也没有转发端口。
- Command W / 关闭窗口隐藏到托盘；Command Q /「退出并停止后台」结束 core 与受管会话，未确认完成的关停报告失败。

## 窗口与权限

- Overlay 标题栏、`vibrancy: "sidebar"`，最小 960×600；拖拽区由前端 `data-app-region` 绘制。
- `dialog:pick-directory` 返回绝对路径；`shell:open-external` 只允许 `http` / `https`。
- 拖入文件的绝对路径由 `webUtils.getPathForFile` 取得。
- CSP 只放行本机 core 的 http / ws；`<webview>` 与图片保留各自所需的来源。

## 打包与更新

`dist.mjs` 三步：先定签名计划（`signing-electron.mjs`：`sign` / `skip` / `refuse`），再
`electron-vite build`，最后调用 electron-builder；`after-pack.mjs` 把 `out/` 与迁移目录放进
`Resources/`，产物落在 `release/`。签名与公证由 `CSC_LINK` / `CSC_KEY_PASSWORD` /
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 驱动，`ARMADRA_REQUIRE_SIGNED_BUNDLE=1`
让「未签名」变成失败。

更新走 electron-updater；本机 `dist` 会写入 `armadraUpdates: "disabled"`，未签名构建里更新器关闭。
环境变量与签名细节见 [开发指南](../../docs/guides/development.md#环境变量与数据)，发布矩阵见
[CI 与发布](../../docs/guides/ci-release.md)。
