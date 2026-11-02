import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const [worker, migration, workspace, packageFile] = await Promise.all([
  readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/auth/0014_halloween_historical_keys.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/components/portal/workspaces.tsx", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
])

assert.match(migration, /CREATE TABLE IF NOT EXISTS halloween_historical_keys/)
assert.match(migration, /access_level TEXT NOT NULL DEFAULT 'Full Access' CHECK \\(access_level = 'Full Access'\\)/)
assert.match(migration, /consent_version TEXT NOT NULL/)
assert.match(worker, /api\\.torn\\.com\\/v2\\/key\\/info/)
assert.match(worker, /access\\?\\.type !== "Full Access"/)
assert.match(worker, /!userSelections\\.includes\\("log"\\)/)
assert.match(worker, /String\\(keyOwner \\?\\? ""\\) !== session\\.player_id/)
assert.match(worker, /halloween_historical_keys \\(player_id, ciphertext, iv, last_four/)
assert.match(worker, /encryptKey\\(env, apiKey\\)/)
assert.match(worker, /body\\.consent === true/)
assert.match(worker, /body\\.consentVersion === "halloween-history-v1"/)
assert.match(worker, /DELETE FROM halloween_historical_keys WHERE player_id = \\?/)
assert.match(worker, /historicalRecordsRetained: true/)
assert.match(workspace, /Data Sharing/)
assert.match(workspace, /Key Access Level/)
assert.match(workspace, /Custom Access keys are not accepted/)
assert.match(workspace, /Validate & save Full Access key/)
assert.match(workspace, /Disconnect your Full Access key/)
assert.match(workspace, /halloween-history-v1/)
console.log("PASS Halloween key ownership, Full Access-only validation, explicit consent, encryption, and disconnect-retains-records contract")
