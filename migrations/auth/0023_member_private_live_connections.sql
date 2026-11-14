PRAGMA foreign_keys = ON;

-- A member's owner-only Torn key is a separate credential class. It is
-- explicitly consented, encrypted, and used only for their own live selections.
CREATE TABLE IF NOT EXISTS member_private_live_keys (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  faction_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  last_four TEXT NOT NULL,
  include_networth INTEGER NOT NULL DEFAULT 0 CHECK (include_networth IN (0, 1)),
  share_with_faction INTEGER NOT NULL DEFAULT 1 CHECK (share_with_faction IN (0, 1)),
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  last_attempt_at TEXT,
  last_collected_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS member_private_live_keys_faction_idx
  ON member_private_live_keys(faction_id, share_with_faction, updated_at);

-- Shared per-member request budget across connect and refresh attempts. Failed
-- validation attempts count too, preventing repeated Torn calls via key replace.
CREATE TABLE IF NOT EXISTS member_private_live_api_throttles (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  last_attempt_at TEXT NOT NULL
);

-- Keep only each member's latest live values, not a historical trail. Revoking
-- the key removes this current faction-shared snapshot immediately.
CREATE TABLE IF NOT EXISTS faction_member_private_live_snapshots (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  faction_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  bars_json TEXT NOT NULL,
  cooldowns_json TEXT NOT NULL,
  networth_json TEXT,
  source_timestamps_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS faction_member_private_live_snapshots_latest_idx
  ON faction_member_private_live_snapshots(faction_id, captured_at DESC);
