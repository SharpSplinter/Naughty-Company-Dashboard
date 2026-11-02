PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS halloween_event_windows (
  event_year INTEGER PRIMARY KEY,
  starts_at TEXT,
  ends_at TEXT,
  snapshot_interval_hours INTEGER NOT NULL DEFAULT 6,
  auto_snapshots_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_snapshots_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);

-- The 2026 event window is known and can be used for historical log collection.
-- 2027 scheduling stays disabled until its exact UTC boundaries are confirmed.
INSERT OR IGNORE INTO halloween_event_windows
  (event_year, starts_at, ends_at, snapshot_interval_hours, auto_snapshots_enabled, created_at, updated_at)
VALUES
  (2026, '2026-10-25T12:00:00Z', '2026-11-01T12:00:00Z', 6, 0, datetime('now'), datetime('now')),
  (2027, NULL, NULL, 6, 0, datetime('now'), datetime('now'));

CREATE TABLE IF NOT EXISTS halloween_live_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('opening', 'periodic', 'closing', 'manual', 'book-activation', 'company-change')),
  treats_current INTEGER,
  treats_total INTEGER,
  basket_upgrades_json TEXT,
  source_timestamp INTEGER,
  captured_at TEXT NOT NULL,
  UNIQUE (event_year, player_id, snapshot_kind, captured_at)
);

CREATE INDEX IF NOT EXISTS halloween_live_snapshots_year_player_idx
  ON halloween_live_snapshots(event_year, player_id, captured_at);

CREATE TABLE IF NOT EXISTS halloween_attacks (
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  attack_id TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER NOT NULL,
  result TEXT,
  attacker_id TEXT,
  attacker_name TEXT,
  defender_id TEXT,
  defender_name TEXT,
  respect_gain REAL,
  respect_loss REAL,
  chain INTEGER,
  finishing_hit_effects_json TEXT,
  attack_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (event_year, player_id, attack_id)
);

CREATE INDEX IF NOT EXISTS halloween_attacks_year_player_time_idx
  ON halloween_attacks(event_year, player_id, ended_at, attack_id);

CREATE TABLE IF NOT EXISTS halloween_event_logs (
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  log_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  category_id INTEGER,
  log_type_id INTEGER,
  title TEXT,
  labels_json TEXT NOT NULL,
  log_json TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (event_year, player_id, log_id)
);

CREATE INDEX IF NOT EXISTS halloween_event_logs_year_player_time_idx
  ON halloween_event_logs(event_year, player_id, timestamp, log_id);

CREATE TABLE IF NOT EXISTS halloween_collection_state (
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_collected' CHECK (status IN ('not_collected', 'queued', 'running', 'completed', 'partial', 'failed')),
  range_start TEXT,
  range_end TEXT,
  attack_count INTEGER,
  total_hits INTEGER,
  successful_hits INTEGER,
  revitalize_proc_count INTEGER,
  daily_hits_json TEXT,
  log_count INTEGER,
  last_attempt_at TEXT,
  completed_at TEXT,
  error_summary TEXT,
  PRIMARY KEY (event_year, player_id)
);

CREATE INDEX IF NOT EXISTS halloween_collection_state_year_status_idx
  ON halloween_collection_state(event_year, status);
