PRAGMA foreign_keys = ON;

-- Faction-wide aggregate counters are separate from per-member personalstats.
-- Keep captures timestamped and queryable after membership departures.
CREATE TABLE IF NOT EXISTS faction_stats_collection_runs (
  run_id TEXT PRIMARY KEY,
  collection_key TEXT NOT NULL UNIQUE,
  faction_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  scheduled_at TEXT NOT NULL,
  last_enqueued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS faction_stats_collection_runs_status_idx
  ON faction_stats_collection_runs(status, scheduled_at);
CREATE INDEX IF NOT EXISTS faction_stats_collection_runs_faction_idx
  ON faction_stats_collection_runs(faction_id, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS faction_stats_collection_state (
  faction_id TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_run_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS faction_stats_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  faction_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  collection_status TEXT NOT NULL CHECK (collection_status = 'complete'),
  stats_json TEXT NOT NULL,
  missing_stat_names_json TEXT NOT NULL DEFAULT '[]',
  unexpected_stat_names_json TEXT NOT NULL DEFAULT '[]',
  returned_stat_count INTEGER NOT NULL CHECK (returned_stat_count >= 0),
  response_version TEXT NOT NULL DEFAULT 'torn-v2'
);

CREATE INDEX IF NOT EXISTS faction_stats_snapshots_latest_idx
  ON faction_stats_snapshots(faction_id, captured_at DESC, snapshot_id DESC);
