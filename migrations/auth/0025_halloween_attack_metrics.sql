PRAGMA foreign_keys = ON;

-- Detailed attacks expose finishing-hit effects (including Revitalize).
-- Keep this collection separate from historical log paging so an existing
-- completed log archive can safely add/retry attack-effect coverage.
CREATE TABLE IF NOT EXISTS halloween_attack_metrics_jobs (
  job_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed', 'cancelled')),
  cursor_url TEXT,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  pages_collected INTEGER NOT NULL DEFAULT 0,
  attacks_reviewed INTEGER NOT NULL DEFAULT 0,
  revitalize_procs INTEGER NOT NULL DEFAULT 0,
  revitalize_chances_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (event_year, player_id),
  CHECK (window_end_at > window_start_at)
);

CREATE INDEX IF NOT EXISTS halloween_attack_metrics_jobs_status_idx
  ON halloween_attack_metrics_jobs(status, updated_at);
