import { TornApiClient, TornApiClientError } from "../lib/torn/client"
import {
  countCompletePublicMetrics,
  parseFactionGymEnergyResponse,
  parseFactionPublicStatsResponse,
  parseFactionRosterResponse,
  type FactionGymEnergyContributor,
  type FactionRosterMember,
} from "../lib/faction-performance/collector"
import { PERSONAL_STATS_HISTORICAL_NAMES } from "../lib/torn/personalstats"

type D1Result<T = Record<string, unknown>> = {
  results?: T[]
  meta?: { changes?: number }
}
type D1Statement = {
  bind(...values: (string | number | null)[]): D1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}
type D1Database = { prepare(sql: string): D1Statement }
type QueueProducer = { send(message: unknown): Promise<unknown> }

export type FactionPerformanceEnv = {
  DB?: D1Database
  GLOBAL_RANKINGS_QUEUE?: QueueProducer
  TORN_FACTION_API_KEY?: string
}

type CollectionKind = "roster" | "personalstats" | "gym_energy"
type CollectionRun = {
  runId: string
  factionId: string
  collectionKind: CollectionKind
  status: string
  scheduledAt: string
  targetUserIdsJson: string | null
  nextIndex: number
}

const FACTION_ID = "8317"
const PUBLIC_STATS_BATCH_SIZE = 5
const DAY_SECONDS = 86400

function requireDb(env: FactionPerformanceEnv): D1Database {
  if (!env.DB) throw new Error("Faction performance D1 storage is not configured.")
  return env.DB
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function validTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("A valid scheduled timestamp is required.")
  return new Date(ms).toISOString()
}

function safeJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.map((id) => String(id)).filter((id) => /^[1-9]\d*$/.test(id))
      : []
  } catch {
    return []
  }
}

function collectionKey(kind: CollectionKind, scheduledAtMs: number, intervalMs: number): string {
  const bucket = Math.floor(scheduledAtMs / intervalMs) * intervalMs
  return `${FACTION_ID}:${kind}:${new Date(bucket).toISOString()}`
}

function currentMetricValues(stats: ReturnType<typeof parseFactionPublicStatsResponse>): (number | null)[] {
  return PERSONAL_STATS_HISTORICAL_NAMES.map((name) => stats[name])
}

async function insertPublicStatsSnapshot(
  db: D1Database,
  args: {
    runId: string
    userId: string
    scheduledAt: string
    capturedAt: string
    stats: ReturnType<typeof parseFactionPublicStatsResponse> | null
    tornErrorCode?: number | null
  },
): Promise<void> {
  const stats = args.stats
  const values = stats ? currentMetricValues(stats) : PERSONAL_STATS_HISTORICAL_NAMES.map(() => null)
  const missing = stats?.missingMetrics ?? [...PERSONAL_STATS_HISTORICAL_NAMES]
  const collectionStatus = !stats ? "failed" : missing.length > 0 ? "partial" : "complete"
  const placeholders = Array.from({ length: 27 }, () => "?").join(", ")
  const updateColumns = [
    "faction_id = excluded.faction_id",
    "captured_at = excluded.captured_at",
    "scheduled_at = excluded.scheduled_at",
    "response_variant = excluded.response_variant",
    "collection_status = excluded.collection_status",
    ...PERSONAL_STATS_HISTORICAL_NAMES.map((name) => `${name} = excluded.${name}`),
    "missing_metrics_json = excluded.missing_metrics_json",
    "torn_error_code = excluded.torn_error_code",
  ].join(", ")
  await db.prepare(
    `INSERT INTO faction_member_stat_snapshots (run_id, faction_id, user_id, captured_at, scheduled_at, response_variant, collection_status, ${PERSONAL_STATS_HISTORICAL_NAMES.join(", ")}, missing_metrics_json, torn_error_code) VALUES (${placeholders}) ON CONFLICT(run_id, user_id) DO UPDATE SET ${updateColumns}`,
  ).bind(
    args.runId,
    FACTION_ID,
    args.userId,
    args.capturedAt,
    args.scheduledAt,
    "popular",
    collectionStatus,
    ...values,
    json(missing),
    args.tornErrorCode ?? null,
  ).run()
}

async function markCollectionFailed(
  env: FactionPerformanceEnv,
  runId: string,
  message: string,
): Promise<void> {
  const db = requireDb(env)
  const now = new Date().toISOString()
  const safeMessage = message.slice(0, 300)
  const row = await db.prepare(
    "SELECT faction_id AS factionId, collection_kind AS collectionKind FROM faction_performance_collection_runs WHERE run_id = ?",
  ).bind(runId).first<{ factionId: string; collectionKind: CollectionKind }>()
  await db.prepare(
    "UPDATE faction_performance_collection_runs SET status = 'failed', last_error = ?, completed_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
  ).bind(safeMessage, now, now, runId).run()
  if (row) {
    await db.prepare(
      "INSERT INTO faction_performance_collection_state (faction_id, collection_kind, last_run_id, last_error, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(faction_id, collection_kind) DO UPDATE SET last_run_id = excluded.last_run_id, last_error = excluded.last_error, updated_at = excluded.updated_at",
    ).bind(row.factionId, row.collectionKind, runId, safeMessage, now).run()
  }
}

async function createCollectionRun(
  env: FactionPerformanceEnv,
  kind: CollectionKind,
  scheduledAtMs: number,
  targetUserIds: string[] | null = null,
): Promise<string | null> {
  const db = requireDb(env)
  const scheduledAt = validTimestamp(scheduledAtMs)
  const intervalMs = kind === "roster" ? 5 * 60 * 1000 : 15 * 60 * 1000
  const key = collectionKey(kind, scheduledAtMs, intervalMs)
  const active = await db.prepare(
    "SELECT run_id AS runId FROM faction_performance_collection_runs WHERE faction_id = ? AND collection_kind = ? AND status IN ('queued', 'running') LIMIT 1",
  ).bind(FACTION_ID, kind).first<{ runId: string }>()
  if (active) return null

  const runId = crypto.randomUUID()
  const now = new Date().toISOString()
  const result = await db.prepare(
    "INSERT OR IGNORE INTO faction_performance_collection_runs (run_id, collection_key, faction_id, collection_kind, status, scheduled_at, target_user_ids_json, next_index, last_enqueued_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?)",
  ).bind(runId, key, FACTION_ID, kind, scheduledAt, targetUserIds ? json(targetUserIds) : null, now, now, now).run()
  if (Number(result.meta?.changes ?? 0) < 1) return null
  return runId
}

async function enqueueCollection(
  env: FactionPerformanceEnv,
  kind: CollectionKind,
  scheduledAtMs: number,
  targetUserIds: string[] | null = null,
): Promise<boolean> {
  const queue = env.GLOBAL_RANKINGS_QUEUE
  if (!queue) return false
  const runId = await createCollectionRun(env, kind, scheduledAtMs, targetUserIds)
  if (!runId) return false
  const now = new Date().toISOString()
  try {
    await queue.send({ kind: "faction-performance-collection", runId, index: 0 })
    await requireDb(env).prepare(
      "UPDATE faction_performance_collection_runs SET last_enqueued_at = ?, updated_at = ? WHERE run_id = ?",
    ).bind(now, now, runId).run()
    return true
  } catch {
    await markCollectionFailed(env, runId, "Could not enqueue faction performance collection.")
    return false
  }
}

/**
 * Called from the existing five-minute cron. The Worker secret is deliberately
 * separate from every member's login key. Missing configuration safely idles.
 */
export async function enqueueFactionPerformanceCollections(
  env: FactionPerformanceEnv,
  scheduledTime: number,
): Promise<{ roster: boolean; personalstats: boolean; gymEnergy: boolean }> {
  if (!env.DB || !env.GLOBAL_RANKINGS_QUEUE || !env.TORN_FACTION_API_KEY?.trim()) {
    return { roster: false, personalstats: false, gymEnergy: false }
  }
  const db = requireDb(env)
  const date = new Date(scheduledTime)
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid faction performance schedule timestamp.")
  const minute = date.getUTCMinutes()
  const roster = await enqueueCollection(env, "roster", scheduledTime)

  if (minute % 15 !== 0) return { roster, personalstats: false, gymEnergy: false }

  const activeRows = await db.prepare(
    "SELECT user_id AS userId FROM faction_membership_intervals WHERE faction_id = ? AND left_at IS NULL ORDER BY user_id",
  ).bind(FACTION_ID).all<{ userId: string }>()
  const targetUserIds = (activeRows.results ?? []).map((row) => String(row.userId)).filter((id) => /^[1-9]\d*$/.test(id))
  const personalstats = targetUserIds.length > 0
    ? await enqueueCollection(env, "personalstats", scheduledTime, targetUserIds)
    : false
  const gymEnergy = await enqueueCollection(env, "gym_energy", scheduledTime)
  return { roster, personalstats, gymEnergy }
}

async function readCollectionRun(db: D1Database, runId: string): Promise<CollectionRun | null> {
  return db.prepare(
    "SELECT run_id AS runId, faction_id AS factionId, collection_kind AS collectionKind, status, scheduled_at AS scheduledAt, target_user_ids_json AS targetUserIdsJson, next_index AS nextIndex FROM faction_performance_collection_runs WHERE run_id = ?",
  ).bind(runId).first<CollectionRun>()
}

async function finishCollectionRun(
  db: D1Database,
  run: CollectionRun,
  status: "completed" | "partial",
  lastError: string | null = null,
): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare(
    "UPDATE faction_performance_collection_runs SET status = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE run_id = ?",
  ).bind(status, lastError, now, now, run.runId).run()
  if (status === "completed") {
    await db.prepare(
      "INSERT INTO faction_performance_collection_state (faction_id, collection_kind, last_success_at, last_run_id, last_error, updated_at) VALUES (?, ?, ?, ?, NULL, ?) ON CONFLICT(faction_id, collection_kind) DO UPDATE SET last_success_at = excluded.last_success_at, last_run_id = excluded.last_run_id, last_error = NULL, updated_at = excluded.updated_at",
    ).bind(run.factionId, run.collectionKind, now, run.runId, now).run()
  } else {
    await db.prepare(
      "INSERT INTO faction_performance_collection_state (faction_id, collection_kind, last_run_id, last_error, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(faction_id, collection_kind) DO UPDATE SET last_run_id = excluded.last_run_id, last_error = excluded.last_error, updated_at = excluded.updated_at",
    ).bind(run.factionId, run.collectionKind, run.runId, lastError ?? "Collection completed with incomplete member data.", now).run()
  }
}

async function insertRosterSnapshots(
  db: D1Database,
  run: CollectionRun,
  members: FactionRosterMember[],
  capturedAt: string,
): Promise<void> {
  const active = await db.prepare(
    "SELECT user_id AS userId FROM faction_membership_intervals WHERE faction_id = ? AND left_at IS NULL",
  ).bind(run.factionId).all<{ userId: string }>()
  const currentIds = new Set(members.map((member) => member.userId))
  for (const previous of active.results ?? []) {
    const previousId = String(previous.userId)
    if (!currentIds.has(previousId)) {
      await db.prepare(
        "UPDATE faction_membership_intervals SET left_at = ? WHERE faction_id = ? AND user_id = ? AND left_at IS NULL",
      ).bind(capturedAt, run.factionId, previousId).run()
    }
  }

  await db.prepare(
    "INSERT OR IGNORE INTO faction_roster_snapshots (run_id, faction_id, captured_at, scheduled_at, member_count) VALUES (?, ?, ?, ?, ?)",
  ).bind(run.runId, run.factionId, capturedAt, run.scheduledAt, members.length).run()

  for (const member of members) {
    const days = member.daysInFaction !== null && member.daysInFaction >= 0 ? member.daysInFaction : null
    // Torn supplies whole-day membership age, not a precise join timestamp.
    // Keep the estimate, while first_seen_at remains our authoritative observation.
    const estimatedJoinAt = days === null
      ? capturedAt
      : new Date(Date.parse(capturedAt) - Math.floor(days) * DAY_SECONDS * 1000).toISOString()
    const intervalId = crypto.randomUUID()
    await db.prepare(
      "INSERT OR IGNORE INTO faction_membership_intervals (interval_id, faction_id, user_id, member_name, position, level, days_in_faction, joined_at, left_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    ).bind(intervalId, run.factionId, member.userId, member.name, member.position, member.level, days, estimatedJoinAt, capturedAt, capturedAt).run()
    await db.prepare(
      "UPDATE faction_membership_intervals SET member_name = ?, position = ?, level = ?, days_in_faction = ?, last_seen_at = ? WHERE faction_id = ? AND user_id = ? AND left_at IS NULL",
    ).bind(member.name, member.position, member.level, days, capturedAt, run.factionId, member.userId).run()

    await db.prepare(
      "INSERT OR IGNORE INTO faction_member_roster_snapshots (run_id, faction_id, user_id, captured_at, name, position, level, days_in_faction, last_action_status, last_action_timestamp, last_action_relative, status_description, status_details, status_state, status_until, status_color, is_revivable, revive_setting, is_on_wall, is_in_oc, has_early_discharge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      run.runId, run.factionId, member.userId, capturedAt, member.name, member.position, member.level,
      member.daysInFaction, member.lastActionStatus, member.lastActionTimestamp, member.lastActionRelative,
      member.statusDescription, member.statusDetails, member.statusState, member.statusUntil, member.statusColor,
      member.isRevivable === null ? null : Number(member.isRevivable), member.reviveSetting,
      member.isOnWall === null ? null : Number(member.isOnWall),
      member.isInOc === null ? null : Number(member.isInOc),
      member.hasEarlyDischarge === null ? null : Number(member.hasEarlyDischarge),
    ).run()
  }
}

async function collectRoster(env: FactionPerformanceEnv, run: CollectionRun): Promise<void> {
  const apiKey = env.TORN_FACTION_API_KEY?.trim()
  if (!apiKey) throw new Error("TORN_FACTION_API_KEY is not configured.")
  const client = new TornApiClient({ apiKey })
  const payload = await client.getFactionMembersForRoster()
  const members = parseFactionRosterResponse(payload)
  const capturedAt = new Date().toISOString()
  await insertRosterSnapshots(requireDb(env), run, members, capturedAt)
  await finishCollectionRun(requireDb(env), run, "completed")
}

async function collectGymEnergy(env: FactionPerformanceEnv, run: CollectionRun): Promise<void> {
  const apiKey = env.TORN_FACTION_API_KEY?.trim()
  if (!apiKey) throw new Error("TORN_FACTION_API_KEY is not configured.")
  const client = new TornApiClient({ apiKey })
  const payload = await client.getFactionGymEnergyContributors()
  const contributors: FactionGymEnergyContributor[] = parseFactionGymEnergyResponse(payload)
  const db = requireDb(env)
  const capturedAt = new Date().toISOString()
  for (const contributor of contributors) {
    await db.prepare(
      "INSERT INTO faction_gym_energy_snapshots (run_id, faction_id, user_id, captured_at, gym_energy_total, in_faction, collection_status) VALUES (?, ?, ?, ?, ?, ?, 'complete') ON CONFLICT(run_id, user_id) DO UPDATE SET captured_at = excluded.captured_at, gym_energy_total = excluded.gym_energy_total, in_faction = excluded.in_faction, collection_status = excluded.collection_status",
    ).bind(run.runId, run.factionId, contributor.userId, capturedAt, contributor.value,
      contributor.inFaction === null ? null : Number(contributor.inFaction)).run()
  }
  await finishCollectionRun(db, run, "completed")
}

async function collectPublicStatsBatch(
  env: FactionPerformanceEnv,
  run: CollectionRun,
  index: number,
  userIds: string[],
): Promise<void> {
  const db = requireDb(env)
  const apiKey = env.TORN_FACTION_API_KEY?.trim()
  if (!apiKey) throw new Error("TORN_FACTION_API_KEY is not configured.")
  const client = new TornApiClient({ apiKey })
  const scheduledAt = run.scheduledAt
  const end = Math.min(index + PUBLIC_STATS_BATCH_SIZE, userIds.length)

  for (let cursor = index; cursor < end; cursor += 1) {
    const userId = userIds[cursor]
    try {
      const payload = await client.getUserPersonalStatsFor(userId, { kind: "popular" })
      const stats = parseFactionPublicStatsResponse(payload)
      await insertPublicStatsSnapshot(db, {
        runId: run.runId, userId, scheduledAt, capturedAt: new Date().toISOString(), stats,
      })
      // Slow the sequential fan-out to leave a large safety margin under
      // Torn's documented 100 requests/minute per player ceiling.
      if (cursor + 1 < end) await new Promise((resolve) => setTimeout(resolve, 250))
    } catch (error) {
      const tornError = error instanceof TornApiClientError ? error : null
      const capturedAt = new Date().toISOString()
      await insertPublicStatsSnapshot(db, {
        runId: run.runId,
        userId,
        scheduledAt,
        capturedAt,
        stats: null,
        tornErrorCode: tornError?.code ?? null,
      })
      if (tornError && (tornError.status === 429 || tornError.status >= 500 || tornError.code === 9)) {
        throw error
      }
    }
  }

  const nextIndex = end
  const now = new Date().toISOString()
  if (nextIndex < userIds.length) {
    await db.prepare(
      "UPDATE faction_performance_collection_runs SET status = 'running', next_index = ?, updated_at = ? WHERE run_id = ? AND next_index = ?",
    ).bind(nextIndex, now, run.runId, index).run()
    await env.GLOBAL_RANKINGS_QUEUE?.send({ kind: "faction-performance-collection", runId: run.runId, index: nextIndex })
    return
  }

  const summary = await db.prepare(
    "SELECT COUNT(*) AS incomplete FROM faction_member_stat_snapshots WHERE run_id = ? AND collection_status != 'complete'",
  ).bind(run.runId).first<{ incomplete: number }>()
  if (Number(summary?.incomplete ?? 0) > 0) {
    await finishCollectionRun(db, run, "partial", `${summary?.incomplete ?? 0} member(s) had incomplete public statistics.`)
  } else {
    await finishCollectionRun(db, run, "completed")
  }
}

async function completeQueuedRun(
  env: FactionPerformanceEnv,
  run: CollectionRun,
  index: number,
): Promise<void> {
  const db = requireDb(env)
  if (run.collectionKind === "roster") {
    if (index !== 0) return
    await collectRoster(env, run)
    return
  }
  if (run.collectionKind === "gym_energy") {
    if (index !== 0) return
    await collectGymEnergy(env, run)
    return
  }
  const userIds = safeJsonArray(run.targetUserIdsJson)
  if (index < run.nextIndex) return
  if (index > run.nextIndex) throw new Error("Faction public-stat collection received an out-of-order batch.")
  if (!userIds.length) {
    await finishCollectionRun(db, run, "completed")
    return
  }
  await collectPublicStatsBatch(env, run, index, userIds)
}

/** Process one serialized queue message; public stats are fetched five members at a time. */
export async function processFactionPerformanceQueueMessage(
  env: FactionPerformanceEnv,
  message: { runId: string; index?: number },
): Promise<void> {
  if (!env.DB) return
  const run = await readCollectionRun(requireDb(env), message.runId)
  if (!run || run.status === "completed" || run.status === "partial" || run.status === "failed") return
  if (run.status === "queued") {
    await requireDb(env).prepare(
      "UPDATE faction_performance_collection_runs SET status = 'running', started_at = ?, updated_at = ? WHERE run_id = ? AND status = 'queued'",
    ).bind(new Date().toISOString(), new Date().toISOString(), run.runId).run()
  }
  await completeQueuedRun(env, run, Number.isInteger(message.index) && Number(message.index) >= 0 ? Number(message.index) : 0)
}

export async function failFactionPerformanceQueueMessage(
  env: FactionPerformanceEnv,
  runId: string,
): Promise<void> {
  if (!env.DB) return
  await markCollectionFailed(env, runId, "Faction performance collection exhausted the queue retry policy.")
}
