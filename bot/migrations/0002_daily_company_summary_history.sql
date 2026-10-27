-- Persist each reporting day's summary metrics so retries do not erase prior-day comparisons.
CREATE TABLE IF NOT EXISTS discord_daily_company_summary_history (
  discord_user_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  snapshot_day TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(discord_user_id,company_id,snapshot_day)
);
