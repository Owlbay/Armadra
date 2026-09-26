# Web 前端

Armadra 唯一的页面。桌面壳、服务器壳与手机浏览器加载同一份产物。
React 19 / TypeScript / Vite；画布使用 React Flow 12（白板层自写），终端使用 xterm.js，
编辑器使用 CodeMirror 6，界面使用 shadcn/ui 与 Tailwind v4。

```sh
pnpm --filter @armadra/web dev        # http://127.0.0.1:1420
pnpm --filter @armadra/web build
pnpm --filter @armadra/web test
pnpm --filter @armadra/web typecheck
```

`dev` 需要一个正在运行的 core：Vite 代理从 `<数据目录>/endpoints.json` 读 core 地址，
设置 `VITE_RUNTIME_URL` 时改为直连、不装代理。`dev` / `build` 会先构建 `@armadra/shared`。
最省事的方式是在仓库根执行 `./armadra.sh run web`。

| 目录                                     | 职责                                   |
| ---------------------------------------- | -------------------------------------- |
| `src/canvas`、`src/nodes`                | 画布投影、节点 / 边、白板层与覆盖层    |
| `src/store`、`src/save`                  | 画布动作（`canvas-store`）与保存队列   |
| `src/terminal`、`src/agent`、`src/api`   | 终端、Agent 状态与 core 通信           |
| `src/editor`、`src/files`、`src/git`     | 编辑器、文件树、Git 工具窗口           |
| `src/shell`、`src/panels`、`src/sidebar` | 应用壳、设置与各类面板、工作空间与会话 |
| `src/keybindings`、`src/i18n`            | 快捷键与中英文案                       |
| `src/platform`、`src/host`               | 桌面壳 / 浏览器适配                    |

画布写入经 `canvas-store`；文案使用 `useT()`，组件复用现有 shadcn 实现。
完整边界见 [项目约定](../../AGENTS.md)。
