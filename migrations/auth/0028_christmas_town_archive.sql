PRAGMA foreign_keys = ON;

-- Christmas Town history has its own consent and archive. Its records are
-- personal to the contributing member and are not shared in faction reports.
CREATE TABLE IF NOT EXISTS christmas_town_historical_keys (
  player_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  last_four TEXT NOT NULL,
  access_level TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS christmas_town_collection_jobs (
  job_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  event_year INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  cursor_ts INTEGER NOT NULL,
  cursor_url TEXT,
  cursor_direction TEXT,
  pages_collected INTEGER NOT NULL DEFAULT 0,
  logs_collected INTEGER NOT NULL DEFAULT 0,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (player_id, event_year),
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_christmas_town_jobs_player_year
  ON christmas_town_collection_jobs(player_id, event_year DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS christmas_town_event_logs (
  player_id TEXT NOT NULL,
  event_year INTEGER NOT NULL,
  log_id TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  log_type_id INTEGER,
  category TEXT,
  title TEXT,
  log_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (player_id, log_id),
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_christmas_town_logs_player_timestamp
  ON christmas_town_event_logs(player_id, event_timestamp, log_id);
