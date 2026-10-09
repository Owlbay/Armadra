# 手机 / 平板 App 更新记录

手机与 iPad（Android 手机与平板）是同一个 App，版本线独立于桌面 / 服务器套件（根目录的 `CHANGELOG.md`）。每个版本一节，按发布倒序；版本只用纯 `X.Y.Z`，标签是 `mobile-vX.Y.Z`，构建号单调递增、不写在这里（见 `docs/guides/ci-release.md`「移动端版本」）。App 与所连主机是否兼容只看协议：`tools/release/compatibility.json` 的 `mobile.minimumHostProtocol`。

## 1.1.0（2026-10-10）

### 改进与修复

- 启动先进入「选择服务」，设置里可切换服务（随桌面 0.2.6）。
- 同一主机经多个中转的到达方式分开保存，连接表升级 v2。
- ACP 会话可附图片与文件。

## 1.0.0（2026-10-10）

App 改用自己的版本线，与桌面 / 服务器的 0.2.x 分开。

### 改进与修复

- 版本号独立：iOS 的 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` 与 Android 的 `versionName` / `versionCode` 都从 App 自己的版本与构建号生成；修复 iPad 上一直显示 0.2.0（1）。
- 设置 → 关于：显示 App 版本与构建号、所连主机的版本与协议；主机协议低于 App 的要求（1.14）或主版本不同时提示更新哪一边。
