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
