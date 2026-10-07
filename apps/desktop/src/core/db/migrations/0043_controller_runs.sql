-- Durable controller runs and intent journal. Node IDs remain history after deletion.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  controller_id TEXT NOT NULL REFERENCES controller_profiles(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency BETWEEN 1 AND 4),
  deadline_at INTEGER NOT NULL,
  event_floor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE run_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  after_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  session_id TEXT,
  generation INTEGER,
  delivery_id TEXT NOT NULL UNIQUE,
  baseline_seq INTEGER NOT NULL DEFAULT 0,
  source_baseline INTEGER NOT NULL DEFAULT 0,
  report_cursor INTEGER NOT NULL DEFAULT 0,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  turn_started INTEGER NOT NULL DEFAULT 0,
  provider_session_id TEXT,
  prompt_hash TEXT,
  input_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, task_key)
);
CREATE TABLE run_node_occupancy (
  node_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES run_tasks(id) ON DELETE CASCADE
);
CREATE TABLE run_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES run_tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','executing','applied','uncertain')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, kind)
);
CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX run_events_page ON run_events(run_id, seq);
CREATE INDEX run_tasks_state ON run_tasks(run_id, state);
CREATE TABLE run_reports (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (node_id, session_id, generation, source_revision)
);
CREATE INDEX run_reports_binding ON run_reports(node_id, session_id, generation, seq);

-- Same queue and same delivery history; external actors have no source node.
DROP INDEX agent_send_queue_target;
DROP INDEX agent_send_queue_key;
ALTER TABLE agent_send_queue RENAME TO agent_send_queue_before_controller;
CREATE TABLE agent_send_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_node_id TEXT,
  target_node_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  message_key TEXT,
  body TEXT NOT NULL,
  hops INTEGER NOT NULL DEFAULT 0,
  trail TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  last_reason TEXT,
  settled_by TEXT NOT NULL DEFAULT '',
  notified_at INTEGER,
  source_kind TEXT NOT NULL DEFAULT 'node' CHECK (source_kind IN ('node','controller')),
  controller_id TEXT,
  run_id TEXT,
  task_id TEXT,
  CHECK ((source_kind = 'node' AND source_node_id IS NOT NULL) OR
    (source_kind = 'controller' AND source_node_id IS NULL AND controller_id IS NOT NULL AND run_id IS NOT NULL AND task_id IS NOT NULL))
);
INSERT INTO agent_send_queue (id, workspace_id, source_node_id, target_node_id, origin,
  message_key, body, hops, trail, created_at, expires_at, attempts, state, last_reason, settled_by, notified_at)
SELECT id, workspace_id, source_node_id, target_node_id, origin, message_key, body,
  hops, trail, created_at, expires_at, attempts, state, last_reason, settled_by, notified_at
FROM agent_send_queue_before_controller;
DROP TABLE agent_send_queue_before_controller;
CREATE INDEX agent_send_queue_target ON agent_send_queue(target_node_id, state, created_at);
CREATE UNIQUE INDEX agent_send_queue_key ON agent_send_queue(source_node_id, target_node_id, message_key)
  WHERE source_kind = 'node' AND message_key IS NOT NULL AND state IN ('queued','delivering');
CREATE UNIQUE INDEX agent_send_queue_controller_task ON agent_send_queue(controller_id, run_id, task_id)
  WHERE source_kind = 'controller';

DROP INDEX idx_agent_deliveries_workspace;
ALTER TABLE agent_deliveries RENAME TO agent_deliveries_before_controller;
CREATE TABLE agent_deliveries (
  trace_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_node_id TEXT,
  target_node_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  receipt TEXT,
  body_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  target_state TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'node',
  controller_id TEXT,
  run_id TEXT,
  task_id TEXT
);
INSERT INTO agent_deliveries (trace_id, workspace_id, source_node_id, target_node_id,
  outcome, receipt, body_chars, created_at, target_state)
SELECT trace_id, workspace_id, source_node_id, target_node_id, outcome, receipt,
  body_chars, created_at, target_state FROM agent_deliveries_before_controller;
DROP TABLE agent_deliveries_before_controller;
CREATE INDEX idx_agent_deliveries_workspace ON agent_deliveries(workspace_id, created_at);

-- Run-owned launch records never enter the legacy dependency service's retry path.
ALTER TABLE agent_dependency_launches ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'node';
ALTER TABLE agent_dependency_launches ADD COLUMN controller_id TEXT;
ALTER TABLE agent_dependency_launches ADD COLUMN run_id TEXT;
ALTER TABLE agent_dependency_launches ADD COLUMN task_id TEXT;
ALTER TABLE agent_dependencies ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'node';
ALTER TABLE agent_dependencies ADD COLUMN controller_id TEXT;
ALTER TABLE agent_dependencies ADD COLUMN run_id TEXT;
ALTER TABLE agent_dependencies ADD COLUMN task_id TEXT;
