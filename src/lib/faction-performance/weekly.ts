export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export const WEEKLY_METRIC_NAMES = [
  "xantaken",
  "lsdtaken",
  "drugsused",
  "overdosed",
  "alcoholused",
  "boostersused",
  "energydrinkused",
  "refills",
  "statenhancersused",
  "networth",
  "cantaken",
  "exttaken",
  "kettaken",
  "opitaken",
  "shrtaken",
  "spetaken",
  "pcptaken",
  "victaken",
] as const

export type WeeklyMetricName = (typeof WEEKLY_METRIC_NAMES)[number]
export type WeeklyRankingMetric = WeeklyMetricName | "gymEnergy"
export type WeeklyMetricValues = Record<WeeklyMetricName, number | null>

export type WeeklySnapshot = {
  snapshotId?: number | string
  runId: string
  userId: string
  capturedAt: string
  scheduledAt?: string
  collectionStatus?: string
  gymEnergyTotal?: number | null
  [key: string]: unknown
}

export type WeeklyMembership = {
  userId: string
  name?: string | null
  position?: string | null
  level?: number | null
  estimatedJoinedAt?: string | null
  firstSeenAt?: string | null
  leftObservedAt?: string | null
}

export type WeeklyMemberResult = {
  userId: string
  name: string
  position: string | null
  level: number | null
  participation: "full_week" | "partial_week" | "unknown"
  status: "complete" | "partial" | "incomplete" | "waiting_for_baseline" | "waiting_for_update" | "anomaly"
  metrics: WeeklyMetricValues
  startingNetworth: number | null
  endingNetworth: number | null
  gymEnergy: number | null
  knownMetricCount: number
  anomalyMetrics: WeeklyRankingMetric[]
  baselineCapturedAt: string | null
  endingCapturedAt: string | null
  baselineSnapshotId: number | string | null
  endingSnapshotId: number | string | null
  endingIsBoundary: boolean
  gymEnergyBaselineCapturedAt: string | null
  gymEnergyEndingCapturedAt: string | null
  gymEnergyEndingIsBoundary: boolean
}

export type WeeklyWindow = {
  startAt: string
  endAt: string
  generatedAt: string
  millisecondsRemaining: number
  secondsRemaining: number
}

function validTime(value: string | null | undefined): number | null {
  if (!value) return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

/** Sunday 00:00:00 UTC, independent of viewer timezone and daylight saving. */
export function utcSundayStart(timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) throw new Error("A finite timestamp is required.")
  const date = new Date(timestampMs)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - date.getUTCDay())
  return date.getTime()
}

export function utcSundayWindow(timestampMs: number): WeeklyWindow {
  const startMs = utcSundayStart(timestampMs)
  const endMs = startMs + WEEK_MS
  const remaining = Math.max(0, endMs - timestampMs)
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    generatedAt: new Date(timestampMs).toISOString(),
    millisecondsRemaining: remaining,
    secondsRemaining: Math.floor(remaining / 1000),
  }
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function newest(snapshots: WeeklySnapshot[]): WeeklySnapshot | null {
  return snapshots.slice().sort((a, b) => {
    const timeDifference = (validTime(b.capturedAt) ?? -1) - (validTime(a.capturedAt) ?? -1)
    if (timeDifference !== 0) return timeDifference
    return Number(b.snapshotId ?? 0) - Number(a.snapshotId ?? 0)
  })[0] ?? null
}

function baselineFor(
  snapshots: WeeklySnapshot[],
  boundaryRunId: string | null,
  joinedAt: number | null,
  weekStartMs: number,
): WeeklySnapshot | null {
  if (boundaryRunId) {
    const boundary = snapshots.find((snapshot) => snapshot.runId === boundaryRunId && snapshot.collectionStatus !== "failed")
    if (boundary) return boundary
  }
  // Midweek joiners start at their first observed public sample. This is a
  // partial baseline, not a claim that we know the counter at join time.
  if (joinedAt !== null && joinedAt > weekStartMs) {
    return snapshots
      .filter((snapshot) => snapshot.collectionStatus !== "failed" && (validTime(snapshot.capturedAt) ?? Number.POSITIVE_INFINITY) >= joinedAt)
      .sort((a, b) => (validTime(a.capturedAt) ?? 0) - (validTime(b.capturedAt) ?? 0))[0] ?? null
  }
  return null
}

function deltaFor(start: unknown, end: unknown): number | null {
  const startValue = numeric(start)
  const endValue = numeric(end)
  if (startValue === null || endValue === null || endValue < startValue) return null
  return endValue - startValue
}

export function calculateWeeklyMemberResult(input: {
  member: WeeklyMembership
  statSnapshots: WeeklySnapshot[]
  gymSnapshots: WeeklySnapshot[]
  weekStart: string
  weekEnd: string
  now: string
  statsBoundaryRunId?: string | null
  gymBoundaryRunId?: string | null
  statsEndingBoundaryRunId?: string | null
  gymEndingBoundaryRunId?: string | null
  requireEndingBoundary?: boolean
}): WeeklyMemberResult {
  const { member } = input
  const weekStartMs = validTime(input.weekStart)
  const weekEndMs = validTime(input.weekEnd)
  const nowMs = validTime(input.now)
  if (weekStartMs === null || weekEndMs === null || nowMs === null || weekEndMs <= weekStartMs) {
    throw new Error("The weekly reporting window is invalid.")
  }

  const joinedAt = validTime(member.estimatedJoinedAt) ?? validTime(member.firstSeenAt)
  const leftAt = validTime(member.leftObservedAt)
  const leftMidweek = leftAt !== null && leftAt < weekEndMs && leftAt > weekStartMs
  const expectsEndBoundary = leftAt === null || leftAt >= weekEndMs
  const participation = joinedAt === null
    ? "unknown"
    : joinedAt > weekStartMs || leftMidweek ? "partial_week" : "full_week"
  const eligibleStats = input.statSnapshots.filter((snapshot) => {
    if (snapshot.userId !== member.userId || snapshot.collectionStatus === "failed") return false
    const captured = validTime(snapshot.capturedAt)
    return captured !== null && captured >= weekStartMs && captured < weekEndMs &&
      captured <= nowMs && (leftAt === null || captured < leftAt)
  })
  const baseline = baselineFor(eligibleStats, input.statsBoundaryRunId ?? null, joinedAt, weekStartMs)
  const baselineAt = baseline ? validTime(baseline.capturedAt) : null
  const endingBoundaryCandidate = input.statsEndingBoundaryRunId
    ? newest(input.statSnapshots.filter((snapshot) =>
        snapshot.userId === member.userId &&
        snapshot.runId === input.statsEndingBoundaryRunId &&
        snapshot.collectionStatus !== "failed" &&
        (validTime(snapshot.capturedAt) ?? Number.POSITIVE_INFINITY) <= nowMs &&
        (leftAt === null || leftAt >= weekEndMs)))
    : null
  const ending = endingBoundaryCandidate ?? (baselineAt === null ? null : newest(eligibleStats.filter((snapshot) => {
    const captured = validTime(snapshot.capturedAt)
    return captured !== null && captured > baselineAt
  })))

  const metrics = Object.fromEntries(WEEKLY_METRIC_NAMES.map((name) => [name, null])) as WeeklyMetricValues
  const anomalyMetrics: WeeklyRankingMetric[] = []
  if (baseline && ending) {
    for (const name of WEEKLY_METRIC_NAMES) {
      const startValue = numeric(baseline[name])
      const endValue = numeric(ending[name])
      // Networth is a balance, not a monotonically increasing lifetime counter.
      // A negative weekly change is valid and must not be classified as a reset.
      if (name === "networth") {
        metrics[name] = startValue === null || endValue === null ? null : endValue - startValue
        continue
      }
      if (startValue !== null && endValue !== null && endValue < startValue) {
        anomalyMetrics.push(name)
        continue
      }
      metrics[name] = deltaFor(startValue, endValue)
    }
  }

  const eligibleGym = input.gymSnapshots.filter((snapshot) => {
    if (snapshot.userId !== member.userId || snapshot.collectionStatus === "failed") return false
    const captured = validTime(snapshot.capturedAt)
    return captured !== null && captured >= weekStartMs && captured < weekEndMs &&
      captured <= nowMs && (leftAt === null || captured < leftAt)
  })
  const gymBaseline = baselineFor(eligibleGym, input.gymBoundaryRunId ?? null, joinedAt, weekStartMs)
  const gymBaselineAt = gymBaseline ? validTime(gymBaseline.capturedAt) : null
  const gymEndingBoundaryCandidate = input.gymEndingBoundaryRunId
    ? newest(input.gymSnapshots.filter((snapshot) =>
        snapshot.userId === member.userId &&
        snapshot.runId === input.gymEndingBoundaryRunId &&
        snapshot.collectionStatus !== "failed" &&
        (validTime(snapshot.capturedAt) ?? Number.POSITIVE_INFINITY) <= nowMs &&
        (leftAt === null || leftAt >= weekEndMs)))
    : null
  const gymEnding = gymEndingBoundaryCandidate ?? (gymBaselineAt === null ? null : newest(eligibleGym.filter((snapshot) => {
    const captured = validTime(snapshot.capturedAt)
    return captured !== null && captured > gymBaselineAt
  })))
  const gymStartValue = gymBaseline ? numeric(gymBaseline.gymEnergyTotal) : null
  const gymEndValue = gymEnding ? numeric(gymEnding.gymEnergyTotal) : null
  const gymEnergyAnomaly = gymStartValue !== null && gymEndValue !== null && gymEndValue < gymStartValue
  const gymEnergy = gymStartValue !== null && gymEndValue !== null && !gymEnergyAnomaly
    ? gymEndValue - gymStartValue
    : null
  if (gymEnergyAnomaly) anomalyMetrics.push("gymEnergy")

  const startingNetworth = baseline ? numeric(baseline.networth) : null
  const endingNetworth = ending ? numeric(ending.networth) : null
  const knownMetricCount = WEEKLY_METRIC_NAMES.reduce((count, name) => count + (metrics[name] === null ? 0 : 1), 0)
  let status: WeeklyMemberResult["status"]
  if (!baseline) status = "waiting_for_baseline"
  else if (!ending) status = "waiting_for_update"
  else if (anomalyMetrics.length) status = "anomaly"
  else if (input.requireEndingBoundary && expectsEndBoundary && (!endingBoundaryCandidate || !gymEndingBoundaryCandidate)) status = "partial"
  else if (knownMetricCount === WEEKLY_METRIC_NAMES.length) status = "complete"
  else if (knownMetricCount > 0) status = "partial"
  else status = "incomplete"

  return {
    userId: member.userId,
    name: member.name || "Unknown member",
    position: member.position ?? null,
    level: numeric(member.level),
    participation,
    status,
    metrics,
    startingNetworth,
    endingNetworth,
    gymEnergy,
    knownMetricCount,
    anomalyMetrics,
    baselineCapturedAt: baseline?.capturedAt ?? null,
    endingCapturedAt: ending?.capturedAt ?? null,
    baselineSnapshotId: baseline?.snapshotId ?? null,
    endingSnapshotId: ending?.snapshotId ?? null,
    endingIsBoundary: endingBoundaryCandidate !== null,
    gymEnergyBaselineCapturedAt: gymBaseline?.capturedAt ?? null,
    gymEnergyEndingCapturedAt: gymEnding?.capturedAt ?? null,
    gymEnergyEndingIsBoundary: gymEndingBoundaryCandidate !== null,
  }
}

export function rankWeeklyMembers(
  members: WeeklyMemberResult[],
  metric: WeeklyRankingMetric,
): Array<WeeklyMemberResult & { rank: number | null }> {
  const valueFor = (member: WeeklyMemberResult) => metric === "gymEnergy" ? member.gymEnergy : member.metrics[metric]
  const known = members.filter((member) => valueFor(member) !== null)
    .sort((a, b) => Number(valueFor(b)) - Number(valueFor(a)) || a.name.localeCompare(b.name))
  const ranks = new Map<string, number>()
  let priorValue: number | null = null
  let priorRank = 0
  known.forEach((member, index) => {
    const value = Number(valueFor(member))
    const rank = priorValue === value ? priorRank : index + 1
    ranks.set(member.userId, rank)
    priorValue = value
    priorRank = rank
  })
  return members.slice().sort((a, b) => {
    const rankA = ranks.get(a.userId)
    const rankB = ranks.get(b.userId)
    if (rankA === undefined && rankB === undefined) return a.name.localeCompare(b.name)
    if (rankA === undefined) return 1
    if (rankB === undefined) return -1
    return rankA - rankB || a.name.localeCompare(b.name)
  }).map((member) => ({ ...member, rank: ranks.get(member.userId) ?? null }))
}
