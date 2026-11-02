import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const [worker, migration, workspace] = await Promise.all([
  readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/auth/0014_halloween_historical_keys.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/components/portal/workspaces.tsx", import.meta.url), "utf8"),
])

assert.ok(migration.includes("CREATE TABLE IF NOT EXISTS halloween_historical_keys"))
assert.ok(migration.includes("access_level TEXT NOT NULL DEFAULT 'Full Access' CHECK (access_level = 'Full Access')"))
assert.ok(migration.includes("consent_version TEXT NOT NULL"))
assert.ok(worker.includes('fetch("https://api.torn.com/v2/key/info"'))
assert.ok(worker.includes('access?.type !== "Full Access"'))
assert.ok(worker.includes('!userSelections.includes("log")'))
assert.ok(worker.includes('String(keyOwner ?? "") !== session.player_id'))
assert.ok(worker.includes("halloween_historical_keys (player_id, ciphertext, iv, last_four"))
assert.ok(worker.includes("encryptKey(env, apiKey)"))
assert.ok(worker.includes("body.consent === true"))
assert.ok(worker.includes('consentVersion !== "halloween-history-v1"'))
assert.ok(worker.includes("DELETE FROM halloween_historical_keys WHERE player_id = ?"))
assert.ok(worker.includes("historicalRecordsRetained: true"))
assert.ok(workspace.includes("Data Sharing"))
assert.ok(workspace.includes("Key Access Level"))
assert.ok(workspace.includes("Custom Access keys are not accepted"))
assert.ok(workspace.includes("Validate & save Full Access key"))
assert.ok(workspace.includes("Disconnect your Full Access key"))
assert.ok(workspace.includes("halloween-history-v1"))
console.log("PASS Halloween key ownership, Full Access-only validation, consent, encryption, and disconnect retention contract")
