CREATE TABLE IF NOT EXISTS faction_star_weekly_counts (
  week_key TEXT NOT NULL,
  star_rating INTEGER NOT NULL,
  company_count INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (week_key, star_rating)
);
