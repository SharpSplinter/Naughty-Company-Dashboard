CREATE TABLE automation_preferences_new (
  owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  browser_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_notifications_enabled IN (0, 1)),
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_hours_enabled IN (0, 1)),
  quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
  quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  minimum_severity TEXT NOT NULL DEFAULT 'info' CHECK (minimum_severity IN ('info', 'warning', 'critical')),
  digest_mode TEXT NOT NULL DEFAULT 'instant' CHECK (digest_mode IN ('instant', 'daily', 'both', 'off')),
  updated_at TEXT NOT NULL
);

INSERT INTO automation_preferences_new (owner_player_id, browser_notifications_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone, minimum_severity, digest_mode, updated_at)
SELECT owner_player_id, browser_notifications_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone, minimum_severity, digest_mode, updated_at
FROM automation_preferences;

DROP TABLE automation_preferences;
ALTER TABLE automation_preferences_new RENAME TO automation_preferences;
