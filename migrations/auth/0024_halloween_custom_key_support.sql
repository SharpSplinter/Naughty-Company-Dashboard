PRAGMA foreign_keys = ON;

-- The unified portal credential may be either Full Access or a Custom Access
-- key. Historical collection still requires the explicit User -> Log
-- selection and a separate member consent record.
CREATE TABLE halloween_historical_keys_new (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  last_four TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'Full Access'
    CHECK (access_level IN ('Full Access', 'Custom Access', 'Custom')),
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO halloween_historical_keys_new
  (player_id, ciphertext, iv, last_four, access_level, consent_version,
   consented_at, last_validated_at, created_at, updated_at)
SELECT player_id, ciphertext, iv, last_four, access_level, consent_version,
       consented_at, last_validated_at, created_at, updated_at
FROM halloween_historical_keys;

DROP TABLE halloween_historical_keys;
ALTER TABLE halloween_historical_keys_new RENAME TO halloween_historical_keys;

CREATE INDEX IF NOT EXISTS halloween_historical_keys_updated_idx
  ON halloween_historical_keys(updated_at);
