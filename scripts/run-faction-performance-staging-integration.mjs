import { createHash, randomInt, randomUUID, webcrypto } from "node:crypto"

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
const PRIVATE_LIVE_OWNER_ID = "980000009"
const PRIVATE_LIVE_OTHER_ID = "980000010"
const PRIVATE_LIVE_API_KEY = "synthetic-private-live-staging-owner-key"
const PRIVATE_LIVE_ENCRYPTION_SECRET = "synthetic-private-live-staging-encryption-key-2026-11-03"
const PRIVATE_LIVE_ORIGIN = "https://naughty-company-dashboard.pages.dev"
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

async function publishFactionStats(runId, queueId) {
  await cloudflareRequest(
    `/accounts/${ACCOUNT_ID}/queues/${queueId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: { kind: "faction-stats-collection", runId }, content_type: "json" }),
    },
  )
}

async function publishWeeklyFinalize(weekStartAt, queueId) {
  await cloudflareRequest(
    `/accounts/${ACCOUNT_ID}/queues/${queueId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ body: { kind: "faction-weekly-finalize", weekStartAt }, content_type: "json" }),
    },
  )
}

async function waitForWeeklyReport(weekStartAt) {
  const deadline = Date.now() + 3 * 60 * 1000
  while (Date.now() < deadline) {
    const rows = await d1Query(
      "SELECT report_status FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at = ?",
      [FACTION_ID, weekStartAt],
    )
    if (rows.length === 1) return rows[0]
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error(`Weekly report finalization did not complete for ${weekStartAt}.`)
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

async function createFactionStatsRun(queueId) {
  const runId = randomUUID()
  const now = new Date().toISOString()
  await d1Query(
    "INSERT INTO faction_stats_collection_runs (run_id, collection_key, faction_id, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
    [runId, `integration:faction-stats:${runId}`, FACTION_ID, now, now, now],
  )
  await publishFactionStats(runId, queueId)
  return runId
}

async function waitForFactionStatsRun(runId) {
  const deadline = Date.now() + 3 * 60 * 1000
  while (Date.now() < deadline) {
    const rows = await d1Query(
      "SELECT status, last_error FROM faction_stats_collection_runs WHERE run_id = ?",
      [runId],
    )
    const row = rows[0]
    if (!row) throw new Error("Faction stats integration run disappeared from staging D1.")
    if (row.status === "completed") return row
    if (row.status === "failed") throw new Error(`Faction stats collection failed: ${row.last_error ?? "no error summary"}`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error("Faction stats collection did not complete within three minutes.")
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
    "SELECT name FROM d1_migrations WHERE name IN (?, ?, ?, ?)",
    ["0019_faction_performance_collection.sql", "0020_faction_weekly_boundaries.sql", "0021_faction_weekly_reports.sql", "0022_faction_stats_snapshots.sql"],
  )
  if (rows.length !== 4) {
    throw new Error("Staging D1 is missing a faction collection, weekly boundary, immutable report or faction stats migration (0019-0022). Run the staging migration workflow first.")
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
    "faction_weekly_reports",
    "faction_weekly_member_results",
    "faction_stats_collection_runs",
    "faction_stats_collection_state",
    "faction_stats_snapshots",
  ]
  const placeholders = expected.map(() => "?").join(", ")
  const tables = await d1Query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    expected,
  )
  const found = new Set(tables.map((row) => row.name))
  const missing = expected.filter((name) => !found.has(name))
  if (missing.length) throw new Error(`Staging D1 is missing tables: ${missing.join(", ")}`)
  const immutableTriggers = await d1Query(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?, ?)",
    ["faction_weekly_reports_no_update", "faction_weekly_reports_no_delete", "faction_weekly_member_results_no_update", "faction_weekly_member_results_no_delete"],
  )
  if (immutableTriggers.length !== 4) throw new Error("Staging D1 is missing the immutable weekly report protection triggers.")
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

async function seedClosedWeekFixtures(queueId) {
  // Retire only this harness's prior synthetic History Member intervals at
  // their original first-seen time. Their immutable reports remain intact,
  // while failed/retried runs cannot contaminate a later fixture cohort.
  await d1Query(
    "UPDATE faction_membership_intervals SET last_seen_at = first_seen_at, left_observed_at = first_seen_at WHERE faction_id = ? AND user_id LIKE '993%' AND member_name LIKE 'History Member %' AND first_seen_at IS NOT NULL",
    [FACTION_ID],
  )
  const memberIntervals = await d1Query(
    "SELECT first_seen_at, left_observed_at FROM faction_membership_intervals WHERE faction_id = ?",
    [FACTION_ID],
  )
  const currentWeekMs = Date.parse(sundayStartIso())
  // Staging D1 is persistent across retries. Keep the fixture idempotent by
  // searching a wider historical window for a three-boundary gap rather than
  // assuming the last 24 weeks remain unused after previous integration runs.
  const fixtureLookbackWeeks = 104
  const floorAt = new Date(currentWeekMs - fixtureLookbackWeeks * 7 * 24 * 60 * 60 * 1000).toISOString()
  const [usedBoundaries, usedReports] = await Promise.all([
    d1Query("SELECT boundary_at FROM faction_weekly_boundary_runs WHERE faction_id = ? AND boundary_at >= ?", [FACTION_ID, floorAt]),
    d1Query("SELECT week_start_at FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at >= ?", [FACTION_ID, floorAt]),
  ])
  const occupiedBoundaries = new Set(usedBoundaries.map((row) => row.boundary_at))
  const occupiedReports = new Set(usedReports.map((row) => row.week_start_at))
  let weekAStartMs = null
  let weekBStartMs = null
  for (let offset = 1; offset < fixtureLookbackWeeks; offset++) {
    const candidateB = currentWeekMs - offset * 7 * 24 * 60 * 60 * 1000
    const candidateA = candidateB - 7 * 24 * 60 * 60 * 1000
    const candidateC = candidateB + 7 * 24 * 60 * 60 * 1000
    const a = new Date(candidateA).toISOString()
    const b = new Date(candidateB).toISOString()
    const c = new Date(candidateC).toISOString()
    const candidateHasMembershipOverlap = memberIntervals.some((row) => {
      const firstSeenMs = Date.parse(row.first_seen_at)
      const leftAtMs = row.left_observed_at ? Date.parse(row.left_observed_at) : Number.POSITIVE_INFINITY
      return Number.isFinite(firstSeenMs) && firstSeenMs < candidateC && leftAtMs > candidateA
    })
    if (!candidateHasMembershipOverlap &&
        ![a, b, c].some((value) => occupiedBoundaries.has(value)) &&
        !occupiedReports.has(a) && !occupiedReports.has(b)) {
      weekAStartMs = candidateA
      weekBStartMs = candidateB
      break
    }
  }
  if (weekAStartMs === null || weekBStartMs === null) {
    throw new Error("No unused recent Sunday pair is available for immutable weekly-report staging fixtures.")
  }

  const weekAStart = new Date(weekAStartMs).toISOString()
  const weekBStart = new Date(weekBStartMs).toISOString()
  const weekCStart = new Date(weekBStartMs + 7 * 24 * 60 * 60 * 1000).toISOString()
  const ids = Array.from({ length: 4 }, () => String(993000000000000 + randomInt(1, 999999)))
  const leaverId = ids[3]
  const leaverLeftAt = new Date(weekAStartMs + 4 * 24 * 60 * 60 * 1000).toISOString()
  const now = new Date().toISOString()

  async function insertRun(runId, kind, scheduledAt, targetIds = []) {
    await d1Query(
      `INSERT INTO faction_performance_collection_runs
        (run_id, collection_key, faction_id, collection_kind, status, scheduled_at,
         target_user_ids_json, next_index, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId, `integration:closed-week:${kind}:${runId}`, FACTION_ID, kind, scheduledAt,
        kind === "personalstats" ? JSON.stringify(targetIds) : null,
        kind === "personalstats" ? targetIds.length : 0,
        scheduledAt, scheduledAt, now, now,
      ],
    )
  }

  async function createBoundary(boundaryAt, generation, targets) {
    const statsRunId = randomUUID()
    const gymRunId = randomUUID()
    await insertRun(statsRunId, "personalstats", boundaryAt, targets)
    await insertRun(gymRunId, "gym_energy", boundaryAt)
    await d1Query(
      "INSERT INTO faction_weekly_boundary_runs (faction_id, boundary_at, stats_run_id, gym_energy_run_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [FACTION_ID, boundaryAt, statsRunId, gymRunId, now],
    )
    return { statsRunId, gymRunId, generation, targets }
  }

  const boundaryA = await createBoundary(weekAStart, 0, ids)
  const boundaryB = await createBoundary(weekBStart, 1, ids.slice(0, 3))
  const boundaryC = await createBoundary(weekCStart, 2, ids.slice(0, 3))

  for (let index = 0; index < ids.length; index++) {
    const joinedAt = new Date(weekAStartMs - 14 * 24 * 60 * 60 * 1000).toISOString()
    const leftAt = index === 3 ? leaverLeftAt : null
    await d1Query(
      `INSERT INTO faction_membership_intervals
        (interval_id, faction_id, user_id, member_name, position, level, days_in_faction,
         estimated_joined_at, first_seen_at, last_seen_at, left_observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), FACTION_ID, ids[index], `History Member ${index + 1}`, "Member", 100 - index, 60, joinedAt, joinedAt, leftAt ?? now, leftAt],
    )
  }

  const insertStatSql = `INSERT INTO faction_member_stat_snapshots
    (run_id, faction_id, user_id, captured_at, scheduled_at, response_variant, collection_status,
     ${METRIC_COLUMNS.join(", ")}, missing_metrics_json, torn_error_code)
    VALUES (${Array.from({ length: 7 + METRIC_COLUMNS.length + 2 }, () => "?").join(", ")})`
  const insertGymSql = `INSERT INTO faction_gym_energy_snapshots
    (run_id, faction_id, user_id, captured_at, gym_energy_total, in_faction, collection_status)
    VALUES (?, ?, ?, ?, ?, 1, 'complete')`

  async function writeBoundary(boundary, boundaryMs) {
    for (const userId of boundary.targets) {
      const index = ids.indexOf(userId)
      const capturedAt = new Date(boundaryMs + 2 * 60 * 1000).toISOString()
      const gymCapturedAt = new Date(boundaryMs + 3 * 60 * 1000).toISOString()
      const xDelta = boundary.generation === 0 ? 0 : boundary.generation === 1 ? 10 + index : [30, 20, 15][index]
      const values = Object.fromEntries(METRIC_COLUMNS.map((column) => {
        if (column === "networth") return [column, 1000000 + index * 1000 - boundary.generation * 100]
        if (column === "xantaken") {
          return [column, 1000 + index + (boundary.generation === 2 ? 10 + index : 0) + xDelta]
        }
        if (column === "lsdtaken") return [column, 300 + index * 10 + boundary.generation * (3 + index)]
        return [column, 500 + index * 20 + boundary.generation * (10 + index)]
      }))
      const gymValue = 20000 + index * 100 + (boundary.generation === 0 ? 0 : boundary.generation === 1 ? 26 + index : 46 - index * 5)
      await d1Query(insertStatSql, [
        boundary.statsRunId, FACTION_ID, userId, capturedAt, new Date(boundaryMs).toISOString(),
        "popular", "complete", ...METRIC_COLUMNS.map((column) => values[column]), "[]", null,
      ])
      await d1Query(insertGymSql, [boundary.gymRunId, FACTION_ID, userId, gymCapturedAt, gymValue])
    }
  }

  await writeBoundary(boundaryA, weekAStartMs)
  await writeBoundary(boundaryB, weekBStartMs)
  await writeBoundary(boundaryC, weekBStartMs + 7 * 24 * 60 * 60 * 1000)

  // A member who left during week A has no ending-Sunday row. Finalization
  // must use their last in-faction sample and retain the partial-week result.
  const leaverStatsRunId = randomUUID()
  const leaverGymRunId = randomUUID()
  const leaverCapturedAt = new Date(weekAStartMs + 3 * 24 * 60 * 60 * 1000).toISOString()
  await insertRun(leaverStatsRunId, "personalstats", weekAStart, [leaverId])
  await insertRun(leaverGymRunId, "gym_energy", weekAStart)
  const leaverValues = Object.fromEntries(METRIC_COLUMNS.map((column) => {
    if (column === "networth") return [column, 1002900]
    if (column === "xantaken") return [column, 1012]
    if (column === "lsdtaken") return [column, 337]
    return [column, 570]
  }))
  await d1Query(insertStatSql, [
    leaverStatsRunId, FACTION_ID, leaverId, leaverCapturedAt, weekAStart,
    "popular", "complete", ...METRIC_COLUMNS.map((column) => leaverValues[column]), "[]", null,
  ])
  await d1Query(insertGymSql, [leaverGymRunId, FACTION_ID, leaverId, leaverCapturedAt, 20314])

  await publishWeeklyFinalize(weekAStart, queueId)
  await publishWeeklyFinalize(weekBStart, queueId)
  const [reportA, reportB] = await Promise.all([
    waitForWeeklyReport(weekAStart),
    waitForWeeklyReport(weekBStart),
  ])
  if (reportA.report_status !== "complete" || reportB.report_status !== "complete") {
    throw new Error("Closed-week reports should be complete when all required fixture captures are complete.")
  }

  const [headerA, headerB] = await Promise.all([
    d1Query("SELECT member_count, complete_member_count FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at = ?", [FACTION_ID, weekAStart]),
    d1Query("SELECT member_count, complete_member_count FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at = ?", [FACTION_ID, weekBStart]),
  ])
  if (Number(headerA[0]?.member_count) !== 4 || Number(headerA[0]?.complete_member_count) !== 4 ||
      Number(headerB[0]?.member_count) !== 3 || Number(headerB[0]?.complete_member_count) !== 3) {
    throw new Error("Closed-week reports did not preserve midweek leaver inclusion and correct interval membership.")
  }
  let immutableRejected = false
  try {
    await d1Query(
      "UPDATE faction_weekly_member_results SET member_name = ? WHERE faction_id = ? AND week_start_at = ? AND user_id = ?",
      ["Tampered", FACTION_ID, weekAStart, ids[0]],
    )
  } catch { immutableRejected = true }
  if (!immutableRejected) throw new Error("Finalized weekly member results were not protected against later updates.")
  console.log("PASS two closed Sunday reports were finalized transactionally, preserve a midweek leaver, and reject later mutation.")
  return { weekAStart, weekBStart, ids, leaverId }
}

async function assertApiRoute(rosterRunId, weeklyFixture, departedUserId, historyFixture, factionStatsRunId) {
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

    const factionStatsResponse = await fetch(`${WORKER_URL}/api/faction/stats`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const factionStats = await factionStatsResponse.json().catch(() => null)
    const aggregate = factionStats?.stats?.find((stat) => stat.name === "organisedcrimemoney")
    if (!factionStatsResponse.ok || !factionStats || factionStats.snapshot?.runId !== factionStatsRunId ||
        !Array.isArray(factionStats.stats) || aggregate?.value !== 123456789 ||
        !factionStats.missingStatNames.includes("caymaninterest") ||
        !factionStats.unexpectedStatNames.includes("membersamount") ||
        factionStats.collection?.lastRunId !== factionStatsRunId) {
      throw new Error(`Authenticated faction stats API returned HTTP ${factionStatsResponse.status} or omitted the aggregate snapshot, missing/unexpected-field metadata or collection state.`)
    }
    console.log("PASS authenticated faction stats API returned faction-wide totals, capture time and missing-stat metadata.")

    const activityResponse = await fetch(`${WORKER_URL}/api/faction/activity`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const activity = await activityResponse.json().catch(() => null)
    if (!activityResponse.ok || !activity || !Array.isArray(activity.events) ||
        !["compared", "waiting_for_previous_roster"].includes(activity.comparisonStatus) ||
        activity.latestRoster?.runId !== rosterRunId) {
      throw new Error(`Faction activity API returned HTTP ${activityResponse.status} or omitted its completed roster comparison.`)
    }
    const allowedActivityTypes = new Set([
      "member_added", "member_removed", "activity_changed", "status_changed",
      "wall_changed", "oc_changed", "early_discharge_changed", "revive_setting_changed", "position_changed",
    ])
    if (activity.events.some((event) =>
      !allowedActivityTypes.has(event.eventType) ||
      typeof event.userId !== "string" ||
      typeof event.memberName !== "string" ||
      typeof event.occurredAt !== "string" ||
      typeof event.detail !== "string"
    )) {
      throw new Error("Faction activity API returned an invalid or unsupported roster-change event.")
    }
    console.log("PASS authenticated faction activity API compared completed roster snapshots and returned only typed public membership/status/flag events.")

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

    const historyListResponse = await fetch(`${WORKER_URL}/api/faction/weekly-history`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const historyList = await historyListResponse.json().catch(() => null)
    const historyReportCountRows = await d1Query(
      "SELECT COUNT(*) AS count FROM faction_weekly_reports WHERE faction_id = ?",
      [FACTION_ID],
    )
    const historyReportCount = Number(historyReportCountRows[0]?.count ?? 0)
    const listedWeeks = Array.isArray(historyList?.reports)
      ? historyList.reports.map((report) => report.weekStartAt)
      : []
    const listingIsSortedAndCapped = listedWeeks.length <= 26 &&
      listedWeeks.every((week, index) => index === 0 || week <= listedWeeks[index - 1])
    const fixtureReportsShouldBeListed = historyReportCount <= 26
    if (!historyListResponse.ok || !Array.isArray(historyList?.reports) ||
        !listingIsSortedAndCapped ||
        (fixtureReportsShouldBeListed &&
          (!listedWeeks.includes(historyFixture.weekBStart) || !listedWeeks.includes(historyFixture.weekAStart)))) {
      throw new Error("Weekly history API did not return the newest 26 finalized reports in descending Sunday order.")
    }

    const comparisonResponse = await fetch(
      `${WORKER_URL}/api/faction/weekly-history?weekStart=${encodeURIComponent(historyFixture.weekBStart)}&compareTo=${encodeURIComponent(historyFixture.weekAStart)}&metric=xantaken`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) },
    )
    const comparison = await comparisonResponse.json().catch(() => null)
    const changedMember = comparison?.members?.find((member) => member.userId === historyFixture.ids[0])
    const previousWeekMember = comparison?.members?.find((member) => member.userId === historyFixture.ids[1])
    const archivedLeaver = comparison?.members?.find((member) => member.userId === historyFixture.leaverId)
    if (!comparisonResponse.ok || comparison?.report?.weekStartAt !== historyFixture.weekBStart ||
        comparison?.comparedReport?.weekStartAt !== historyFixture.weekAStart ||
        !changedMember || changedMember.metrics.xantaken !== 30 ||
        changedMember.comparison.previousValue !== 10 ||
        changedMember.comparison.weeklyChange !== 20 ||
        changedMember.rank !== 1 || changedMember.comparison.previousRank !== 3 ||
        changedMember.comparison.rankMovement !== 2 ||
        archivedLeaver) {
      throw new Error("Weekly history comparison did not preserve immutable weekly deltas, rank movement and membership exit boundaries.")
    }
    if (!previousWeekMember || previousWeekMember.metrics.networth !== -100 ||
        previousWeekMember.endingIsBoundary !== true) {
      throw new Error("Historical reports did not preserve negative networth movement and ending-boundary provenance.")
    }
    console.log("PASS weekly history API lists immutable reports and compares member deltas/rank movement across two completed Sundays.")
    const nonAdminDiagnostics = await fetch(WORKER_URL + "/api/admin/faction/weekly-boundaries?limit=3", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    if (nonAdminDiagnostics.status !== 403) {
      throw new Error("A regular faction member must not access administrator weekly-boundary diagnostics.")
    }
    await d1Query(
      "INSERT INTO administrators (player_id, granted_by, granted_at, revoked_by, revoked_at) VALUES (?, ?, ?, NULL, NULL)",
      [playerId, playerId, new Date().toISOString()],
    )
    const diagnosticsResponse = await fetch(WORKER_URL + "/api/admin/faction/weekly-boundaries?limit=3", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const diagnostics = await diagnosticsResponse.json().catch(() => null)
    const currentBoundary = diagnostics?.boundaries?.find((item) => item.boundaryAt === weeklyFixture.weekStartAt)
    if (!diagnosticsResponse.ok || !Array.isArray(diagnostics?.boundaries) || !currentBoundary ||
        currentBoundary.stats?.status !== "completed" || currentBoundary.gymEnergy?.status !== "completed") {
      throw new Error("Admin weekly boundary diagnostics returned HTTP " + diagnosticsResponse.status + " or omitted the completed Sunday baseline.")
    }
    const recoveryRunId = String(currentBoundary.stats.runId)
    const failureAt = new Date().toISOString()
    await d1Query(
      "UPDATE faction_performance_collection_runs SET status = 'failed', completed_at = ?, last_error = ?, updated_at = ? WHERE run_id = ? AND status = 'completed'",
      [failureAt, "Synthetic admin-recovery fixture", failureAt, recoveryRunId],
    )
    const recoveryDiagnosticsResponse = await fetch(WORKER_URL + "/api/admin/faction/weekly-boundaries?limit=3", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    })
    const recoveryDiagnostics = await recoveryDiagnosticsResponse.json().catch(() => null)
    const recoverableBoundary = recoveryDiagnostics?.boundaries?.find((item) => item.boundaryAt === weeklyFixture.weekStartAt)
    if (!recoveryDiagnosticsResponse.ok || !recoverableBoundary?.recoverable ||
        !recoverableBoundary.recoveryCollections.includes("personalstats")) {
      throw new Error("Admin weekly boundary diagnostics did not flag the synthetic failed stats run as safely recoverable.")
    }
    const recoveryResponse = await fetch(WORKER_URL + "/api/admin/faction/weekly-boundaries/recover", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ boundaryAt: weeklyFixture.weekStartAt, collections: ["personalstats"] }),
      signal: AbortSignal.timeout(30000),
    })
    const recovery = await recoveryResponse.json().catch(() => null)
    if (!recoveryResponse.ok || !recovery.queued?.some((item) => item.collection === "personalstats" && item.runId === recoveryRunId)) {
      throw new Error("Admin weekly boundary recovery returned HTTP " + recoveryResponse.status + " or did not requeue the failed frozen-cohort stats run.")
    }
    const recoveryDeadline = Date.now() + 180000
    let recoveredRun = null
    while (Date.now() < recoveryDeadline) {
      const rows = await d1Query(
        "SELECT status, last_error FROM faction_performance_collection_runs WHERE run_id = ?",
        [recoveryRunId],
      )
      recoveredRun = rows[0] ?? null
      if (recoveredRun?.status === "completed" || recoveredRun?.status === "partial" || recoveredRun?.status === "failed") break
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    if (recoveredRun?.status !== "completed") {
      throw new Error("Recovered Sunday stats run ended as " + (recoveredRun?.status ?? "missing") + " instead of completed.")
    }
    const recoveryAudit = await d1Query(
      "SELECT action, outcome, target_id FROM admin_audit_log WHERE actor_player_id = ? AND action = ? AND target_id = ? ORDER BY id DESC LIMIT 1",
      [playerId, "faction.weekly_boundary.recovered", weeklyFixture.weekStartAt],
    )
    if (recoveryAudit.length !== 1 || recoveryAudit[0].outcome !== "succeeded") {
      throw new Error("The Sunday recovery action was not written to the administrative audit log.")
    }
    const lockedRecoveryResponse = await fetch(WORKER_URL + "/api/admin/faction/weekly-boundaries/recover", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ boundaryAt: historyFixture.weekAStart, collections: ["personalstats"] }),
      signal: AbortSignal.timeout(30000),
    })
    if (lockedRecoveryResponse.status !== 409) {
      throw new Error("Admin recovery should reject the finalized historical report boundary (HTTP " + lockedRecoveryResponse.status + ").")
    }
    console.log("PASS admin weekly boundary diagnostics identify failed captures, retry a frozen Sunday run through Queues, audit the action, and refuse to rewrite finalized reports.")
  } finally {
    await d1Query("DELETE FROM players WHERE player_id = ?", [playerId])
  }
}

async function assertPrivateLiveRoutes() {
  const now = new Date().toISOString()
  const expiresAt = Math.floor(Date.now() / 1000) + 3600
  const tokenFor = (playerId) => `synthetic-private-live-session-${playerId}-${randomUUID()}`
  const ownerToken = tokenFor(PRIVATE_LIVE_OWNER_ID)
  const otherToken = tokenFor(PRIVATE_LIVE_OTHER_ID)
  const ownerTokenHash = createHash("sha256").update(ownerToken).digest("hex")
  const otherTokenHash = createHash("sha256").update(otherToken).digest("hex")
  const testIds = [PRIVATE_LIVE_OWNER_ID, PRIVATE_LIVE_OTHER_ID]

  const call = async (playerToken, pathname, method, body) => {
    const response = await fetch(`${WORKER_URL}${pathname}`, {
      method,
      headers: {
        Origin: PRIVATE_LIVE_ORIGIN,
        Authorization: `Bearer ${playerToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    })
    const payload = await response.json().catch(() => null)
    return { response, payload }
  }

  try {
    for (const playerId of testIds) {
      await d1Query(
        "INSERT INTO players (player_id, player_name, created_at, updated_at, faction_id, faction_verified_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, faction_id = excluded.faction_id, faction_verified_at = excluded.faction_verified_at, updated_at = excluded.updated_at",
        [playerId, `Private Live Integration ${playerId}`, now, now, FACTION_ID, now],
      )
    }
    // The private-live connect endpoint reuses the member's canonical portal
    // key from api_keys. Seed owner-scoped encrypted keys for both synthetic
    // sessions so the next request reaches the consent gate (400) and the
    // wrong-owner validation gate (403), rather than the missing-key guard (409).
    const primaryKeyDigest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(PRIVATE_LIVE_ENCRYPTION_SECRET),
    )
    const primaryEncryptionKey = await webcrypto.subtle.importKey(
      "raw", primaryKeyDigest, { name: "AES-GCM" }, false, ["encrypt"],
    )
    for (const playerId of testIds) {
      const iv = webcrypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        primaryEncryptionKey,
        new TextEncoder().encode(PRIVATE_LIVE_API_KEY),
      )
      await d1Query(
        "INSERT INTO api_keys (player_id, ciphertext, iv, last_four, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, updated_at = excluded.updated_at",
        [playerId, Buffer.from(ciphertext).toString("base64"), Buffer.from(iv).toString("base64"), PRIVATE_LIVE_API_KEY.slice(-4), now, now],
      )
    }
    await d1Query(
      "INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at",
      [ownerTokenHash, PRIVATE_LIVE_OWNER_ID, expiresAt, now],
    )
    await d1Query(
      "INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at",
      [otherTokenHash, PRIVATE_LIVE_OTHER_ID, expiresAt, now],
    )

    const consentRequired = await call(ownerToken, "/api/me/private-live/key", "POST", {
      apiKey: PRIVATE_LIVE_API_KEY, shareWithFaction: true, consentVersion: "faction-private-live-v1",
    })
    if (consentRequired.response.status !== 400) {
      throw new Error("Private live route accepted a connection without explicit data-sharing consent.")
    }
    console.log("PASS staging private-live endpoint rejects missing consent before Torn selection calls.")

    const wrongOwner = await call(otherToken, "/api/me/private-live/key", "POST", {
      apiKey: PRIVATE_LIVE_API_KEY, consent: true, shareWithFaction: true,
      consentVersion: "faction-private-live-v1", includeNetworth: false,
    })
    if (wrongOwner.response.status !== 403) {
      throw new Error("Private live staging route accepted a Torn key belonging to a different member.")
    }
    const wrongOwnerRows = await d1Query(
      "SELECT player_id FROM member_private_live_keys WHERE player_id = ? UNION ALL SELECT player_id FROM faction_member_private_live_snapshots WHERE player_id = ?",
      [PRIVATE_LIVE_OTHER_ID, PRIVATE_LIVE_OTHER_ID],
    )
    if (wrongOwnerRows.length) throw new Error("A wrong-owner staging key created private credential or snapshot rows.")
    console.log("PASS staging private-live endpoint rejects an owner-mismatched Torn key.")

    const connected = await call(ownerToken, "/api/me/private-live/key", "POST", {
      apiKey: PRIVATE_LIVE_API_KEY, consent: true, shareWithFaction: true,
      consentVersion: "faction-private-live-v1", includeNetworth: false,
    })
    if (connected.response.status !== 200 || connected.payload?.connected !== true || connected.payload?.includeNetworth !== false) {
      throw new Error("Private live staging connection did not persist the owner bars/cooldowns selection.")
    }
    const keyRows = await d1Query(
      "SELECT ciphertext, iv, last_four, include_networth, consent_version FROM member_private_live_keys WHERE player_id = ?",
      [PRIVATE_LIVE_OWNER_ID],
    )
    const keyRow = keyRows[0]
    if (!keyRow || keyRow.last_four !== PRIVATE_LIVE_API_KEY.slice(-4) || Number(keyRow.include_networth) !== 0 ||
        keyRow.consent_version !== "faction-private-live-v1" || keyRow.ciphertext === PRIVATE_LIVE_API_KEY) {
      throw new Error("Private live staging did not store a separate encrypted owner credential.")
    }
    const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(PRIVATE_LIVE_ENCRYPTION_SECRET))
    const aesKey = await webcrypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"])
    const plaintext = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: Uint8Array.from(Buffer.from(String(keyRow.iv), "base64")) },
      aesKey,
      Uint8Array.from(Buffer.from(String(keyRow.ciphertext), "base64")),
    )
    if (new TextDecoder().decode(plaintext) !== PRIVATE_LIVE_API_KEY) {
      throw new Error("Private live staging credential could not be decrypted using the integration-only Worker secret.")
    }

    const snapshots = await d1Query(
      "SELECT bars_json, cooldowns_json, networth_json FROM faction_member_private_live_snapshots WHERE player_id = ?",
      [PRIVATE_LIVE_OWNER_ID],
    )
    const snapshot = snapshots[0]
    if (!snapshot || JSON.parse(snapshot.bars_json).energy.current !== 91 ||
        JSON.parse(snapshot.cooldowns_json).drug !== 120 || snapshot.networth_json !== null) {
      throw new Error("Staging private live snapshot did not store only allowed bars/cooldowns or requested networth unexpectedly.")
    }

    const status = await call(ownerToken, "/api/me/private-live/key", "GET")
    if (status.response.status !== 200 || status.payload?.connected !== true ||
        status.payload?.snapshot?.bars?.energy?.current !== 91 || status.payload?.snapshot?.networth !== null) {
      throw new Error("Authenticated staging private live status did not return the member's own saved snapshot.")
    }

    const immediateRefresh = await call(ownerToken, "/api/me/private-live/refresh", "POST", {})
    if (immediateRefresh.response.status !== 429) {
      throw new Error("Staging private-live connect and refresh did not share the 30-second request budget.")
    }
    await d1Query(
      "UPDATE member_private_live_api_throttles SET last_attempt_at = ? WHERE player_id = ?",
      [new Date(Date.now() - 31000).toISOString(), PRIVATE_LIVE_OWNER_ID],
    )
    const refreshed = await call(ownerToken, "/api/me/private-live/refresh", "POST", {})
    if (refreshed.response.status !== 200 || refreshed.payload?.refreshed !== true) {
      throw new Error("Staging private-live owner refresh did not complete through the Torn Service Binding.")
    }
    console.log("PASS staging private-live connection, encrypted credential persistence, status read, refresh, and shared request throttling.")

    await d1Query(
      "UPDATE member_private_live_api_throttles SET last_attempt_at = ? WHERE player_id = ?",
      [new Date(Date.now() - 31000).toISOString(), PRIVATE_LIVE_OWNER_ID],
    )
    const networthOptIn = await call(ownerToken, "/api/me/private-live/key", "POST", {
      apiKey: PRIVATE_LIVE_API_KEY, consent: true, shareWithFaction: true,
      consentVersion: "faction-private-live-v1", includeNetworth: true,
    })
    if (networthOptIn.response.status !== 200 || networthOptIn.payload?.includeNetworth !== true) {
      throw new Error("Staging private live optional networth consent did not enable the owner selection.")
    }
    const networthRows = await d1Query(
      "SELECT networth_json, source_timestamps_json FROM faction_member_private_live_snapshots WHERE player_id = ?",
      [PRIVATE_LIVE_OWNER_ID],
    )
    if (!networthRows[0]?.networth_json || JSON.parse(networthRows[0].networth_json).total !== 987654321 ||
        JSON.parse(networthRows[0].source_timestamps_json).networthSourceTimestamp !== 1793671200) {
      throw new Error("Staging detailed networth was not stored with its Torn source timestamp after explicit opt-in.")
    }
    console.log("PASS staging private-live detailed networth is fetched and shared only after explicit opt-in.")

    const disconnected = await call(ownerToken, "/api/me/private-live/key", "DELETE")
    if (disconnected.response.status !== 200) throw new Error("Staging private-live disconnect endpoint failed.")
    const remaining = await d1Query(
      "SELECT (SELECT COUNT(*) FROM member_private_live_keys WHERE player_id = ?) AS keys, (SELECT COUNT(*) FROM faction_member_private_live_snapshots WHERE player_id = ?) AS snapshots",
      [PRIVATE_LIVE_OWNER_ID, PRIVATE_LIVE_OWNER_ID],
    )
    if (Number(remaining[0]?.keys) !== 0 || Number(remaining[0]?.snapshots) !== 0) {
      throw new Error("Staging private-live disconnect did not delete the encrypted key and current faction snapshot.")
    }
    console.log("PASS staging private-live disconnect removed the encrypted key and current faction snapshot.")
  } finally {
    for (const playerId of testIds) {
      await d1Query("DELETE FROM faction_member_private_live_snapshots WHERE player_id = ?", [playerId]).catch(() => undefined)
      await d1Query("DELETE FROM member_private_live_keys WHERE player_id = ?", [playerId]).catch(() => undefined)
      await d1Query("DELETE FROM member_private_live_api_throttles WHERE player_id = ?", [playerId]).catch(() => undefined)
      await d1Query("DELETE FROM sessions WHERE player_id = ?", [playerId]).catch(() => undefined)
      await d1Query("DELETE FROM players WHERE player_id = ?", [playerId]).catch(() => undefined)
    }
  }
}

async function main() {
  await assertMigrationReady()
  const queueId = await findQueue()
  await assertPrivateLiveRoutes()

  const factionStatsRunId = await createFactionStatsRun(queueId)
  const factionStatsRun = await waitForFactionStatsRun(factionStatsRunId)
  if (factionStatsRun.status !== "completed") throw new Error("The fixture faction stats collection did not complete.")
  const factionStatsRows = await d1Query(
    "SELECT stats_json, missing_stat_names_json, unexpected_stat_names_json, returned_stat_count, collection_status FROM faction_stats_snapshots WHERE run_id = ?",
    [factionStatsRunId],
  )
  const savedFactionStats = factionStatsRows[0]
  const savedStats = JSON.parse(savedFactionStats?.stats_json ?? "[]")
  const savedMissingStats = JSON.parse(savedFactionStats?.missing_stat_names_json ?? "[]")
  const savedUnexpectedStats = JSON.parse(savedFactionStats?.unexpected_stat_names_json ?? "[]")
  if (!savedFactionStats || savedFactionStats.collection_status !== "complete" ||
      Number(savedFactionStats.returned_stat_count) !== 4 ||
      savedStats.find((stat) => stat.name === "organisedcrimemoney")?.value !== 123456789 ||
      !savedMissingStats.includes("caymaninterest") ||
      !savedUnexpectedStats.includes("membersamount")) {
    throw new Error("Faction-wide stats were not durably persisted with recognized typed values, missing fields, and unexpected-field metadata.")
  }
  const factionStatsState = await d1Query(
    "SELECT last_success_at, last_run_id FROM faction_stats_collection_state WHERE faction_id = ?",
    [FACTION_ID],
  )
  if (!factionStatsState[0]?.last_success_at || factionStatsState[0].last_run_id !== factionStatsRunId) {
    throw new Error("Faction stats collection state did not advance after the complete capture.")
  }
  console.log("PASS faction-wide /faction/stats collection persisted a timestamped aggregate snapshot and missing-field metadata.")

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
  const historyFixture = await seedClosedWeekFixtures(queueId)
  await assertApiRoute(rosterRunId, weeklyFixture, departedUserId, historyFixture, factionStatsRunId)

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
