PRAGMA foreign_keys = ON;

-- Distinguish a successful membership check from an in-flight check, a
-- temporary Torn outage, and a confirmed departure whose cleanup must retry.
-- Only 'unavailable' can use the bounded last-success outage grace.
ALTER TABLE players ADD COLUMN membership_check_status TEXT
  CHECK (membership_check_status IN ('checking', 'unavailable', 'cleanup_pending'));

CREATE INDEX IF NOT EXISTS players_membership_check_status_idx
  ON players(membership_check_status, membership_check_attempted_at, faction_id);
