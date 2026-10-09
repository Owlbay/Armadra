# 贡献指南 / Contributing

开发环境、目录约定与检查命令见 [AGENTS.md](../AGENTS.md) 与 [开发指南](../docs/guides/development.md)。

For the development setup, conventions and check commands, see [AGENTS.md](../AGENTS.md) and the [development guide](../docs/guides/development.md).

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

## 仓库自动化 / Repository automation

- **路径标签 / Path labels**：`labeler.yml` 按改动路径给 PR 打 `web`、`core`、`desktop`、`server`、`mobile`、`push-relay`、`shared`、`i18n`、`migrations`、`documentation`、`ci`、`dependencies`，映射在 [labeler.yml](labeler.yml)；新增目录时同步映射与标签。 / `labeler.yml` labels PRs by the paths they touch; the mapping lives in [labeler.yml](labeler.yml).
- **过期 issue / Stale issues**：`stale.yml` 每天把 60 天无活动的 issue 标 `stale`，再 14 天无活动关闭；带 `security`、`ready`、`needs-design` 的不处理，PR 不处理。回复即可重新计时。 / Issues idle for 60 days are marked `stale` and closed 14 days later; `security`, `ready` and `needs-design` issues and all PRs are exempt. Any reply resets the clock.
- **Codex 审查 / Codex review**：`codex-review.yml` 在非草稿 PR 打开、更新时只读审查，按 [AGENTS.md](../AGENTS.md)「Review guidelines」分级，结果更新在同一条 PR 评论里。它需要仓库 Actions secret `OPENAI_API_KEY`；未配置或来自 fork 的 PR 会跳过，不影响 CI。审查意见供参考，合并前仍需维护者判断。 / `codex-review.yml` reviews non-draft PRs read-only, graded by the AGENTS.md "Review guidelines", and keeps the result in one PR comment. It needs the `OPENAI_API_KEY` Actions secret and is skipped when the secret is missing or the PR comes from a fork.
- CodeRabbit 已在 [.coderabbit.yaml](../.coderabbit.yaml) 里关闭自动审查。 / CodeRabbit auto-review is turned off in [.coderabbit.yaml](../.coderabbit.yaml).
