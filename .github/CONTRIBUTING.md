# 贡献指南 / Contributing

开发环境、目录约定与检查命令见 [AGENTS.md](../AGENTS.md) 与 [开发指南](../docs/guides/development.md)。

For the development setup, conventions and check commands, see [AGENTS.md](../AGENTS.md) and the [development guide](../docs/guides/development.md).

## 需求流程 / Workflow

每个需求都按同一条路径推进，结论留在 Issue 里，而不只在聊天或提交信息里。

Every requirement follows the same path, and its conclusions live in the Issue rather than only in chat or commit messages.

1. **建 Issue / Open an Issue**：简单梳理后用对应表单建 Issue，写清背景、目标与范围，标签 `needs-triage`。 / Sort the requirement out briefly and open an Issue with the matching form: background, goals and scope, labelled `needs-triage`.
2. **完善 Issue 与设计 / Refine the Issue and design**：调研结论与设计方案回填到同一个 Issue（方案、批次、验收标准）；方案较大时写成仓库里的设计文档，Issue 里放链接。方案未定时标 `needs-design`，定下后改为 `ready`。 / Put research findings and the design (approach, batches, acceptance criteria) back into the same Issue; larger designs become a design document in the repository, linked from the Issue. Label `needs-design` while the approach is open and `ready` once it is settled.
3. **开 PR 实现 / Implement in PRs**：按批次开 PR，正文按模板填写并关联 Issue——中间批次写 `Refs #N`，最后一个写 `Closes #N`；Issue 里的批次清单随 PR 勾选。 / Open one PR per batch, fill in the template and link the Issue — `Refs #N` for intermediate batches, `Closes #N` for the last one; tick the Issue's batch checklist as PRs land.
4. **合并与收尾 / Merge and close**：CI 全部通过后用 merge commit 合并；全部批次合入后关闭 Issue，并在 Issue 里写一段结果（做了什么、实测数据、遗留项，遗留项另开 Issue）。 / Merge with a merge commit once CI is green; when every batch has landed, close the Issue with a short result (what was done, measurements, leftovers — leftovers get their own Issues).

小修小补（拼写、单行修复）可以直接开 PR，但仍在 PR 里说明来源。 / Trivial fixes (typos, one-line fixes) may go straight to a PR, still stating where they came from.

## 提交 issue / Opening issues

- 先搜索已有 issue，一个 issue 只写一个问题。 / Search existing issues first; one problem per issue.
- 使用对应的表单：缺陷报告、功能建议、Agent CLI 兼容问题、文档问题。 / Use the matching form: bug report, feature request, Agent CLI compatibility, or documentation.
- 写清版本、平台与运行方式（桌面、网页、手机、经个人中转），以及涉及的 Agent CLI 与版本。 / Include the version, platform and how you run it (desktop, web, mobile, personal relay), plus the Agent CLI and its version.
- **不要贴凭据与终端原始输出**，日志只摘相关行并打码。 / **Never paste credentials or raw terminal output**; quote only relevant log lines, redacted.
- 安全问题按 [SECURITY.md](SECURITY.md) 私下报告。 / Report security problems privately as described in [SECURITY.md](SECURITY.md).

## 提交信息 / Commit messages

格式为 `类型(范围): 描述`，描述用中文，说清行为变化而不只是改了哪个文件：

The format is `type(scope): description`. Descriptions are written in Chinese and state the behavior change, not just which file was touched:

```text
fix(terminal): 关停之后后端报来的退出不再落库
feat(web): ACP 节点先显示、可先输入
docs(status): completion-progress 记包 D 的重跑结果
```

- 类型 / Types：`feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`chore`、`ci`、`release`、`revert`。
- 范围 / Scopes：模块或目录名，例如 `core`、`web`、`canvas`、`terminal`、`mobile`、`probes`、`status`；跨两处用逗号，例如 `test(web,probes)`。 / A module or directory name; join two with a comma.
- 一个模块连同它的测试一个提交；不要在提交信息里加生成说明或自动署名。 / One commit per module together with its tests; no generated notes or automatic trailers.

## 提交 PR / Opening pull requests

- 从 `main` 拉出按用途命名的分支，例如 `fix/terminal-exit`、`docs/github-templates`。 / Branch from `main` with a purpose-based name.
- PR 标题沿用提交信息格式；正文按模板填写，不适用的小节写「无 / None」。 / The PR title follows the commit format; fill in the template and write "无 / None" for sections that do not apply.
- 用 `Closes #N` 关联 issue。 / Link issues with `Closes #N`.
- 合并前 `pnpm check` 与 CI 全部通过；合并使用 merge commit，保留逐个提交。 / `pnpm check` and CI must pass before merging; merges use a merge commit and keep individual commits.
- 改了接口要同步 [core JSON 契约](../docs/contracts/core-json-api.md)：已有 §N 不改号，新增节往后加。 / Interface changes must update the [core JSON contract](../docs/contracts/core-json-api.md): keep existing §N numbers and append new sections.
- 数据库只新增编号迁移并同步 `migrations.lock`，已发布迁移不得修改。 / Only add numbered migrations and update `migrations.lock`; never modify published migrations.
- 界面文案放进 `apps/web/src/i18n/`，中英同步。 / UI copy goes into `apps/web/src/i18n/`, in both Chinese and English.
