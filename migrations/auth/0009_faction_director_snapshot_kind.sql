ALTER TABLE faction_director_snapshots ADD COLUMN snapshot_kind TEXT NOT NULL DEFAULT 'legacy' CHECK (snapshot_kind IN ('initialization', 'lock-in', 'legacy'));
