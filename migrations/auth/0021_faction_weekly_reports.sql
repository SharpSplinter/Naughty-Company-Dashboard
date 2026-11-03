-- Immutable completed Sunday-to-Sunday faction performance reports.
-- Source collection runs and snapshots remain the auditable raw evidence.
CREATE TABLE IF NOT EXISTS faction_weekly_reports (
  faction_id TEXT NOT NULL,
  week_start_at TEXT NOT NULL,
  week_end_at TEXT NOT NULL,
  report_status TEXT NOT NULL CHECK (report_status IN ('complete', 'partial')),
  stats_start_run_id TEXT NOT NULL,
  stats_end_run_id TEXT NOT NULL,
  gym_start_run_id TEXT NOT NULL,
  gym_end_run_id TEXT NOT NULL,
  stats_start_captured_at TEXT,
  stats_end_captured_at TEXT,
  gym_start_captured_at TEXT,
  gym_end_captured_at TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  complete_member_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  finalized_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (faction_id, week_start_at)
);

CREATE INDEX IF NOT EXISTS faction_weekly_reports_recent_idx
  ON faction_weekly_reports(faction_id, week_start_at DESC);

CREATE TABLE IF NOT EXISTS faction_weekly_member_results (
  faction_id TEXT NOT NULL,
  week_start_at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  position TEXT,
  level INTEGER,
  participation TEXT NOT NULL CHECK (participation IN ('full_week', 'partial_week', 'unknown')),
  result_status TEXT NOT NULL CHECK (result_status IN ('complete', 'partial', 'incomplete', 'waiting_for_baseline', 'waiting_for_update', 'anomaly')),
  metrics_json TEXT NOT NULL,
  starting_networth REAL,
  ending_networth REAL,
  gym_energy REAL,
  known_metric_count INTEGER NOT NULL DEFAULT 0,
  anomaly_metrics_json TEXT NOT NULL DEFAULT '[]',
  baseline_captured_at TEXT,
  ending_captured_at TEXT,
  ending_is_boundary INTEGER NOT NULL DEFAULT 0,
  baseline_snapshot_id INTEGER,
  ending_snapshot_id INTEGER,
  gym_baseline_captured_at TEXT,
  gym_ending_captured_at TEXT,
  gym_ending_is_boundary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (faction_id, week_start_at, user_id)
);

CREATE INDEX IF NOT EXISTS faction_weekly_member_results_rank_idx
  ON faction_weekly_member_results(faction_id, week_start_at, result_status, user_id);

-- Application writes use INSERT OR IGNORE and never update/delete a finalized report.
CREATE TRIGGER IF NOT EXISTS faction_weekly_reports_no_update
BEFORE UPDATE ON faction_weekly_reports
BEGIN
  SELECT RAISE(ABORT, 'Finalized faction weekly reports are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS faction_weekly_reports_no_delete
BEFORE DELETE ON faction_weekly_reports
BEGIN
  SELECT RAISE(ABORT, 'Finalized faction weekly reports are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS faction_weekly_member_results_no_update
BEFORE UPDATE ON faction_weekly_member_results
BEGIN
  SELECT RAISE(ABORT, 'Finalized faction weekly member results are immutable.');
END;

CREATE TRIGGER IF NOT EXISTS faction_weekly_member_results_no_delete
BEFORE DELETE ON faction_weekly_member_results
BEGIN
  SELECT RAISE(ABORT, 'Finalized faction weekly member results are immutable.');
END;
