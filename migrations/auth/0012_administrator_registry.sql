PRAGMA foreign_keys = ON;

-- Administrator access is a durable player-ID role, not a password or
-- session elevation. Revocation is retained for the role-change audit trail.
CREATE TABLE IF NOT EXISTS administrators (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  CHECK (
    (revoked_by IS NULL AND revoked_at IS NULL)
    OR (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS administrators_active_idx
  ON administrators(revoked_at, player_id);

-- Preserve the existing primary owner as the first administrator if that
-- member already has a verified account in this database.
INSERT OR IGNORE INTO administrators (player_id, granted_by, granted_at)
SELECT player_id, player_id, datetime('now')
FROM players
WHERE player_id = '351311';
