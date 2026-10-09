# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue、讨论或 PR 里描述安全问题。请通过 GitHub Security Advisories 私下报告：

Please **do not** describe security problems in public issues, discussions or pull requests. Report them privately through GitHub Security Advisories:

**<https://github.com/Owlbay/Armadra/security/advisories/new>**

报告里请写明 / Please include:

- 受影响的版本与平台（桌面、服务器壳、手机、经个人中转等） / Affected version and platform (desktop, server shell, mobile, personal relay, etc.)
- 问题类型与影响，例如越权读取、凭据泄露、远程执行 / Type and impact, for example unauthorized reads, credential leaks, remote execution
- 复现步骤或概念验证 / Steps to reproduce or a proof of concept
- 你建议的修复（可选） / A suggested fix (optional)

报告里不要附真实凭据；需要演示时请使用测试账号与测试密钥。

Do not include real credentials; use test accounts and test keys when demonstrating.

## 处理流程 / Process

1. 我们会在 7 天内确认收到。 / We acknowledge the report within 7 days.
2. 确认问题后在私有 advisory 里协同修复，并告知预计的发布时间。 / Once confirmed, we work on a fix in the private advisory and share the expected release timeline.
3. 修复发布后公开 advisory；你愿意的话会在其中致谢。 / The advisory is published after the fix ships, crediting you if you wish.

## 支持的版本 / Supported versions

只有最新发布版会收到安全修复。 / Only the latest release receives security fixes.

## 范围 / Scope

范围内：本仓库的 core、桌面壳、服务器壳、网页与手机端，以及 Armadra 注入给 Agent CLI 的 Hook 与启动器。

In scope: the core, desktop shell, server shell, web and mobile clients in this repository, and the hooks and launchers Armadra injects into Agent CLIs.

范围外：各家 Agent CLI 与模型提供方自身的问题，请向对应项目报告。

Out of scope: problems in the Agent CLIs or model providers themselves; please report those to the respective projects.
