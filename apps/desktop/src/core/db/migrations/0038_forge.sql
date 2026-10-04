-- 托管平台（forge，契约 §29）。
--
--   forge_config       仓库（或整台主机）用哪个托管平台、API 根在哪、令牌在哪。
--   github_references  多一列 `forge`：一条连接指向哪个平台上的 issue / PR。
--
-- `repo_key` 是远端地址里的主机名（小写、不含端口），可选再跟 `/<owner>/<name>`：
-- 只写主机的一行管这台主机上的全部仓库，写到仓库的一行优先。GitHub（github.com
-- 与 GitHub 凭据里配的企业版主机）按远端地址直接识别，不在这张表里。
--
-- **令牌不在这里**：`credential_ref` 是 SecretStore 里的条目名
-- （`armadra-forge-<id>`），读令牌永远回到密钥后端。`credential_ref` 为空表示
-- 只识别平台、还没有令牌。
--
-- `revision` 是显式 CAS：0 表示「还没有这一行」，其他值必须和调用方读到的相等。

CREATE TABLE forge_config (
  repo_key TEXT PRIMARY KEY CHECK(length(repo_key) BETWEEN 1 AND 512),
  forge TEXT NOT NULL CHECK(forge IN ('github', 'gitea', 'gitlab')),
  api_base TEXT NOT NULL CHECK(length(api_base) BETWEEN 1 AND 2048),
  credential_ref TEXT NOT NULL DEFAULT '' CHECK(length(credential_ref) <= 256),
  account_login TEXT NOT NULL DEFAULT '' CHECK(length(account_login) <= 256),
  revision INTEGER NOT NULL CHECK(revision > 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
) WITHOUT ROWID;

-- 已有的连接都是 GitHub 上的。
ALTER TABLE github_references
  ADD COLUMN forge TEXT NOT NULL DEFAULT 'github'
  CHECK(forge IN ('github', 'gitea', 'gitlab'));
