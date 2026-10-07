-- External controllers are scoped actors, never synthetic canvas nodes.
CREATE TABLE controller_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE controller_objects (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  controller_id TEXT NOT NULL REFERENCES controller_profiles(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE TABLE controller_commands (
  controller_id TEXT NOT NULL REFERENCES controller_profiles(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  command_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (controller_id, workspace_id, command, command_key)
);
CREATE TABLE controller_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  controller_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'controller'),
  command TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
