PRAGMA foreign_keys = ON;

-- Event boundaries are stored explicitly. 2027 collection remains disabled
-- until its exact UTC window is confirmed and enabled by an administrator.
CREATE TABLE IF NOT EXISTS halloween_event_windows (
  event_year INTEGER PRIMARY KEY,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  historical_collection_enabled INTEGER NOT NULL DEFAULT 1 CHECK (historical_collection_enabled IN (0, 1)),
  live_collection_enabled INTEGER NOT NULL DEFAULT 0 CHECK (live_collection_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_at > start_at)
);

INSERT OR IGNORE INTO halloween_event_windows
  (event_year, start_at, end_at, historical_collection_enabled, live_collection_enabled, created_at, updated_at)
VALUES
  (2026, '2026-10-25T12:00:00Z', '2026-11-01T12:00:00Z', 1, 0, datetime('now'), datetime('now'));

CREATE TABLE IF NOT EXISTS halloween_collection_jobs (
  job_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  cursor_ts INTEGER NOT NULL,
  cursor_url TEXT,
  cursor_direction TEXT CHECK (cursor_direction IN ('next', 'prev')),
  pages_collected INTEGER NOT NULL DEFAULT 0,
  logs_collected INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS halloween_collection_jobs_player_idx
  ON halloween_collection_jobs(player_id, event_year, updated_at);

CREATE TABLE IF NOT EXISTS halloween_event_logs (
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  log_id TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  log_type_id INTEGER,
  category TEXT,
  title TEXT,
  labels_json TEXT NOT NULL,
  is_hit INTEGER NOT NULL DEFAULT 0 CHECK (is_hit IN (0, 1)),
  log_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (event_year, player_id, log_id)
);

CREATE INDEX IF NOT EXISTS halloween_event_logs_player_time_idx
  ON halloween_event_logs(event_year, player_id, event_timestamp);

CREATE TABLE IF NOT EXISTS halloween_live_snapshots (
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  treats_current INTEGER,
  treats_total INTEGER,
  upgrades_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  collection_status TEXT NOT NULL DEFAULT 'complete',
  PRIMARY KEY (event_year, player_id, captured_at)
);

CREATE INDEX IF NOT EXISTS halloween_live_snapshots_player_time_idx
  ON halloween_live_snapshots(event_year, player_id, captured_at);

-- One shared Torn API rate gate per player, not per API key.
CREATE TABLE IF NOT EXISTS halloween_api_throttles (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  last_request_at INTEGER NOT NULL
);
