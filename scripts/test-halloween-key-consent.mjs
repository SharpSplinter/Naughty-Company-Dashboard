import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const [worker, migration, workspace] = await Promise.all([
  readFile(new URL("../src/worker/index.ts", import.meta.url), "utf8"),
  readFile(new URL("../migrations/auth/0024_halloween_custom_key_support.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/components/portal/workspaces.tsx", import.meta.url), "utf8"),
])

assert.ok(migration.includes("CREATE TABLE halloween_historical_keys_new"))
assert.ok(migration.includes("ALTER TABLE halloween_historical_keys_new RENAME TO halloween_historical_keys"))
assert.ok(migration.includes("CHECK (access_level IN ('Full Access', 'Custom Access', 'Custom'))"))
assert.ok(migration.includes("consent_version TEXT NOT NULL"))
assert.ok(worker.includes('fetch("https://api.torn.com/v2/key/info"'))
assert.ok(worker.includes('accessType !== "Full Access" && !supportsCustomLog'))
assert.ok(worker.includes('supportsCustomLog = (accessType === "Custom Access" || accessType === "Custom") && userSelections.includes("log")'))
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
assert.ok(workspace.includes("Custom Access with the User → Log selection"))
assert.ok(workspace.includes("Enable historical collection with portal key"))
assert.ok(workspace.includes("No second API key is required."))
assert.doesNotMatch(workspace, /halloween-full-access-key|Paste your own Full Access Torn API key/)
assert.ok(workspace.includes("Disable historical collection"))
assert.ok(workspace.includes("halloween-history-v1"))
assert.ok(worker.includes("LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.faction_id = ? AND st.disabled_at IS NULL"), "disabled accounts must be excluded from the shared historical leaderboard")
assert.ok(worker.includes("p.player_id = ? AND p.faction_id = ? AND st.disabled_at IS NULL"), "disabled accounts must not expose member event details")
assert.ok(worker.includes("Collection was cancelled because this member's dashboard access is disabled."), "queued historical collection must stop for disabled accounts")
assert.ok(worker.includes("Snapshot was cancelled because this member's dashboard access is disabled."), "queued live snapshots must stop for disabled accounts")
assert.ok(worker.includes("AS snapshotKind") && worker.includes("AS sourceTimestamp"))
assert.ok(worker.includes("if (hasSnapshotInWindow && row.upgradesJson != null)") && worker.includes("upgradesUnlocked: upgrades === null ? null : upgrades.length"), "members without a snapshot inside their own event window must retain unknown upgrade counts")
assert.ok(workspace.includes("/api/me/halloween/live?year="), "the Live tab must load the faction leaderboard API")
assert.ok(workspace.includes("live.leaderboard.map"), "the Live tab must render per-member snapshot rows")
assert.ok(workspace.includes("member.sourceTimestamp"), "the Live leaderboard must show Torn source-time provenance")
assert.ok(workspace.includes("/api/me/halloween/live-snapshot"), "members must be able to request an in-window live snapshot")
console.log("PASS Halloween key ownership, custom/full key selection validation, portal-key consent, encryption, and disconnect retention and live leaderboard contract")
