-- Idempotent schema for the production Discord bot D1 database.
-- Keep in sync with ensureBotSchema() in production-worker.js.
CREATE TABLE IF NOT EXISTS discord_links (
  discord_user_id TEXT PRIMARY KEY,
  dashboard_player_id TEXT NOT NULL,
  encrypted_session_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_preferences (
  discord_user_id TEXT PRIMARY KEY REFERENCES discord_links(discord_user_id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  severities TEXT NOT NULL DEFAULT '["critical","warning"]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  delivery_key TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS discord_alert_state (
  discord_user_id TEXT PRIMARY KEY,
  linked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_alert_deliveries (
  discord_user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(discord_user_id,event_id)
);

CREATE TABLE IF NOT EXISTS discord_alert_poll_state (
  discord_user_id TEXT PRIMARY KEY,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_success_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_error_code TEXT,
  last_error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_page_count INTEGER NOT NULL DEFAULT 0,
  last_events_seen INTEGER NOT NULL DEFAULT 0,
  last_delivered INTEGER NOT NULL DEFAULT 0,
  last_filtered INTEGER NOT NULL DEFAULT 0,
  last_failed INTEGER NOT NULL DEFAULT 0,
  last_exhausted INTEGER NOT NULL DEFAULT 0,
  last_stale_recovered INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_alert_poll_escalations (
  discord_user_id TEXT NOT NULL,
  escalation_key TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  notification_delivered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(discord_user_id,escalation_key)
);
