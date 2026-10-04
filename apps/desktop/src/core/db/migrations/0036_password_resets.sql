-- 口令重置链接（契约 §25）。
--
-- 邮箱是可选的，所以不做「输入邮箱自助重置」：owner（或组 admin 对本组成员）
-- 替某人签发一枚一次性、24 小时内有效的令牌，链接由签发人亲手交给对方。
--
--   * 令牌明文只在签发那一次返回；库里只有 `sha256("armadra/identity/v1/reset\0<令牌>")`，
--     按哈希找行，所以哈希就是主键。
--   * `used_at_ms` 非零即作废：用过一次、或同一个人又签了一枚新的（旧的随之作废）。
--     一次性靠 `UPDATE … WHERE used_at_ms = 0` 的条件，不靠清理。
--   * 按人找「还没用过的」要一个索引：签新令牌时把旧的作废。

CREATE TABLE identity_password_resets (
 token_hash BLOB PRIMARY KEY CHECK(length(token_hash) = 32),
 principal_id TEXT NOT NULL REFERENCES identity_principals(principal_id),
 issued_by TEXT NOT NULL CHECK(length(issued_by) <= 32),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
 used_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX identity_password_resets_by_principal
 ON identity_password_resets(principal_id, used_at_ms);
