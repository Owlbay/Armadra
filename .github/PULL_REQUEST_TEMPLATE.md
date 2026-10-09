<!--
标题沿用提交信息格式：`类型(范围): 中文描述`，例如 `fix(terminal): 关停之后报来的退出不再落库`。
Title follows the commit format: `type(scope): description`, for example `fix(terminal): …`.
规范见 .github/CONTRIBUTING.md。不需要的小节写「无 / None」，不要删掉。
See .github/CONTRIBUTING.md. Write "无 / None" for sections that do not apply instead of deleting them.
-->

## 变更摘要 / Summary

<!-- 做了什么、为什么。 / What changed and why. -->

## 关联 issue / Related issues

<!-- Closes #123 / Refs #456 -->

## 改动范围 / Scope

- [ ] core（`apps/desktop/src/core/`）
- [ ] web（`apps/web`）
- [ ] 桌面壳 / desktop shell（`apps/desktop` 除 core / except core）
- [ ] 服务器壳 / server shell（`apps/server`）
- [ ] mobile（`apps/mobile`）
- [ ] docs
- [ ] tools / CI

## 契约变化 / Contract changes

<!--
`docs/contracts/core-json-api.md` 的哪几节（§N）；新增节往后加，不改已有节号。
协议 minor（`core/identity/protocol.ts` 的 `PROTOCOL_MINOR`）是否升了、升到多少。
Which sections (§N) of docs/contracts/core-json-api.md; new sections are appended, existing numbers are kept.
Whether the protocol minor (`PROTOCOL_MINOR`) was bumped, and to what.
-->

- 契约节号 / Sections:
- 协议 minor / Protocol minor:

## 数据库迁移 / Database migrations

<!--
新迁移的编号（main 上最大号 +1）与 `migrations.lock` 是否同步；已发布的迁移不得修改。
Number of the new migration (max on main + 1) and whether `migrations.lock` is updated; published migrations must not change.
-->

- 编号 / Number:
- `migrations.lock`:

## 界面文案 / UI copy

- [ ] 不涉及 / Not applicable
- [ ] 文案都在 `apps/web/src/i18n/`，中英同步 / All copy is in `apps/web/src/i18n/`, Chinese and English in sync
- [ ] 只用 `apps/web/src/ui/` 的现有 shadcn 组件 / Only existing shadcn components from `apps/web/src/ui/`

## 测试 / Testing

<!-- 跑了哪些命令、加了哪些用例；界面改动附截图或录屏。 / Commands run and tests added; attach screenshots for UI changes. -->

- [ ] 单元测试 / Unit tests:
- [ ] 探针 / Probes（`tools/probes/`、`tools/ci/e2e.d/`）:
- [ ] 截图或录屏 / Screenshots or recordings:
- [ ] `pnpm check`

## 检查清单 / Checklist

<!-- 见 AGENTS.md。 / See AGENTS.md. -->

- [ ] core 不 import `electron`、`../main/` 或 `../shell-core/` / core does not import `electron`, `../main/` or `../shell-core/`
- [ ] 迁移只新增，编号连续，`migrations.lock` 已同步；没有自动清库、重建或跳过损坏数据库的逻辑 / Migrations are append-only and contiguous, `migrations.lock` updated; no auto-wipe, rebuild or skipping of a corrupt database
- [ ] 凭据、终端原始输出与文件正文不进入画布持久化、日志或 API 响应 / Credentials, raw terminal output and file contents stay out of canvas persistence, logs and API responses
- [ ] 不写用户的 CLI 配置与系统配置 / Does not write the user's CLI or system configuration
- [ ] 注入给 CLI 的 Hook、Skill 等只用 `armadra` 开头的名称 / Hooks, skills and other injected items use `armadra`-prefixed names only
- [ ] 协作上下文只按连线读取，不跨工作空间；向 Agent 终端投递时不会替人回答权限提示 / Collaboration context is read along links only, never across workspaces; delivery never answers permission prompts on the user's behalf
- [ ] JSON 为 camelCase，错误为 `{ code, message }`；契约已同步 / JSON is camelCase, errors are `{ code, message }`; contract updated
- [ ] 新增的外呼已登记到 `core/net/outbound.ts` / New outbound calls are registered in `core/net/outbound.ts`
- [ ] 架构变化已同步 `docs/guides/architecture.md`，新文档已登记到 `docs/README.md` / Architecture changes reflected in docs; new docs registered in `docs/README.md`

## 需要用户提供的外部条件 / External prerequisites

<!-- 签名证书、账号、密钥、商店后台、真机等无法在 CI 里验证的部分，以及用 mock 验证到了哪一步。 / Signing certificates, accounts, keys, store consoles, physical devices, etc. that CI cannot verify, and how far mocks cover them. -->

## 已知限制 / Known limitations
