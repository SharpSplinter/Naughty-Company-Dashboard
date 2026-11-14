PRAGMA foreign_keys = ON;

-- A verified faction ID and timestamp let the Worker periodically confirm
-- continued membership without making a Torn request on every page view.
ALTER TABLE players ADD COLUMN faction_id TEXT;
ALTER TABLE players ADD COLUMN faction_verified_at TEXT;

-- Existing player rows were created only after the legacy Worker verified
-- Naughty Souls membership. Their next stale session check refreshes this.
UPDATE players
SET faction_id = '8317',
    faction_verified_at = datetime('now')
WHERE faction_id IS NULL;
