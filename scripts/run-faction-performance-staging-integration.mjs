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

async function waitForFailedRun(runId, label) {
  const deadline = Date.now() + 8 * 60 * 1000
  while (Date.now() < deadline) {
    const rows = await d1Query(
      "SELECT status, next_index, last_error FROM faction_performance_collection_runs WHERE run_id = ?",
      [runId],
    )
    const row = rows[0]
    if (!row) throw new Error(`${label} run disappeared from staging D1.`)
    if (row.status === "failed") return row
    if (row.status === "completed" || row.status === "partial") {
      throw new Error(`${label} run unexpectedly finished as ${row.status} instead of reaching the DLQ.`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`${label} message did not reach the dead-letter queue within eight minutes.`)
}

async function assertMigrationReady() {
  const rows = await d1Query(
    "SELECT name FROM d1_migrations WHERE name IN (?, ?)",
    ["0019_faction_performance_collection.sql", "0020_faction_weekly_boundaries.sql"],
  )
  if (rows.length !== 2) {
    throw new Error("Staging D1 is missing faction collection or weekly boundary migrations 0019/0020. Run the staging migration workflow first.")
  }
  const expected = [
    "faction_performance_collection_runs",
    "faction_performance_collection_state",
    "faction_membership_intervals",
    "faction_roster_snapshots",
    "faction_member_roster_snapshots",
    "faction_member_stat_snapshots",
    "faction_gym_energy_snapshots",
    "faction_weekly_boundary_runs",
  ]
  const placeholders = expected.map(() => "?").join(", ")
  const tables = await d1Query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    expected,
  )
  const found = new Set(tables.map((row) => row.name))
  const missing = expected.filter((name) => !found.has(name))
  if (missing.length) throw new Error(`Staging D1 is missing tables: ${missing.join(", ")}`)
  const foreignKeys = await d1Query("PRAGMA foreign_key_list(faction_membership_intervals)")
  if (foreignKeys.some((row) => row.table === "players")) {
    throw new Error("Membership history must not have a player foreign key or departure cascade.")
  }
}

function sundayStartIso(timestampMs = Date.now()) {
  const date = new Date(timestampMs)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  return date.toISOString()
}

async function seedWeeklyFixtures() {
  const weekStartAt = sundayStartIso()
  const weekStartMs = Date.parse(weekStartAt)
  const statsBaselineAt = new Date(weekStartMs + 2 * 60 * 1000).toISOString()
  const now = new Date().toISOString()
  // End-of-week samples are dated after the integration collection runs above,
  // so previous staging runs cannot accidentally become the newest ending sample.
  const statsEndingAt = now
  const gymBaselineAt = new Date(weekStartMs + 3 * 60 * 1000).toISOString()
  const gymEndingAt = now
  const statsBaselineRunId = randomUUID()
  const statsEndingRunId = randomUUID()
  const gymBaselineRunId = randomUUID()
  const gymEndingRunId = randomUUID()
  const targetJson = JSON.stringify(MEMBER_IDS)

  async function insertCompletedRun(runId, kind, scheduledAt, startedAt, completedAt) {
    await d1Query(
      `INSERT INTO faction_performance_collection_runs
        (run_id, collection_key, faction_id, collection_kind, status, scheduled_at,
         target_user_ids_json, next_index, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`,
      [runId, `integration:weekly:${kind}:${runId}`, FACTION_ID, kind, scheduledAt,
        kind === "personalstats" ? targetJson : null,
        kind === "personalstats" ? MEMBER_IDS.length : 0, startedAt, completedAt, now, now],
    )
  }

  await insertCompletedRun(statsBaselineRunId, "personalstats", weekStartAt, statsBaselineAt, statsBaselineAt)
  await insertCompletedRun(statsEndingRunId, "personalstats", weekStartAt, statsEndingAt, statsEndingAt)
  await insertCompletedRun(gymBaselineRunId, "gym_energy", weekStartAt, gymBaselineAt, gymBaselineAt)
  await insertCompletedRun(gymEndingRunId, "gym_energy", weekStartAt, gymEndingAt, gymEndingAt)

  await d1Query(
    `INSERT INTO faction_weekly_boundary_runs
      (faction_id, boundary_at, stats_run_id, gym_energy_run_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(faction_id, boundary_at) DO UPDATE SET
       stats_run_id = excluded.stats_run_id,
       gym_energy_run_id = excluded.gym_energy_run_id,
       created_at = excluded.created_at`,
    [FACTION_ID, weekStartAt, statsBaselineRunId, gymBaselineRunId, now],
  )

  const insertStatSql = `INSERT INTO faction_member_stat_snapshots
    (run_id, faction_id, user_id, captured_at, scheduled_at, response_variant, collection_status,
     ${METRIC_COLUMNS.join(", ")}, missing_metrics_json, torn_error_code)
    VALUES (${Array.from({ length: 7 + METRIC_COLUMNS.length + 2 }, () => "?").join(", ")})`
  const insertGymSql = `INSERT INTO faction_gym_energy_snapshots
    (run_id, faction_id, user_id, captured_at, gym_energy_total, in_faction, collection_status)
    VALUES (?, ?, ?, ?, ?, 1, 'complete')`

  for (let index = 0; index < MEMBER_IDS.length; index++) {
    const userId = MEMBER_IDS[index]
    const baseline = Object.fromEntries(METRIC_COLUMNS.map((column) => [
      column,
      column === "networth" ? 100000 + index * 1000 : 100 + index,
    ]))
    const ending = { ...baseline }
    ending.xantaken = baseline.xantaken + 5 + index
    ending.lsdtaken = baseline.lsdtaken + 9 + index
    ending.networth = baseline.networth - 100
    for (const column of METRIC_COLUMNS) {
      if (column !== "xantaken" && column !== "lsdtaken" && column !== "networth") ending[column] = baseline[column] + 2
    }

    for (const [runId, capturedAt, values] of [
      [statsBaselineRunId, statsBaselineAt, baseline],
      [statsEndingRunId, statsEndingAt, ending],
    ]) {
      await d1Query(insertStatSql, [
        runId, FACTION_ID, userId, capturedAt, weekStartAt, "popular", "complete",
        ...METRIC_COLUMNS.map((column) => values[column]), "[]", null,
      ])
    }

    await d1Query(insertGymSql, [gymBaselineRunId, FACTION_ID, userId, gymBaselineAt, 5000 + index * 100])
    await d1Query(insertGymSql, [gymEndingRunId, FACTION_ID, userId, gymEndingAt, 5025 + index * 100 + index])
  }

  return { weekStartAt, statsBaselineAt, statsEndingAt }
}

async function assertApiRoute(rosterRunId, weeklyFixture, departedUserId) {
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
    if (!payload.members.every((member) =>
      typeof member.lastActionStatus === "string" &&
      typeof member.lastActionTimestamp === "number" &&
      typeof member.reviveSetting === "string" &&
      typeof member.isRevivable === "boolean" &&
      typeof member.statusDescription === "string" &&
      typeof member.statusState === "string"
    )) {
      throw new Error("Faction performance API did not return the public last-action, status and both separate revive fields.")
    }
    if (payload.members.some((member) => member.reviveSetting === undefined || member.isRevivable === undefined)) {
      throw new Error("The target's configured revive setting and key-owner revivability must remain separate API fields.")
    }
    const fixtureMember = payload.members[0]
    if (fixtureMember.reviveSetting !== "Friends & faction" || fixtureMember.isRevivable !== false) {
      throw new Error("The configured revive setting must not be inferred from the owner-specific can-revive field.")
    }
    console.log("PASS authenticated faction performance API returned roster activity, status, and distinct member revive-setting / key-revivability values.")

    const weeklyResponse = await fetch(`${WORKER_URL}/api/faction/weekly-rankings?metric=xantaken`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const weekly = await weeklyResponse.json().catch(() => null)
    if (!weeklyResponse.ok || !weekly || !Array.isArray(weekly.members)) {
      throw new Error(`Faction weekly rankings API returned HTTP ${weeklyResponse.status}.`)
    }
    if (weekly.week?.startAt !== weeklyFixture.weekStartAt ||
        weekly.boundary?.statsStatus !== "completed" ||
        weekly.boundary?.gymEnergyStatus !== "completed") {
      throw new Error("Weekly rankings did not expose the synthetic Sunday boundary runs.")
    }
    const first = weekly.members.find((member) => member.userId === MEMBER_IDS[0])
    if (!first ||
        first.metrics.xantaken !== 5 ||
        first.metrics.lsdtaken !== 9 ||
        first.metrics.networth !== -100 ||
        first.startingNetworth !== 100000 ||
        first.endingNetworth !== 99900 ||
        first.gymEnergy !== 25 ||
        first.status !== "complete" ||
        first.rank !== MEMBER_IDS.length) {
      throw new Error("Weekly rankings did not calculate the expected independent counter, networth, gym-energy and rank results.")
    }
    if (first.baselineCapturedAt !== weeklyFixture.statsBaselineAt ||
        first.endingCapturedAt !== weeklyFixture.statsEndingAt ||
        weekly.boundary.statsCapturedAt !== weeklyFixture.statsBaselineAt) {
      throw new Error("Weekly rankings did not preserve the actual baseline and ending capture timestamps.")
    }
    if (weekly.members[0]?.userId !== MEMBER_IDS[MEMBER_IDS.length - 1]) {
      throw new Error("Weekly rankings are not ordered by the selected metric.")
    }
    const departedMember = weekly.members.find((member) => member.userId === departedUserId)
    if (!departedMember || departedMember.participation !== "partial_week" ||
        departedMember.rank !== null || departedMember.metrics.xantaken !== null) {
      throw new Error("A member who left during the reporting week was hidden or incorrectly ranked without a valid baseline.")
    }
    const gymRankResponse = await fetch(`${WORKER_URL}/api/faction/weekly-rankings?metric=gymEnergy`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const gymRankings = await gymRankResponse.json().catch(() => null)
    if (!gymRankResponse.ok || gymRankings?.selectedMetric !== "gymEnergy" ||
        gymRankings.members?.[0]?.userId !== MEMBER_IDS[MEMBER_IDS.length - 1]) {
      throw new Error("Gym-energy ranking did not sort independently by the synthetic contributor deltas.")
    }
    const firstGymMember = gymRankings.members.find((member) => member.userId === MEMBER_IDS[0])
    if (firstGymMember?.gymEnergy !== 25 || firstGymMember.rank !== MEMBER_IDS.length) {
      throw new Error("Gym-energy ranking did not preserve the expected member delta or rank.")
    }
    console.log("PASS authenticated weekly rankings API returned Sunday-boundary deltas, actual capture times, and independent personalstats and gym-energy rankings.")
  } finally {
    await d1Query("DELETE FROM players WHERE player_id = ?", [playerId])
  }
}

async function main() {
  await assertMigrationReady()
  const queueId = await findQueue()

  const departedUserId = String(991000000000000 + randomInt(1, 999999))
  const departedIntervalId = randomUUID()
  const seedTime = new Date().toISOString()
  await d1Query(
    `INSERT INTO faction_membership_intervals
      (interval_id, faction_id, user_id, member_name, position, level, days_in_faction,
       estimated_joined_at, first_seen_at, last_seen_at, left_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      departedIntervalId, FACTION_ID, departedUserId, "Integration Departed Member",
      "Member", 99, 12, seedTime, seedTime, seedTime,
    ],
  )

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
  const departedRows = await d1Query(
    "SELECT left_observed_at FROM faction_membership_intervals WHERE interval_id = ?",
    [departedIntervalId],
  )
  if (departedRows.length !== 1 || !departedRows[0].left_observed_at) {
    throw new Error("Roster collection did not close the membership interval for the departed fixture member.")
  }
  console.log(`PASS roster collection persisted ${MEMBER_IDS.length} members, added joins, and retained a departed member interval.`)

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

  const weeklyFixture = await seedWeeklyFixtures()
  await assertApiRoute(rosterRunId, weeklyFixture, departedUserId)

  const successfulStatsState = await d1Query(
    "SELECT last_success_at FROM faction_performance_collection_state WHERE faction_id = ? AND collection_kind = 'personalstats'",
    [FACTION_ID],
  )
  const lastSuccessfulStatsAt = successfulStatsState[0]?.last_success_at
  if (!lastSuccessfulStatsAt) throw new Error("The successful personalstats run did not record last_success_at.")

  const partialRunId = await createRun("personalstats", queueId, ["980000007"])
  const partialRun = await waitForRun(partialRunId, "Permanent per-member API failure")
  if (partialRun.status !== "partial") throw new Error("A permanent per-member API error must produce a partial run.")
  const partialSampleRows = await d1Query(
    "SELECT collection_status, xantaken, lsdtaken, missing_metrics_json, torn_error_code FROM faction_member_stat_snapshots WHERE run_id = ? AND user_id = ?",
    [partialRunId, "980000007"],
  )
  const partialSample = partialSampleRows[0]
  if (!partialSample || partialSample.collection_status !== "failed" ||
      partialSample.xantaken !== null || partialSample.lsdtaken !== null ||
      Number(partialSample.torn_error_code) !== 3) {
    throw new Error("Permanent member API errors must persist failed samples with unknown metrics, not zeroes.")
  }
  const afterPartialState = await d1Query(
    "SELECT last_success_at FROM faction_performance_collection_state WHERE faction_id = ? AND collection_kind = 'personalstats'",
    [FACTION_ID],
  )
  if (afterPartialState[0]?.last_success_at !== lastSuccessfulStatsAt) {
    throw new Error("A partial personalstats run incorrectly advanced last_success_at.")
  }
  console.log("PASS permanent member API errors stayed unknown and did not advance last_success_at.")

  const deadLetterRunId = await createRun("personalstats", queueId, ["980000008"])
  const deadLetterRun = await waitForFailedRun(deadLetterRunId, "Rate-limited personalstats")
  if (!String(deadLetterRun.last_error ?? "").includes("exhausted its queue retries")) {
    throw new Error("The dead-letter consumer did not persist the terminal retry-exhaustion state.")
  }
  const afterDeadLetterState = await d1Query(
    "SELECT last_success_at FROM faction_performance_collection_state WHERE faction_id = ? AND collection_kind = 'personalstats'",
    [FACTION_ID],
  )
  if (afterDeadLetterState[0]?.last_success_at !== lastSuccessfulStatsAt) {
    throw new Error("A dead-lettered personalstats run incorrectly advanced last_success_at.")
  }
  console.log("PASS transient Torn rate limits retried through Cloudflare Queues and terminated in the staging DLQ.")

  console.log("STAGING INTEGRATION PASSED. No production D1 or Worker was contacted.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Staging integration failed.")
  process.exitCode = 1
})
