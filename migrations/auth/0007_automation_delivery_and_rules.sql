CREATE TABLE alert_rules_expanded (
  rule_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  company_id TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('income_drop', 'stale_data', 'refresh_failure', 'income_increase', 'rating_drop', 'roster_change')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  threshold_percent REAL NOT NULL DEFAULT 15,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  stale_after_hours INTEGER NOT NULL DEFAULT 30,
  last_triggered_at TEXT,
  last_evaluated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE alert_events_expanded (
  event_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES alert_rules_expanded(rule_id) ON DELETE CASCADE,
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

INSERT INTO alert_rules_expanded (rule_id, owner_player_id, company_id, rule_type, enabled, threshold_percent, cooldown_hours, stale_after_hours, last_triggered_at, last_evaluated_at, created_at, updated_at)
SELECT rule_id, owner_player_id, company_id, rule_type, enabled, threshold_percent, cooldown_hours, stale_after_hours, last_triggered_at, last_evaluated_at, created_at, updated_at FROM alert_rules;
INSERT INTO alert_events_expanded (event_id, owner_player_id, rule_id, company_id, rule_type, severity, title, message, previous_value, current_value, change_percent, source_snapshot_at, status, dedupe_key, created_at, acknowledged_at)
SELECT event_id, owner_player_id, rule_id, company_id, rule_type, severity, title, message, previous_value, current_value, change_percent, source_snapshot_at, status, dedupe_key, created_at, acknowledged_at FROM alert_events;

DROP TABLE alert_events;
DROP TABLE alert_rules;
ALTER TABLE alert_rules_expanded RENAME TO alert_rules;
ALTER TABLE alert_events_expanded RENAME TO alert_events;
CREATE INDEX IF NOT EXISTS idx_alert_rules_owner_enabled ON alert_rules(owner_player_id, enabled, rule_type);
CREATE INDEX IF NOT EXISTS idx_alert_events_owner_status_created ON alert_events(owner_player_id, status, created_at);

CREATE TABLE IF NOT EXISTS automation_preferences (
  owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  browser_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_notifications_enabled IN (0, 1)),
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_hours_enabled IN (0, 1)),
  quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  minimum_severity TEXT NOT NULL DEFAULT 'info' CHECK (minimum_severity IN ('info', 'warning', 'critical')),
  digest_mode TEXT NOT NULL DEFAULT 'instant' CHECK (digest_mode IN ('instant', 'daily', 'off')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_webhooks (
  owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_delivered_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS automation_delivery_log (
  delivery_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES alert_events(event_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
  status_code INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_automation_delivery_owner_created ON automation_delivery_log(owner_player_id, created_at DESC);

