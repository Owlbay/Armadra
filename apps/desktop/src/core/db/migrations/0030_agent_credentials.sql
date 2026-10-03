-- 节点凭据（补全架构 §9.1，CLI 协作 §7.3）。
--
-- 一行是一个具名凭据：它属于哪家 CLI（`provider_id`）、是哪一种（`kind`，只能是
-- core 写死的映射表里的一项）、给人看的名字（`label`）。值**不在这里**：它在
-- SecretStore 的 `armadra-credential-<ref>` 条目里，这张表只记名字与种类，所以库
-- 文件、备份与导出里都没有密钥。
--
-- `last_used_at` 是最近一次被节点终端取用的时刻（毫秒），从没用过是 NULL。
CREATE TABLE agent_credentials (
  ref TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
