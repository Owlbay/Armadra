-- 投递终态回执（设计 `docs/design/cli-collaboration.md` §4、§9 R1）。
--
-- 一条排队项因为过期、目标侧拒收或出队时门链拒绝而结束，到 0028 为止发送方
-- 什么都不知道：行在表里躺五分钟后被清扫删掉，`agent_deliveries` 里也没有它
-- 的终态。这两列让清扫在删之前先往发送方的收件箱写一条回执，且只写一次。
--
-- 终态是谁定的：'' 旧行或投出去的 | 'source' 发送方已知（自己取消，或发送当下就拿到了拒绝）
-- | 'target' 目标侧拒收 | 'gate' 出队时门链拒绝 | 'sweep' 过期清扫
ALTER TABLE agent_send_queue ADD COLUMN settled_by TEXT NOT NULL DEFAULT '';
-- 回执写进发送方收件箱的时刻；NULL 表示还没写。只有 target / gate / sweep 会写。
ALTER TABLE agent_send_queue ADD COLUMN notified_at INTEGER;
