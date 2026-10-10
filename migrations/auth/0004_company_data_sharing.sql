-- Keep the legacy preferences table for existing installations and migrate its values
-- into the simpler account-level privacy controls used by the current dashboard.
CREATE TABLE IF NOT EXISTS company_data_sharing (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  ad_budget INTEGER NOT NULL DEFAULT 0 CHECK (ad_budget IN (0, 1)),
  employee_wages INTEGER NOT NULL DEFAULT 0 CHECK (employee_wages IN (0, 1)),
  employee_positions INTEGER NOT NULL DEFAULT 0 CHECK (employee_positions IN (0, 1)),
  employee_effectiveness INTEGER NOT NULL DEFAULT 0 CHECK (employee_effectiveness IN (0, 1)),
  stock_quantity_pricing INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity_pricing IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_sharing_preferences (
  player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)),
  share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO company_sharing_preferences (player_id, share_financial_data, share_employee_data, updated_at)
SELECT player_id,
       CASE WHEN ad_budget = 1 OR stock_quantity_pricing = 1 THEN 1 ELSE 0 END,
       CASE WHEN employee_wages = 1 OR employee_positions = 1 OR employee_effectiveness = 1 THEN 1 ELSE 0 END,
       updated_at
FROM company_data_sharing;
