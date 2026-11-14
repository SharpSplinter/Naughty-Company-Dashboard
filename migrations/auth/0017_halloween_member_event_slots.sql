PRAGMA foreign_keys = ON;

-- Each member records the Trick or Treat event slot they selected in Torn.
-- TCT is UTC. The chosen clock time is applied to both configured calendar
-- dates so each member's personal event window can differ from other members.
CREATE TABLE IF NOT EXISTS halloween_member_event_slots (
  event_year INTEGER NOT NULL REFERENCES halloween_event_windows(event_year) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  start_minute_of_day INTEGER NOT NULL
    CHECK (start_minute_of_day BETWEEN 600 AND 960 AND start_minute_of_day % 15 = 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_year, player_id)
);

CREATE INDEX IF NOT EXISTS halloween_member_event_slots_year_idx
  ON halloween_member_event_slots(event_year, start_minute_of_day);

-- A historical collection job must keep the exact personal window it was
-- created for, even if the member later changes settings before a new run.
ALTER TABLE halloween_collection_jobs ADD COLUMN window_start_at TEXT;
ALTER TABLE halloween_collection_jobs ADD COLUMN window_end_at TEXT;

-- Existing jobs retain the shared window they originally used.
UPDATE halloween_collection_jobs
SET window_start_at = (
      SELECT start_at FROM halloween_event_windows
      WHERE event_year = halloween_collection_jobs.event_year
    ),
    window_end_at = (
      SELECT end_at FROM halloween_event_windows
      WHERE event_year = halloween_collection_jobs.event_year
    )
WHERE window_start_at IS NULL OR window_end_at IS NULL;
