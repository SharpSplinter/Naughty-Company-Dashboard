-- Dedicated Sunday 00:00 UTC boundary captures for weekly performance.
-- The collector uses the existing serialized queue and public faction key.
-- No member credentials or private owner-only selections are introduced here.
CREATE TABLE IF NOT EXISTS faction_weekly_boundary_runs (
  faction_id TEXT NOT NULL,
  boundary_at TEXT NOT NULL,
  stats_run_id TEXT NOT NULL,
  gym_energy_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (faction_id, boundary_at),
  UNIQUE (stats_run_id),
  UNIQUE (gym_energy_run_id)
);

CREATE INDEX IF NOT EXISTS faction_weekly_boundaries_recent_idx
  ON faction_weekly_boundary_runs(faction_id, boundary_at DESC);
