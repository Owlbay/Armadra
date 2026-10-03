-- 实时协同（补全架构 §6.2–§6.3，契约 §16）。
--
-- `boards.realtime = 1` 的板，真相是 `board_snapshots.state` 加其后的
-- `board_updates`（Yjs 二进制更新）；`nodes` / `edges` / `whiteboard_json`
-- 是物化出来的缓存，`materialized_seq` 记它追到了哪一条。`realtime = 0` 的板
-- 一切如旧（CAS + 租约）。
ALTER TABLE boards ADD COLUMN realtime INTEGER NOT NULL DEFAULT 0;
ALTER TABLE boards ADD COLUMN materialized_seq INTEGER NOT NULL DEFAULT 0;

-- 更新流：每条 Yjs 更新一行，`seq` 在一块板内递增。写快照时删掉
-- `seq <= 快照` 的行，所以表不会无限增长。`principal_id` 为 NULL 表示 core
-- 自己的写者（控制动词、调度、依赖编排）。
CREATE TABLE board_updates (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  "update" BLOB NOT NULL,
  principal_id TEXT,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (board_id, seq)
);

-- 每块板最多一份快照：`encodeStateAsUpdate` 的结果，覆盖到 `seq` 为止。
CREATE TABLE board_snapshots (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  state BLOB NOT NULL,
  at_ms INTEGER NOT NULL
);

-- 评论不进 `Y.Doc`：权限、审计与锚点都要 core 判。锚点三选一：
-- 'node'（anchor_id = 节点 id）| 'item'（白板 item id）| 'point'（x, y 画布坐标）。
CREATE TABLE board_comments (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  anchor_kind TEXT NOT NULL,
  anchor_id TEXT,
  x REAL,
  y REAL,
  body TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  parent_id TEXT REFERENCES board_comments(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
);

CREATE INDEX idx_board_comments_board ON board_comments(board_id, created_at_ms);
CREATE INDEX idx_board_comments_anchor ON board_comments(board_id, anchor_kind, anchor_id);
