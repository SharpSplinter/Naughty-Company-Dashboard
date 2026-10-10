PRAGMA foreign_keys = ON;

-- Access can be suspended without deleting a player's identity or company history.
CREATE TABLE IF NOT EXISTS dashboard_member_status (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  disabled_at TEXT,
  disabled_by TEXT,
  disable_reason TEXT,
  updated_at TEXT NOT NULL
);

-- Only explicitly supported, validated dashboard-wide controls are stored here.
CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Append-only through the application; never store API keys, tokens, or raw credentials.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_player_id TEXT NOT NULL,
  actor_player_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied', 'pending')),
  summary TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit_log(target_type, target_id, created_at DESC);

-- Refresh and repair tasks are tracked so requests can be safely retried and inspected.
CREATE TABLE IF NOT EXISTS admin_jobs (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  target_player_id TEXT,
  target_company_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS admin_jobs_created_idx ON admin_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_jobs_target_idx ON admin_jobs(target_player_id, target_company_id, status);
