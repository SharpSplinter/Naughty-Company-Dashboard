-- Keep canonical daily rankings independently of the replaceable latest-ranking cache.
CREATE TABLE IF NOT EXISTS global_company_rank_snapshots (
  reporting_day TEXT NOT NULL,
  company_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  company_type TEXT NOT NULL,
  company_type_id INTEGER,
  global_rank INTEGER NOT NULL CHECK (global_rank >= 1),
  type_rank INTEGER NOT NULL CHECK (type_rank >= 1),
  star_rating INTEGER,
  weekly_income REAL,
  daily_income REAL,
  average_daily_income REAL,
  director_name TEXT NOT NULL DEFAULT '',
  source_fetched_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (reporting_day, company_id)
);

CREATE INDEX IF NOT EXISTS idx_global_company_rank_snapshots_company_day
  ON global_company_rank_snapshots (company_id, reporting_day);

CREATE INDEX IF NOT EXISTS idx_global_company_rank_snapshots_day_type_rank
  ON global_company_rank_snapshots (reporting_day, company_type_id, type_rank);

CREATE TABLE IF NOT EXISTS faction_company_rank_snapshots (
  reporting_day TEXT NOT NULL,
  faction_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  member_checked_at TEXT,
  director_name TEXT NOT NULL DEFAULT '',
  company_name TEXT NOT NULL,
  company_type TEXT NOT NULL,
  company_type_id INTEGER,
  faction_rank INTEGER NOT NULL CHECK (faction_rank >= 1),
  type_rank INTEGER NOT NULL CHECK (type_rank >= 1),
  star_rating INTEGER,
  weekly_income REAL,
  daily_income REAL,
  source_fetched_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (reporting_day, faction_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_faction_company_rank_snapshots_company_day
  ON faction_company_rank_snapshots (company_id, faction_id, reporting_day);

CREATE INDEX IF NOT EXISTS idx_faction_company_rank_snapshots_day_faction_rank
  ON faction_company_rank_snapshots (reporting_day, faction_id, faction_rank);
