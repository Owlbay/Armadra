-- 推送（补全架构 §10、契约 §19）：设备登记与发送队列。
--
-- 一台身份设备（`identity_devices`）至多一条推送登记：同一个浏览器重新订阅、
-- 同一台手机换了令牌，都是覆盖这一行，而不是多出一行。撤销是打时间戳，不删
-- 行——发送队列里引用它的记录要能说清「这台设备什么时候不收了」。
--
-- transport：'webpush' 浏览器厂商端点（token 是订阅的 endpoint，public_key 是
-- p256dh，auth_secret 是订阅的 auth）| 'direct' APNs / FCM 平台令牌 | 'relay'
-- 中继令牌（平台令牌被中继封在里面，core 看不到）。public_key 对原生 App 是
-- 设备的 X25519 公钥，载荷端到端加密用；relay 必须有。
CREATE TABLE push_devices (
 device_id TEXT PRIMARY KEY REFERENCES identity_devices(device_id),
 platform TEXT NOT NULL CHECK(platform IN ('web', 'ios', 'android')),
 transport TEXT NOT NULL CHECK(transport IN ('webpush', 'direct', 'relay')),
 token TEXT NOT NULL CHECK(length(token) BETWEEN 1 AND 4096),
 public_key TEXT NOT NULL DEFAULT '' CHECK(length(public_key) <= 256),
 auth_secret TEXT NOT NULL DEFAULT '' CHECK(length(auth_secret) <= 256),
 app_version TEXT NOT NULL DEFAULT '' CHECK(length(app_version) <= 64),
 locale TEXT NOT NULL DEFAULT '' CHECK(length(locale) <= 16),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 revoked_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0),
 -- 撤销的原因：'user' 本人撤销 | 'gone' 平台说令牌已失效 | 'replaced' 等。
 revoked_reason TEXT NOT NULL DEFAULT '' CHECK(length(revoked_reason) <= 64)
);

-- 发送队列。payload_blob 是明文载荷（标题、短正文、深链，契约 §19），每次尝试
-- 按设备现加密；它不含终端原文与文件内容，所以落库与日志都不算泄露。
-- 一行的终态是 sent_at_ms 或 failed_at_ms 之一非零；两者都为零是还在等。
CREATE TABLE push_outbox (
 id TEXT PRIMARY KEY CHECK(length(id) = 32),
 device_id TEXT NOT NULL REFERENCES push_devices(device_id),
 payload_blob BLOB NOT NULL CHECK(length(payload_blob) <= 4096),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms > 0),
 sent_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(sent_at_ms >= 0),
 failed_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(failed_at_ms >= 0),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at_ms >= 0),
 reason TEXT NOT NULL DEFAULT '' CHECK(length(reason) <= 256)
);

CREATE INDEX push_outbox_pending
 ON push_outbox(next_attempt_at_ms) WHERE sent_at_ms = 0 AND failed_at_ms = 0;
