import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const [worker, migration, adminPanel, app] = await Promise.all([
  readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/auth/0012_administrator_registry.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/components/floor/admin-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/floor/floor-app.tsx", import.meta.url), "utf8"),
])

assert.match(migration, /CREATE TABLE IF NOT EXISTS administrators/)
assert.match(migration, /player_id TEXT PRIMARY KEY REFERENCES players/)
assert.match(migration, /revoked_at TEXT/)
assert.match(migration, /WHERE player_id = '351311'/)
assert.match(worker, /LEFT JOIN administrators a ON a\.player_id = p\.player_id AND a\.revoked_at IS NULL/)
assert.match(worker, /if \(session\.is_admin !== 1\)/)
assert.match(worker, /\/api\/admin\/administrators\/grant/)
assert.match(worker, /\/api\/admin\/administrators\/revoke/)
assert.match(worker, /INSERT INTO administrators/)
assert.match(worker, /administrator\.granted/)
assert.match(worker, /administrator\.revoked/)
assert.doesNotMatch(worker, /ADMIN_USERNAME|ADMIN_PASSWORD_HASH|isAdminElevated|admin_elevated_until/)
assert.match(adminPanel, /Administrator management/)
assert.match(adminPanel, /changeAdministratorRole/)
assert.doesNotMatch(app, /Unlock administration|adminPassword|adminUsername|\/api\/auth\/admin\/elevate/)
console.log("PASS administrator role registry, grant/revoke audit, and no-password UI contract")
