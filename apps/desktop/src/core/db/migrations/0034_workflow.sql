-- 工作流（设计 `docs/design/coordinator-agent.md` §5.3、补全架构 §5.3–§5.4）。
--
-- 草案：协调者经 `workflow-propose` 交上来、等人确认的一份草案 JSON。
-- 模板：确认后的草案（人可以改），`version` 只增。
-- 运行：一次按模板开节点、投提示词、等关卡的执行；`template_json` 是起跑那一刻
-- 的快照，之后改模板不影响已经在跑的运行，重启续跑读的也是它。
-- 步骤：运行里每一步的状态、节点、投递与完成判定的基准、产出。
-- runner 任务：协调者 `task(agent=…)` 经画布节点执行的记录（§5.3 的幂等键）。
-- 时刻一律是毫秒。

CREATE TABLE workflow_drafts (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  board_id          TEXT NOT NULL,
  proposer_node_id  TEXT,
  draft_json        TEXT NOT NULL,
  -- 'pending' | 'confirmed' | 'discarded'
  status            TEXT NOT NULL DEFAULT 'pending',
  template_id       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX workflow_drafts_board ON workflow_drafts(board_id, status, created_at);

CREATE TABLE workflow_templates (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1,
  template_json       TEXT NOT NULL,
  created_from_draft  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE workflow_runs (
  id                TEXT PRIMARY KEY,
  template_id       TEXT NOT NULL,
  template_version  INTEGER NOT NULL,
  template_json     TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  board_id          TEXT NOT NULL,
  -- 运行在画布上的 Frame 与它里面那张起点便签（投递的发起方）。
  frame_id          TEXT,
  anchor_node_id    TEXT,
  params_json       TEXT NOT NULL DEFAULT '{}',
  -- 角色 id → 节点 id。
  roles_json        TEXT NOT NULL DEFAULT '{}',
  -- 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  status            TEXT NOT NULL,
  reason            TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER
);

CREATE INDEX workflow_runs_template ON workflow_runs(template_id, started_at);
CREATE INDEX workflow_runs_status ON workflow_runs(status);

CREATE TABLE workflow_run_steps (
  run_id             TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id            TEXT NOT NULL,
  kind               TEXT NOT NULL,
  -- 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'cancelled'
  status             TEXT NOT NULL DEFAULT 'pending',
  node_id            TEXT,
  -- 这一步投出去的那条排队项，与投了几次。
  queue_id           TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  -- 完成判定的基准（与 `agent_dependencies` 同一套判定）：投递落地之后才记。
  delivered          INTEGER NOT NULL DEFAULT 0,
  baseline_state     TEXT,
  baseline_event_at  TEXT,
  observed_busy      INTEGER NOT NULL DEFAULT 0,
  reason             TEXT,
  started_at         INTEGER,
  ended_at           INTEGER,
  -- 产出（`post` 正文）与关卡答复。
  outcome_json       TEXT,
  PRIMARY KEY (run_id, step_id)
);

CREATE INDEX workflow_run_steps_node ON workflow_run_steps(node_id, status);

CREATE TABLE workflow_task_runs (
  task_id              TEXT PRIMARY KEY,
  coordinator_node_id  TEXT NOT NULL,
  runner_id            TEXT NOT NULL,
  node_id              TEXT NOT NULL,
  -- 'running' | 'done' | 'failed' | 'stopped'
  status               TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  result_json          TEXT
);

CREATE INDEX workflow_task_runs_coordinator ON workflow_task_runs(coordinator_node_id, started_at);
