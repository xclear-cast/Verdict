CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  user_goal TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  current_attempt INTEGER NOT NULL DEFAULT 0,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS debate_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  message TEXT NOT NULL,
  verdict TEXT NOT NULL,
  risks_json TEXT NOT NULL,
  focus_context_json TEXT,
  patch_json TEXT,
  timestamp TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_debate_turns_task_stage ON debate_turns(task_id, stage, attempt, round);

CREATE TABLE IF NOT EXISTS patches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  summary TEXT NOT NULL,
  unified_diff TEXT,
  touched_files_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  edit_ops_json TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  commands_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  passed INTEGER NOT NULL,
  failures_json TEXT NOT NULL,
  had_test_command INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS budgets (
  task_id TEXT PRIMARY KEY,
  model_calls INTEGER NOT NULL DEFAULT 0,
  stage_calls_json TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  limit_exceeded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  stage TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, id);
