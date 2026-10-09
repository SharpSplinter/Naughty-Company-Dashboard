PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS players (player_id TEXT PRIMARY KEY, player_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, last_four TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_player_id_idx ON sessions(player_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS companies (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, company_id TEXT NOT NULL, company_name TEXT, company_type TEXT, profile_json TEXT NOT NULL, employees_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (player_id, company_id));
CREATE TABLE IF NOT EXISTS company_snapshots (snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, company_id TEXT NOT NULL, profile_json TEXT NOT NULL, employees_json TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS company_snapshots_owner_idx ON company_snapshots(player_id, company_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS company_keys (player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, last_four TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS company_api_keys (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, company_id TEXT NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, last_four TEXT NOT NULL, company_name TEXT, company_type TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, company_id));
CREATE INDEX IF NOT EXISTS company_api_keys_player_idx ON company_api_keys(player_id);
CREATE TABLE IF NOT EXISTS company_financials (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, company_id TEXT NOT NULL, stock_json TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (player_id, company_id));
