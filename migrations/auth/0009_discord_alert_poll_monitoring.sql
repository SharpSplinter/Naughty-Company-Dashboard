CREATE TABLE IF NOT EXISTS discord_alert_poll_health (
  owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  poll_started_at TEXT,
  poll_completed_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  error_code TEXT,
  error_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  events_seen INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  filtered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  stale_recovered INTEGER NOT NULL DEFAULT 0,
  exhausted_deliveries INTEGER NOT NULL DEFAULT 0,
  stale_claims INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_alert_poll_history (
  report_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL,
  poll_started_at TEXT,
  poll_completed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  events_seen INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  filtered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  stale_recovered INTEGER NOT NULL DEFAULT 0,
  exhausted_deliveries INTEGER NOT NULL DEFAULT 0,
  stale_claims INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_discord_alert_poll_history_owner_completed
  ON discord_alert_poll_history(owner_player_id, discord_user_id, poll_completed_at DESC);
