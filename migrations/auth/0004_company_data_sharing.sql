CREATE TABLE IF NOT EXISTS company_data_sharing (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)),
  share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)),
  updated_at TEXT NOT NULL
);
