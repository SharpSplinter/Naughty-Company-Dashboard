import { createHash, randomInt, randomUUID } from "node:crypto"

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "6c03b978ed9a59adc3f61c715bdad45c"
const DATABASE_ID = "1e37f1a5-daa3-41fb-8c1b-7a9c6e3d0405"
const QUEUE_NAME = "ncd-faction-performance-integration"
const FACTION_ID = "8317"
const WORKER_URL = process.env.FACTION_PERFORMANCE_WORKER_URL
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const MEMBER_IDS = [
  "980000001",
  "980000002",
  "980000003",
  "980000004",
  "980000005",
  "980000006",
]
const METRIC_COLUMNS = [
  "xantaken", "lsdtaken", "drugsused", "overdosed", "alcoholused",
  "boostersused", "energydrinkused", "refills", "statenhancersused",
  "networth", "cantaken", "exttaken", "kettaken", "opitaken",
  "shrtaken", "spetaken", "pcptaken", "victaken",
]

if (!API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required.")
if (!WORKER_URL) throw new Error("FACTION_PERFORMANCE_WORKER_URL is required.")

const apiBase = "https://api.cloudflare.com/client/v4"

async function cloudflareRequest(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.success !== true) {
    const message = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => item.message).filter(Boolean).join("; ")
      : "Cloudflare API request failed."
    throw new Error(`Cloudflare API HTTP ${response.status}: ${message}`)
  }
  return payload
}

async function d1Query(sql, params = []) {
  const payload = await cloudflareRequest(
    `/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  )
  const result = payload.result?.[0]
  if (result?.success !== true) throw new Error("Staging D1 query did not succeed.")
  return result.results ?? []
}

async function findQueue() {
  const payload = await cloudflareRequest(
    `/accounts/${ACCOUNT_ID}/queues?page=1&per_page=100`,
  )
  const queue = (payload.result ?? []).find((item) => item.queue_name === QUEUE_NAME)
  if (!queue?.queue_id) throw new Error(`Integration queue is missing: ${QUEUE_NAME}`)
  return queue.queue_id
}

async function publish(runId, queueId) {
  await cloudflareRequest(
    `/accounts/${ACCOUNT_ID}/queues/${queueId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        body: { kind: "faction-performance-collection", runId },
        content_type: "json",
      }),
    },
  )
}

async function createRun(kind, queueId, targetUserIds = null) {
  const runId = randomUUID()
  const now = new Date().toISOString()
  const scheduledAt = now
  const targetSql = targetUserIds ? "?" : "NULL"
  const params = [
    runId,
    `integration:${kind}:${runId}`,
    FACTION_ID,
    kind,
    scheduledAt,
    ...(targetUserIds ? [JSON.stringify(targetUserIds)] : []),
    now,
    now,
  ]
  await d1Query(
    `INSERT INTO faction_performance_collection_runs
      (run_id, collection_key, faction_id, collection_kind, status, scheduled_at,
       target_user_ids_json, next_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ${targetSql}, 0, ?, ?)`,
    params,
  )
  await publish(runId, queueId)
  return runId
}

async function waitForRun(runId, label) {
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    const rows = await d1Query(
      "SELECT status, next_index, last_error FROM faction_performance_collection_runs WHERE run_id = ?",
      [runId],
    )
    const row = rows[0]
    if (!row) throw new Error(`${label} run disappeared from staging D1.`)
    if (row.status === "completed" || row.status === "partial") return row
    if (row.status === "failed") {
      throw new Error(`${label} collection failed: ${row.last_error ?? "no error summary"}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`${label} collection did not reach a terminal state within eight minutes.`)
}

async function assertMigrationReady() {
  const rows = await d1Query(
    "SELECT name FROM d1_migrations WHERE name = ?",
    ["0019_faction_performance_collection.sql"],
  )
  if (rows.length !== 1) {
    throw new Error("Staging D1 is missing migration 0019. Run the staging migration workflow first.")
  }
  const expected = [
    "faction_performance_collection_runs",
    "faction_performance_collection_state",
    "faction_membership_intervals",
    "faction_roster_snapshots",
    "faction_member_roster_snapshots",
    "faction_member_stat_snapshots",
    "faction_gym_energy_snapshots",
  ]
  const placeholders = expected.map(() => "?").join(", ")
  const tables = await d1Query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    expected,
  )
  const found = new Set(tables.map((row) => row.name))
  const missing = expected.filter((name) => !found.has(name))
  if (missing.length) throw new Error(`Staging D1 is missing tables: ${missing.join(", ")}`)
}

async function assertApiRoute(rosterRunId) {
  const playerId = String(990000000000000 + randomInt(1, 999999))
  const token = `${randomUUID()}.${randomUUID()}`
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const now = new Date().toISOString()
  const expiresAt = String(Math.floor(Date.now() / 1000) + 600)

  await d1Query(
    `INSERT INTO players
      (player_id, player_name, created_at, updated_at, faction_id,
       faction_verified_at, membership_check_attempted_at, membership_check_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [playerId, "Faction performance integration test", now, now, FACTION_ID, now, now],
  )
  await d1Query(
    "INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [tokenHash, playerId, expiresAt, now],
  )

  try {
    const response = await fetch(`${WORKER_URL}/api/faction/performance`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload || !Array.isArray(payload.members)) {
      throw new Error(`Faction performance API returned HTTP ${response.status}.`)
    }
    if (payload.roster?.runId !== rosterRunId) {
      throw new Error("Faction performance API did not expose the completed integration roster.")
    }
    if (payload.members.length !== MEMBER_IDS.length) {
      throw new Error(`Expected ${MEMBER_IDS.length} API members; received ${payload.members.length}.`)
    }
    if (!payload.members.every((member) => member.stats && member.gymEnergy)) {
      throw new Error("Faction performance API did not join each member's stat and gym-energy samples.")
    }
    console.log("PASS authenticated faction performance API returned joined roster, stats, and gym-energy data.")
  } finally {
    await d1Query("DELETE FROM players WHERE player_id = ?", [playerId])
  }
}

async function main() {
  await assertMigrationReady()
  const queueId = await findQueue()

  const rosterRunId = await createRun("roster", queueId)
  const rosterRun = await waitForRun(rosterRunId, "Roster")
  if (rosterRun.status !== "completed") throw new Error("The fixture roster collection was unexpectedly partial.")

  const rosterHeader = await d1Query(
    "SELECT member_count FROM faction_roster_snapshots WHERE run_id = ?",
    [rosterRunId],
  )
  if (Number(rosterHeader[0]?.member_count) !== MEMBER_IDS.length) {
    throw new Error("The persisted roster snapshot has an unexpected member count.")
  }
  const membershipRows = await d1Query(
    "SELECT user_id FROM faction_membership_intervals WHERE faction_id = ? AND left_observed_at IS NULL ORDER BY user_id",
    [FACTION_ID],
  )
  const activeIds = membershipRows.map((row) => String(row.user_id))
  if (MEMBER_IDS.some((id) => !activeIds.includes(id))) {
    throw new Error("The roster collector did not persist all fixture membership intervals.")
  }
  console.log(`PASS roster collection persisted ${MEMBER_IDS.length} members and membership intervals.`)

  const statsRunId = await createRun("personalstats", queueId, MEMBER_IDS)
  const statsRun = await waitForRun(statsRunId, "Public personalstats")
  if (statsRun.status !== "completed" || Number(statsRun.next_index) !== MEMBER_IDS.length) {
    throw new Error("The five-member resumable personalstats queue did not finish cleanly.")
  }
  const metricProjection = METRIC_COLUMNS.map((column) => `${column} IS NOT NULL`).join(" AND ")
  const statRows = await d1Query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN collection_status = 'complete' THEN 1 ELSE 0 END) AS complete,
            SUM(CASE WHEN ${metricProjection} THEN 1 ELSE 0 END) AS all_metrics_present
       FROM faction_member_stat_snapshots WHERE run_id = ?`,
    [statsRunId],
  )
  if (Number(statRows[0]?.total) !== MEMBER_IDS.length ||
      Number(statRows[0]?.complete) !== MEMBER_IDS.length ||
      Number(statRows[0]?.all_metrics_present) !== MEMBER_IDS.length) {
    throw new Error("The 18 public personal-stat counters were not all persisted as complete values.")
  }
  console.log("PASS public personalstats collection resumed across the five-member queue page boundary.")

  const gymRunId = await createRun("gym_energy", queueId)
  const gymRun = await waitForRun(gymRunId, "Gym-energy")
  if (gymRun.status !== "completed") throw new Error("The fixture gym-energy collection was unexpectedly partial.")
  const gymRows = await d1Query(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN collection_status = 'complete' AND gym_energy_total IS NOT NULL THEN 1 ELSE 0 END) AS complete FROM faction_gym_energy_snapshots WHERE run_id = ?",
    [gymRunId],
  )
  if (Number(gymRows[0]?.total) !== MEMBER_IDS.length || Number(gymRows[0]?.complete) !== MEMBER_IDS.length) {
    throw new Error("Gym-energy contributor snapshots were not completely persisted.")
  }
  console.log("PASS gym-energy contributor snapshots persisted in staging D1.")

  const stateRows = await d1Query(
    "SELECT collection_kind, last_success_at, last_run_id FROM faction_performance_collection_state WHERE faction_id = ?",
    [FACTION_ID],
  )
  const stateByKind = new Map(stateRows.map((row) => [row.collection_kind, row]))
  for (const [kind, runId] of [["roster", rosterRunId], ["personalstats", statsRunId], ["gym_energy", gymRunId]]) {
    const state = stateByKind.get(kind)
    if (!state?.last_success_at || state.last_run_id !== runId) {
      throw new Error(`Collection state did not advance for ${kind}.`)
    }
  }
  console.log("PASS collection success timestamps advanced only after complete runs.")

  await assertApiRoute(rosterRunId)
  console.log("STAGING INTEGRATION PASSED. No production D1 or Worker was contacted.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Staging integration failed.")
  process.exitCode = 1
})
