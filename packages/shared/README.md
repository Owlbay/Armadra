# 共享模型

`@armadra/shared` 保存纯数据与纯函数，不启动进程，不依赖具体画布引擎。
页面、core 与 `armadra-hook` 共用这里的类型与 zod schema。

| 模块                                 | 内容                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `domain/`                            | 节点、连线、工作空间、白板、Agent 状态的 zod schema        |
| `agents.ts`、`agent-capabilities.ts` | 六种内置 CLI 与自定义 CLI 的启动、resume、权限参数与能力位 |
| `api/`                               | core 的 HTTP / WebSocket schema（camelCase）               |
| `git-*.ts`、`handoff.ts`             | Git 仓库 / hunk / 提交信息与对话交接的模型                 |
| `hook-events.ts`                     | Hook 事件名与客户端修订号                                  |

`agents.ts` 与 core 的 `agent/registry.ts` 必须一致，由 core 的 `agent/launch.test.ts` 守着；
能力边界见 [Agent 协作](../../docs/guides/agent-collaboration.md)，线上形状以
[core 的 JSON 面](../../docs/contracts/core-json-api.md) 为准。

```sh
pnpm --filter @armadra/shared build
pnpm --filter @armadra/shared test
```

其余包的测试与 Web 的 `dev` / `build` 都依赖本包产物，仓库根的 `pnpm libs:build` 就是构建它。
