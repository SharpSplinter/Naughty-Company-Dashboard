CREATE TABLE IF NOT EXISTS company_data_sharing (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  ad_budget INTEGER NOT NULL DEFAULT 0 CHECK (ad_budget IN (0, 1)),
  employee_wages INTEGER NOT NULL DEFAULT 0 CHECK (employee_wages IN (0, 1)),
  employee_positions INTEGER NOT NULL DEFAULT 0 CHECK (employee_positions IN (0, 1)),
  employee_effectiveness INTEGER NOT NULL DEFAULT 0 CHECK (employee_effectiveness IN (0, 1)),
  stock_quantity_pricing INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity_pricing IN (0, 1)),
  updated_at TEXT NOT NULL
);
