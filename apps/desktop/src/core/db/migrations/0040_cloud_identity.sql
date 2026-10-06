-- 云登录与登记（契约 §31）：这台 core 登记到的远程服务，以及邀请的多次使用（A4-1 用）。
-- 凭据不在这里：源私钥在 SecretStore `armadra-cloud-source-key`；断言原文不落盘。

-- 邀请多次使用：`max_uses` 为空 = 一次性（旧行为）；消费逻辑在 identity/accounts.ts（A4-1）。
ALTER TABLE identity_invitations ADD COLUMN max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0);
ALTER TABLE identity_invitations ADD COLUMN uses INTEGER NOT NULL DEFAULT 0 CHECK(uses >= 0);
CREATE TABLE identity_invitation_uses (
  invitation_id TEXT NOT NULL REFERENCES identity_invitations(invitation_id),
  principal_id  TEXT NOT NULL REFERENCES identity_principals(principal_id),
  used_at_ms    INTEGER NOT NULL CHECK(used_at_ms > 0),
  PRIMARY KEY (invitation_id, principal_id)
) WITHOUT ROWID;

-- 本 core 登记到的远程服务（issuer）；一行 = 信任它签的断言 + 向它开隧道。撤销只记 `revoked_at_ms`。
CREATE TABLE cloud_registrations (
  issuer               TEXT PRIMARY KEY CHECK(length(issuer) BETWEEN 1 AND 2048),
  source_key_ref       TEXT NOT NULL CHECK(length(source_key_ref) BETWEEN 1 AND 256),  -- SecretStore 名（armadra-cloud-source-key）
  jwks_json            TEXT NOT NULL CHECK(length(jwks_json) <= 65536),
  jwks_url             TEXT NOT NULL CHECK(length(jwks_url) <= 2048),
  jwks_fetched_at_ms   INTEGER NOT NULL CHECK(jwks_fetched_at_ms > 0),
  trusted_origins_json TEXT NOT NULL DEFAULT '[]' CHECK(length(trusted_origins_json) <= 65536),
  relay_origins_json   TEXT NOT NULL DEFAULT '[]' CHECK(length(relay_origins_json) <= 65536),
  owner_account_id     TEXT NOT NULL DEFAULT '' CHECK(length(owner_account_id) <= 256),
  label                TEXT NOT NULL DEFAULT '' CHECK(length(label) <= 128),
  mode                 TEXT NOT NULL CHECK(mode IN ('personal', 'saas')),
  registered_by        TEXT NOT NULL REFERENCES identity_principals(principal_id),
  registered_at_ms     INTEGER NOT NULL CHECK(registered_at_ms > 0),
  revoked_at_ms        INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
) WITHOUT ROWID;
