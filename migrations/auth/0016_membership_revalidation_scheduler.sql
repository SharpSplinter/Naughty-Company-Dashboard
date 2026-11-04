PRAGMA foreign_keys = ON;

-- Background membership checks are rate-limited per member so inactive accounts
-- can be revalidated without requiring a sign-in or treating Torn outages as
-- proof that a member has left the faction.
ALTER TABLE players ADD COLUMN membership_check_attempted_at TEXT;

CREATE INDEX IF NOT EXISTS players_membership_revalidation_idx
  ON players(faction_id, faction_verified_at, membership_check_attempted_at);
