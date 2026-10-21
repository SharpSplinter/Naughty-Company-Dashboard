PRAGMA foreign_keys = ON;

-- Administrator privileges belong to an authenticated session only after a
-- separate step-up credential check. Ordinary Torn sessions default to zero.
ALTER TABLE sessions ADD COLUMN admin_elevated_until INTEGER NOT NULL DEFAULT 0;

-- Store only hashed attempt keys (player ID + Cloudflare client IP), never raw IPs
-- or usernames. Five failed attempts within 15 minutes cause a 15-minute lockout.
CREATE TABLE IF NOT EXISTS admin_auth_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS admin_auth_attempts_locked_until_idx
  ON admin_auth_attempts(locked_until);
