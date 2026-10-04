-- 推送补充（契约 §27）：每台设备收哪些种类，以及 UnifiedPush 端点。
--
-- kinds_json：这台设备**要收**的推送种类，JSON 字符串数组（`["approval",
-- "agentDone"]`）。空串 = 全部——没设过偏好的设备、以及以后新加的种类，缺省
-- 都收。`test` 不受它管：人点「发一条测试」就是要看到那一条。
--
-- unifiedpush_endpoint：Android App 从用户自己的 UnifiedPush 分发器（ntfy 等）
-- 拿到的端点 URL。非空时这台设备的通知改走它，不再走 `transport` 那条路；载荷
-- 一律是对设备公钥封好的信封，分发器只看得到密文。空串 = 没有。
ALTER TABLE push_devices
 ADD COLUMN kinds_json TEXT NOT NULL DEFAULT '' CHECK(length(kinds_json) <= 512);

ALTER TABLE push_devices
 ADD COLUMN unifiedpush_endpoint TEXT NOT NULL DEFAULT ''
 CHECK(length(unifiedpush_endpoint) <= 4096);
