CREATE TABLE IF NOT EXISTS faction_member_cache (
  player_id TEXT PRIMARY KEY,
  player_name TEXT NOT NULL,
  faction_id TEXT NOT NULL,
  checked_at TEXT,
  is_director INTEGER NOT NULL DEFAULT 0,
  company_id TEXT,
  company_name TEXT,
  company_type TEXT,
  company_type_id INTEGER,
  company_rating INTEGER,
  daily_income REAL,
  weekly_income REAL,
  job_json TEXT,
  profile_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS faction_member_company_type_idx ON faction_member_cache(faction_id, is_director, company_type, weekly_income DESC);
CREATE INDEX IF NOT EXISTS faction_member_checked_idx ON faction_member_cache(faction_id, checked_at);
CREATE TABLE IF NOT EXISTS faction_director_snapshots (
  player_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  snapshot_day TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  stock_json TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY(player_id, company_id, snapshot_day)
);
CREATE INDEX IF NOT EXISTS faction_director_snapshots_company_idx ON faction_director_snapshots(company_id, snapshot_day);
