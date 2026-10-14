CREATE TABLE IF NOT EXISTS company_financial_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  company_id TEXT NOT NULL,
  stock_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS company_financial_snapshots_owner_idx
  ON company_financial_snapshots(player_id, company_id, fetched_at DESC);
