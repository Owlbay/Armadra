# 无窗口服务器壳

`@armadra/server` 在一个 Node 进程里装配与桌面相同的 core（`apps/desktop/src/core/`），
托管同一份 `apps/web` 产物，对外只有 HTTPS 一个面。用于多设备访问、手机访问与多人共享。

- **认证**：设备配对（启动时打印两分钟一次性配对链接）、`__Host-` 会话 Cookie、CSRF、可撤销设备。
- **账号与共享**：owner / member、组、邀请注册、按工作空间授权；收权即断事件流、即释放写租约。
- **浏览器节点**：headless Chromium 后端 + 画面流。
- **运维**：生成 launchd / systemd / sc.exe 服务定义（只写文件、不注册）、状态、日志与原地升级。

## 命令

```sh
pnpm --filter @armadra/web build        # 页面产物，serve 默认往上找 apps/web/dist
pnpm --filter @armadra/server build     # esbuild → out/main.js
pnpm --filter @armadra/server test
pnpm --filter @armadra/server typecheck
```

```sh
node apps/server/out/main.js serve --data-dir ~/.armadra-server
node apps/server/out/main.js --help
```

子命令：`serve`、`install`、`uninstall`、`status`、`logs`、`upgrade`。监听非回环地址必须同时给
`--public-origin`；不给证书时在 `<数据目录>/tls/` 生成自签名证书。完整参数与约束见
[开发指南 · 无窗口服务器壳](../../docs/guides/development.md#无窗口服务器壳)，账号模型见
[服务器账号、中转与共享](../../docs/design/server-accounts-and-sharing.md)。

| 文件           | 职责                         |
| -------------- | ---------------------------- |
| `src/cli.ts`   | 子命令与参数解析             |
| `src/serve.ts` | 装配 core、静态托管与路由    |
| `src/auth.ts`  | 配对、会话与 CSRF            |
| `src/tls.ts`   | 证书加载与自签名             |
| `src/service/` | 服务定义生成、日志读取与升级 |
