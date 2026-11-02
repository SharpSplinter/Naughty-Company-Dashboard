import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const [worker, migration, adminPanel, app, accountSettings] = await Promise.all([
  readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/auth/0012_administrator_registry.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/components/floor/admin-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/floor/floor-app.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/portal/workspaces.tsx", import.meta.url), "utf8"),
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
assert.match(worker, /COUNT\(\*\) FROM administrators WHERE revoked_at IS NULL/)
assert.match(worker, /administrator\.revocation_blocked/)
assert.match(worker, /The last active administrator cannot be removed/)
assert.doesNotMatch(worker, /ADMIN_USERNAME|ADMIN_PASSWORD_HASH|isAdminElevated|admin_elevated_until/)
assert.match(adminPanel, /Administrator management/)
assert.match(adminPanel, /changeAdministratorRole/)
assert.doesNotMatch(app, /Unlock administration|adminPassword|adminUsername|\/api\/auth\/admin\/elevate/)
assert.match(accountSettings, /\/api\/auth\/key/)
assert.match(accountSettings, /\/api\/auth\/company-key/)
assert.match(accountSettings, /\/api\/me\/companies/)
assert.match(accountSettings, /\/api\/auth\/sign-out-all/)
assert.match(accountSettings, /\/api\/faction\/directors/)
assert.match(accountSettings, /Company leadership/)
assert.match(app, /routePath === "\/faction"[\\s\\S]*apiBase=\\{API_BASE\\}/)
assert.ok(worker.includes("FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.faction_id = ? AND st.disabled_at IS NULL"), "dashboard member lookups must exclude non-faction and disabled accounts")
assert.match(accountSettings, /validateTornKey|Validate & replace key/)
assert.match(accountSettings, /Remove key/)
console.log("PASS administrator lifecycle, account credentials, and faction workspace contracts")
