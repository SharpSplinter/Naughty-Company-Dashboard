-- Provision Discord account linking tables through the migration pipeline.
-- The poller hot path reads discord_account_links and must not bootstrap DDL per request.
CREATE TABLE IF NOT EXISTS discord_account_links (
  owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL UNIQUE,
  alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (alerts_enabled IN (0, 1)),
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_link_codes (
  code TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
