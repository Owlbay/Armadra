# 设计展示页

> 状态：目标设计（2026-10-03）。[设计系统](design-system.md)的可见验收面：一个只在开发构建里存在的页面，把每个 token、每个组件的变体与状态、每种界面模式用假数据渲染出来，深浅主题 × 三种宽度各截一张图。

## §1 结论

| #   | 决定                                                                                                                                              | 理由                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | 独立 HTML 入口 `apps/web/showcase.html` + `src/showcase/main.tsx`，不进 `App`、不加路由                                                           | Vite 只构建 `index.html`，多出来的入口天然不进产物；桌面壳与服务器壳加载的是 `dist/index.html`，碰不到它 |
| 2   | 双保险：`src/showcase/main.tsx` 第一行 `if (!import.meta.env.DEV) throw`；`vite.config.ts` 的 `build.rolldownOptions.input` 显式只列 `index.html` | 以后有人加第二个入口时不会把展示页带进去                                                                 |
| 3   | 不连 core：全部数据来自 `src/showcase/fixtures/`                                                                                                  | 截图可重复、可离线；探针不用起 core 与 tmux                                                              |
| 4   | 渲染的是真组件：`src/ui/*`、功能组件（`NodeShell`、`StatusPill`、会话视图、权限卡…）                                                              | 展示页是验收面不是样板间；需要 store 的组件用 `app/test-harness.tsx` 的 provider 包起来并喂假 store      |
| 5   | 截图探针 `tools/probes/design-showcase.mjs` 只起 Vite 与无头 Chrome，经 CDP 对每个分区 × 主题 × 视口截 PNG，并把对比度核算结果写进 `result.json`  | 与 `git-tool-window.mjs`、`ui-features/harness.mjs` 同一套写法                                           |

## §2 页面

地址：`http://127.0.0.1:1420/showcase.html?theme=dark&locale=zh-CN&width=1440#tokens`

- `theme`：`dark | light`，写进 `<html data-theme>`；缺省跟系统。
- `locale`：`zh-CN | en`，经 `preferences-store` 的 `setLocale`。
- `width`：只给探针用，页面不读；探针用 CDP 的 `Emulation.setDeviceMetricsOverride`。
- `#<section>`：滚到分区并把它设成唯一渲染的分区（`?only=1` 时），截图不受其他分区影响。
- 页内左侧 200px 导航（复用设置页的导航样式与 `settings-navigation` 类），右侧 `ScrollArea`；手机宽度下导航收进顶部 `Select`。页本身也遵守设计系统，没有额外的说明文字——每个分区只有标题与样本。

### §2.1 分区

| id            | 内容                                                                                                                                                                                                                                       | fixtures          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `tokens`      | 色板：表面五档、文字三档、品牌、状态（图形 / 文字 / 衬底三件套）、Agent 七色（标识 + 文字 + 实底头像）、成员八色；每个色块下方印 token 名与算出的对比度（`lib/contrast.ts`）；字号阶梯；圆角四档；阴影四档；动效三档（点一下播放）；z 轴表 | —                 |
| `components`  | §3.1 + §3.2 全部组件，每个组件一行变体 × 一列状态（默认 / hover（`data-hover` 强制）/ focus-visible（强制）/ disabled / invalid / loading）                                                                                                | `components.ts`   |
| `canvas`      | 一个 600×400 的假画布：三个节点（终端 working、便签、编辑器 unread）、三种边（对等 / 主从 / 引用）、一个分组、两个他人光标与选区、两枚评论钉、一条投递流光                                                                                 | `canvas.ts`       |
| `acp`         | 会话视图：用户 / 助手 / 思考 / 工具调用（三种状态）/ 差异 / 权限卡 / 流式尾部 / 错误行；PromptBox 三态；输出到画板菜单展开                                                                                                                 | `acp.ts`          |
| `wizard`      | 新建向导三步各一张；空态                                                                                                                                                                                                                   | `wizard.ts`       |
| `coordinator` | 分派树（三成员：done / working / failed）、草案卡                                                                                                                                                                                          | `coordinator.ts`  |
| `workflow`    | 模板库（3 张卡 + 空态）、编辑器（步骤 2 选中）、运行历史（5 行 + 展开 1 行）                                                                                                                                                               | `workflow.ts`     |
| `collab`      | 头像堆叠（1 / 3 / 6 人）、只读、断开；评论抽屉（未解决 2 + 已解决 1 + 空态）；成员表与角色                                                                                                                                                 | `collab.ts`       |
| `auth`        | 登录第一步、口令、通行密钥、MFA、锁定、离线；会话与设备表；通行密钥列表；审计日志（5 行 + 空 + 加载）                                                                                                                                      | `auth.ts`         |
| `gateway`     | 对外服务开 / 关、QR 卡、配对码倒计时、设备列表、手机配对页                                                                                                                                                                                 | `gateway.ts`      |
| `mobile`      | 只在 ≤767 有意义：底部导航五态、焦点页（终端 + 按键条）、底部 Sheet、列表页；桌面宽度下用 390 宽的 iframe 嵌同一页的 `#mobile&only=1`                                                                                                      | 复用其余 fixtures |
| `updates`     | 更新页十一种状态（[更新设计](updates-and-service-install.md) §4.1）                                                                                                                                                                        | `updates.ts`      |
| `integration` | 一张正常的 CLI 分组、一张版本过旧、一张启动器异常、一张 ACP 未装；执行主机 worker 过期                                                                                                                                                     | `integration.ts`  |
| `states`      | 通用五态并排：Empty / Skeleton / Alert / 权限 Badge / 离线 Alert                                                                                                                                                                           | —                 |

### §2.2 文件

```text
apps/web/
  showcase.html                      入口（与 index.html 同构，lang=zh-CN，data-theme 由脚本写）
  src/showcase/
    main.tsx                         DEV 守卫、读 query、挂 ShowcaseApp
    ShowcaseApp.tsx                  导航 + 分区路由（hash）+ only 模式
    sections/<id>.tsx                每个分区一个文件，只组合真组件
    harness.tsx                      假 store / query client / i18n provider（基于 app/test-harness.tsx）
    fixtures/<id>.ts                 §2.1 的假数据，纯对象，无副作用
    force-state.css                  `[data-hover]` / `[data-focus]` 强制态（只在展示页加载）
  src/lib/contrast.ts                相对亮度与对比度（展示页与 tokens-contrast.test.ts 共用）
  src/styles/tokens-contrast.test.ts 对设计系统 §2 的每一对断言阈值
tools/probes/design-showcase.mjs     截图探针
tools/probes/README.md               新增一节
```

展示页文案：分区标题与样本里的假文案也走 i18n（`i18n/showcase.ts`），否则 `i18n.test.ts` 的「功能代码不写死中文」守卫会拦；fixtures 里的用户内容（消息正文、文件名、设备名）是数据不是界面文案，允许中文字面量，但集中在 `fixtures/` 目录并在 `i18n.test.ts` 的扫描里排除该目录。

## §3 截图探针

```sh
pnpm libs:build
node tools/probes/design-showcase.mjs [输出目录] [--only=tokens,acp] [--theme=dark] [--width=390]
```

- 起一个随机端口的 Vite（`vite --port 0 --strictPort false`，读 `apps/web`），新 profile 无头 Chrome；不起 core，不读写操作员数据目录，跑完删除临时目录。
- 矩阵：13 个分区 × 2 主题 × 3 视口（1440×900 / 1024×768 / 390×844）= 78 张；`--only / --theme / --width` 收窄。
- 每张图：导航到 `showcase.html?theme=…&only=1#<id>`，等 `document.fonts.ready` 与 `[data-showcase-ready="true"]`，整页截图（`captureBeyondViewport`），文件名 `<id>-<theme>-<width>.png`。
- 控制台：`console.error` 与未捕获异常算失败（与 `ui-features-e2e.mjs` 同规）。
- 对比度：探针在页面里执行 `window.__showcaseContrast()`（展示页暴露，读真实计算样式而不是源文件），把每对的实测值写进 `result.json`，低于阈值即失败。
- 产物：`target/design-showcase/*.png` + `result.json`（分区、主题、视口、耗时、对比度表、控制台）。
- `--diff=<上一次目录>`：逐像素比较同名 PNG，差异超过 0.5% 的列进 `result.json` 的 `changed`，用于审阅改动前后。

## §4 验收

1. `pnpm --filter @armadra/web build` 的 `dist/` 里没有 `showcase.html` 与 `src/showcase` 的任何 chunk。
2. `tokens-contrast.test.ts` 通过：设计系统 §2.1–§2.5 列出的每一对都 ≥ 阈值（文字 4.5、图形 3.0）。
3. 探针 78 张图全部生成，`result.json.status === "ok"`，控制台无错误。
4. 展示页里每个按钮、输入、开关都可 Tab 到达，焦点环可见（探针对 `components` 分区按 Tab 走一遍并数 `:focus-visible` 命中数 = 可聚焦元素数）。
5. `prefers-reduced-motion: reduce` 下（探针用 `Emulation.setEmulatedMedia`）`canvas` 分区的光晕与流光静止，截图与上一张不同之处只有动画帧。
6. `forced-colors: active` 下 `components` 分区焦点环仍可见（一张额外截图）。
7. `pnpm --filter @armadra/web test` 与 `typecheck` 通过；`pnpm repo:check` 通过（本页与设计系统已登记）。

## §5 工作包与文件归属

| 包    | 内容                                                            | 文件（独占）                                                                                                                                                                                                                                                                                                                                                                                                                 | 验证                                           |
| ----- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| WP-D1 | token 与基础件：设计系统 §7 第 1–7 步                           | `apps/web/src/styles/{tokens,app}.css`、`styles/tokens.test.ts`、`styles/tokens-contrast.test.ts`、`src/lib/contrast.ts`、`src/ui/{avatar,card,alert,empty,skeleton,spinner,checkbox,radio-group,label,field,input-otp,table,item,collapsible,accordion,button-group}.tsx`（CLI 生成）、`src/ui/{agent-avatar,member-dot}.tsx`、`src/ui/ui.test.tsx`、`src/agent/launch.ts`、`src/shell/MobileFocusPage.tsx`、`src/main.tsx` | `pnpm --filter @armadra/web test`、`typecheck` |
| WP-D2 | 展示页与探针：本文 §2–§3                                        | `apps/web/showcase.html`、`apps/web/src/showcase/**`、`apps/web/src/i18n/showcase.ts`、`apps/web/vite.config.ts`（只加 `input`）、`tools/probes/design-showcase.mjs`、`tools/probes/README.md`                                                                                                                                                                                                                               | 探针跑通 78 张；`build` 产物无展示页           |
| WP-D3 | 存量界面套用：设计系统 §7 第 8–11 步（可拆成按目录的多个小 PR） | `src/panels/settings/SettingsRow.tsx`、`src/panels/ResponsiveDialog.tsx`、`grep "<button"` 列出的 20 个文件、`src/panels/*` 的空态                                                                                                                                                                                                                                                                                           | 各文件既有测试；探针 `--diff` 对照             |

依赖：D1 → D2（展示页要渲染新 token 与新组件）；D3 独立于 D2，依赖 D1。各新界面（ACP、协调者、工作流、协同、登录、Gateway）的实现包各自引用设计系统 §5 对应小节，并把自己的样本加进展示页对应分区——分区文件归实现包所有，`ShowcaseApp.tsx` 只登记。
