-- 撤销登记时中继侧的源记录（契约 §31.4）：本机撤销总会完成；中继侧 `DELETE /v1/sources/{id}`
-- 要远程服务 owner 的会话，没有会话或调用失败时在这里记下当时的错误码，等重试。空串 = 不欠。
ALTER TABLE cloud_registrations ADD COLUMN relay_cleanup TEXT NOT NULL DEFAULT '' CHECK(length(relay_cleanup) <= 64);
