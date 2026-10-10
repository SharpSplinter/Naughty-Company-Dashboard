PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  company_id TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('income_drop', 'stale_data', 'refresh_failure')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  threshold_percent REAL NOT NULL DEFAULT 15,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  stale_after_hours INTEGER NOT NULL DEFAULT 30,
  last_triggered_at TEXT,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  event_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES alert_rules(rule_id) ON DELETE CASCADE,
  company_id TEXT,
  rule_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  previous_value REAL,
  current_value REAL,
  change_percent REAL,
  source_snapshot_at TEXT,
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'acknowledged')),
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_runs (
  run_id TEXT PRIMARY KEY,
  trigger_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  companies_checked INTEGER NOT NULL DEFAULT 0,
  companies_failed INTEGER NOT NULL DEFAULT 0,
  alerts_created INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_owner_enabled ON alert_rules(owner_player_id, enabled, rule_type);
CREATE INDEX IF NOT EXISTS idx_alert_events_owner_status_created ON alert_events(owner_player_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC);
