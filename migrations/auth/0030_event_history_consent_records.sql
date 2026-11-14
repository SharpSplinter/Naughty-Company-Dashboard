PRAGMA foreign_keys = ON;

-- Remember that the initial event-page consent was given, even if the member
-- later disables a collection key from Account Settings. This keeps subsequent
-- consent management out of the event pages without retaining disconnected keys.
CREATE TABLE IF NOT EXISTS event_history_consent_records (
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (event_key IN ('halloween', 'christmas-town')),
  first_consented_at TEXT NOT NULL,
  PRIMARY KEY (player_id, event_key)
);

-- Existing active connections already completed the initial consent flow.
INSERT OR IGNORE INTO event_history_consent_records (player_id, event_key, first_consented_at)
SELECT player_id, 'halloween', consented_at
FROM halloween_historical_keys;

INSERT OR IGNORE INTO event_history_consent_records (player_id, event_key, first_consented_at)
SELECT player_id, 'christmas-town', consented_at
FROM christmas_town_historical_keys;

-- Collection jobs prove that a member completed the initial event-page opt-in
-- even when they disconnected the key before this migration was introduced.
INSERT OR IGNORE INTO event_history_consent_records (player_id, event_key, first_consented_at)
SELECT player_id, 'halloween', MIN(created_at)
FROM halloween_collection_jobs
GROUP BY player_id;

INSERT OR IGNORE INTO event_history_consent_records (player_id, event_key, first_consented_at)
SELECT player_id, 'christmas-town', MIN(created_at)
FROM christmas_town_collection_jobs
GROUP BY player_id;
