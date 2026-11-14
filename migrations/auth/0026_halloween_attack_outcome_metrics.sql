PRAGMA foreign_keys = ON;

-- Extend the per-member, per-event detailed attack collection with the
-- outcome totals needed by Live Halloween Stats.
ALTER TABLE halloween_attack_metrics_jobs
  ADD COLUMN successful_attacks INTEGER NOT NULL DEFAULT 0;

ALTER TABLE halloween_attack_metrics_jobs
  ADD COLUMN lost_stalemated_attacks INTEGER NOT NULL DEFAULT 0;

ALTER TABLE halloween_attack_metrics_jobs
  ADD COLUMN outcomes_version INTEGER NOT NULL DEFAULT 0;
