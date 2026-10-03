-- 身份加固一：passkey、TOTP、恢复码、登录锁定、会话的来源信息。
--
-- 规格是 `docs/design/completion-architecture.md` §8.3 与契约 §18.1–§18.4。
-- 只增表与列，不改已有列。
--
--   * passkey 落在既有的 `identity_credentials(kind='passkey')` 上：凭据 ID
--     （base64url）放 `subject`，COSE 公钥放 `public_key`。新增的四列是
--     `@simplewebauthn/server` 判定要回读的计数器、认证器型号、传输方式，以及
--     用户自己起的名字。
--   * TOTP 的密钥**不在库里**：`identity_mfa.totp_secret_ref` 是 SecretStore 的
--     条目名。`last_time_step` 记最后一次用过的时间步，同一个码不能用两次。
--   * 恢复码只存 scrypt 哈希；同一批共用一份盐，一次校验只派生一次。
--   * 锁定按键记（`principal:<id>`），不看账号是否存在：不存在的账号也会被锁，
--     锁定因此不泄露存在性。
--   * 会话行加最近活动、来源 IP 与 UA，给「我的会话」列表用；旧行取缺省值。

ALTER TABLE identity_credentials ADD COLUMN sign_count INTEGER NOT NULL DEFAULT 0 CHECK(sign_count >= 0);
ALTER TABLE identity_credentials ADD COLUMN aaguid TEXT NOT NULL DEFAULT '' CHECK(length(aaguid) <= 64);
ALTER TABLE identity_credentials ADD COLUMN transports_json TEXT NOT NULL DEFAULT '[]' CHECK(length(transports_json) <= 512);
ALTER TABLE identity_credentials ADD COLUMN label TEXT NOT NULL DEFAULT '' CHECK(length(label) <= 128);

-- 一把 passkey 只属于一个 principal：登录时按凭据 ID 找人，不能有两个答案。
CREATE UNIQUE INDEX identity_credentials_one_passkey
 ON identity_credentials(subject)
 WHERE kind = 'passkey' AND revoked_at_ms = 0;

CREATE TABLE identity_mfa (
 principal_id TEXT PRIMARY KEY REFERENCES identity_principals(principal_id),
 totp_secret_ref TEXT NOT NULL CHECK(length(totp_secret_ref) BETWEEN 1 AND 128),
 enrolled_at_ms INTEGER NOT NULL CHECK(enrolled_at_ms > 0),
 verified_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(verified_at_ms >= 0),
 last_time_step INTEGER NOT NULL DEFAULT 0 CHECK(last_time_step >= 0)
);

CREATE TABLE identity_recovery_codes (
 principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
 code_hash BLOB NOT NULL CHECK(length(code_hash) = 32),
 salt BLOB NOT NULL CHECK(length(salt) BETWEEN 1 AND 64),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 used_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_at_ms >= 0),
 PRIMARY KEY (principal_id, code_hash)
);

CREATE TABLE identity_lockouts (
 key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 128),
 failures INTEGER NOT NULL CHECK(failures >= 0),
 locked_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(locked_until_ms >= 0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms > 0)
);

ALTER TABLE identity_sessions ADD COLUMN last_seen_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_seen_at_ms >= 0);
ALTER TABLE identity_sessions ADD COLUMN remote_ip TEXT NOT NULL DEFAULT '' CHECK(length(remote_ip) <= 64);
ALTER TABLE identity_sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '' CHECK(length(user_agent) <= 256);
