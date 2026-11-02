PRAGMA foreign_keys = ON;

-- Faction performance history is intentionally not foreign-keyed to players.
-- A departing member loses credentials/access, but historical public snapshots
-- and membership intervals must remain queryable for completed weeks.
CREATE TABLE IF NOT EXISTS faction_performance_collection_runs (
  run_id TEXT PRIMARY KEY,
  collection_key TEXT NOT NULL UNIQUE,
  faction_id TEXT NOT NULL,
  collection_kind TEXT NOT NULL CHECK (collection_kind IN ('roster', 'personalstats', 'gym_energy')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  scheduled_at TEXT NOT NULL,
  target_user_ids_json TEXT,
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  last_enqueued_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS faction_performance_runs_status_idx
  ON faction_performance_collection_runs(status, collection_kind, scheduled_at);
CREATE INDEX IF NOT EXISTS faction_performance_runs_faction_idx
  ON faction_performance_collection_runs(faction_id, collection_kind, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS faction_performance_collection_state (
  faction_id TEXT NOT NULL,
  collection_kind TEXT NOT NULL CHECK (collection_kind IN ('roster', 'personalstats', 'gym_energy')),
  last_success_at TEXT,
  last_run_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (faction_id, collection_kind)
);

CREATE TABLE IF NOT EXISTS faction_membership_intervals (
  interval_id TEXT PRIMARY KEY,
  faction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_name TEXT,
  position TEXT,
  level INTEGER,
  days_in_faction INTEGER,
  estimated_joined_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  left_observed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS faction_membership_active_user_idx
  ON faction_membership_intervals(faction_id, user_id)
  WHERE left_observed_at IS NULL;
CREATE INDEX IF NOT EXISTS faction_membership_history_user_idx
  ON faction_membership_intervals(user_id, faction_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS faction_membership_active_idx
  ON faction_membership_intervals(faction_id, left_observed_at, user_id);

CREATE TABLE IF NOT EXISTS faction_roster_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  faction_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  response_version TEXT NOT NULL DEFAULT 'torn-v2'
);

CREATE TABLE IF NOT EXISTS faction_member_roster_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  faction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  name TEXT,
  position TEXT,
  level INTEGER,
  days_in_faction INTEGER,
  last_action_status TEXT,
  last_action_timestamp INTEGER,
  last_action_relative TEXT,
  status_description TEXT,
  status_details TEXT,
  status_state TEXT,
  status_until TEXT,
  status_color TEXT,
  is_revivable INTEGER,
  revive_setting TEXT,
  is_on_wall INTEGER,
  is_in_oc INTEGER,
  has_early_discharge INTEGER,
  UNIQUE(run_id, user_id)
);

CREATE INDEX IF NOT EXISTS faction_member_roster_history_idx
  ON faction_member_roster_snapshots(faction_id, user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS faction_member_roster_latest_idx
  ON faction_member_roster_snapshots(faction_id, captured_at DESC, user_id);

CREATE TABLE IF NOT EXISTS faction_member_stat_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  faction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  response_variant TEXT NOT NULL DEFAULT 'popular',
  collection_status TEXT NOT NULL CHECK (collection_status IN ('complete', 'partial', 'failed')),
  xantaken REAL,
  lsdtaken REAL,
  drugsused REAL,
  overdosed REAL,
  alcoholused REAL,
  boostersused REAL,
  energydrinkused REAL,
  refills REAL,
  statenhancersused REAL,
  networth REAL,
  cantaken REAL,
  exttaken REAL,
  kettaken REAL,
  opitaken REAL,
  shrtaken REAL,
  spetaken REAL,
  pcptaken REAL,
  victaken REAL,
  missing_metrics_json TEXT NOT NULL DEFAULT '[]',
  torn_error_code INTEGER,
  UNIQUE(run_id, user_id)
);

CREATE INDEX IF NOT EXISTS faction_member_stats_history_idx
  ON faction_member_stat_snapshots(faction_id, user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS faction_member_stats_period_idx
  ON faction_member_stat_snapshots(faction_id, captured_at DESC, user_id);

CREATE TABLE IF NOT EXISTS faction_gym_energy_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  faction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  gym_energy_total REAL,
  in_faction INTEGER,
  collection_status TEXT NOT NULL CHECK (collection_status IN ('complete', 'partial', 'failed')),
  UNIQUE(run_id, user_id)
);

CREATE INDEX IF NOT EXISTS faction_gym_energy_history_idx
  ON faction_gym_energy_snapshots(faction_id, user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS faction_gym_energy_period_idx
  ON faction_gym_energy_snapshots(faction_id, captured_at DESC, user_id);
