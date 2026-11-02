PRAGMA foreign_keys = ON;

-- Historical Halloween credentials are supplied by each member individually.
-- Only verified Full Access keys with user log access may be stored.
CREATE TABLE IF NOT EXISTS halloween_historical_keys (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  last_four TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'Full Access' CHECK (access_level = 'Full Access'),
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS halloween_historical_keys_updated_idx
  ON halloween_historical_keys(updated_at);
