-- 客户端源表（契约 §33）：这台 core 作为「客户端宿主」记住的别的源，以及它登记过 / 能登录的远程服务。
-- 凭据不在这里：源会话的刷新令牌在 SecretStore `armadra-source-<source_id>`，远程服务的刷新令牌在 `armadra-remote-<service_id>`。
CREATE TABLE client_sources (
  source_id      TEXT PRIMARY KEY CHECK(length(source_id) = 32),
  kind           TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'relayed', 'hosted')),
  label          TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
  base_url       TEXT NOT NULL DEFAULT '' CHECK(length(base_url) <= 2048),      -- direct 的 Gateway 来源
  relay_origin   TEXT NOT NULL DEFAULT '' CHECK(length(relay_origin) <= 2048),  -- relayed：中继来源（relayBaseUrl 由断言响应给，不存）
  fingerprint    TEXT NOT NULL DEFAULT '' CHECK(length(fingerprint) IN (0, 64)), -- direct 的信任锚指纹
  cloud_issuer   TEXT NOT NULL DEFAULT '' CHECK(length(cloud_issuer) <= 2048),  -- relayed：经哪个远程服务
  principal_hint TEXT NOT NULL DEFAULT '' CHECK(length(principal_hint) <= 256),
  added_at_ms    INTEGER NOT NULL CHECK(added_at_ms > 0),
  last_ok_at_ms  INTEGER NOT NULL DEFAULT 0 CHECK(last_ok_at_ms >= 0),
  order_index    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE remote_services (
  service_id    TEXT PRIMARY KEY CHECK(length(service_id) = 32),
  kind          TEXT NOT NULL CHECK(kind IN ('personal', 'saas')),
  issuer        TEXT NOT NULL UNIQUE CHECK(length(issuer) BETWEEN 1 AND 2048),
  label         TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
  account_hint  TEXT NOT NULL DEFAULT '' CHECK(length(account_hint) <= 256),
  fingerprint   TEXT NOT NULL DEFAULT '' CHECK(length(fingerprint) IN (0, 64)), -- personal 自签 CA 的指纹
  added_at_ms   INTEGER NOT NULL CHECK(added_at_ms > 0),
  last_ok_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_ok_at_ms >= 0)
) WITHOUT ROWID;
