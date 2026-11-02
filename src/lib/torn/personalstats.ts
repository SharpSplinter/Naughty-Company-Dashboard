export const PERSONAL_STATS_HISTORICAL_NAMES = [
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

export type PersonalStatsHistoricalName = (typeof PERSONAL_STATS_HISTORICAL_NAMES)[number]

export const PERSONAL_STATS_CATEGORIES = ["drugs", "items", "other", "networth"] as const
export type PersonalStatsCategory = (typeof PERSONAL_STATS_CATEGORIES)[number]

export const PERSONAL_STATS_METRIC_PATHS = {
  xantaken: ["drugs", "xanax"],
  lsdtaken: ["drugs", "lsd"],
  drugsused: ["drugs", "total"],
  overdosed: ["drugs", "overdoses"],
  alcoholused: ["items", "used", "alcohol"],
  boostersused: ["items", "used", "boosters"],
  energydrinkused: ["items", "used", "energy_drinks"],
  refills: ["other", "refills", "energy"],
  statenhancersused: ["items", "used", "stat_enhancers"],
  networth: ["networth", "total"],
  cantaken: ["drugs", "cannabis"],
  exttaken: ["drugs", "ecstasy"],
  kettaken: ["drugs", "ketamine"],
  opitaken: ["drugs", "opium"],
  shrtaken: ["drugs", "shrooms"],
  spetaken: ["drugs", "speed"],
  pcptaken: ["drugs", "pcp"],
  victaken: ["drugs", "vicodin"],
} as const satisfies Record<PersonalStatsHistoricalName, readonly string[]>

export type PersonalStatsRequest =
  | { kind: "full" }
  | { kind: "all" }
  | { kind: "popular" }
  | { kind: "category"; category: PersonalStatsCategory }
  | { kind: "historic"; stats: readonly PersonalStatsHistoricalName[]; timestamp: number }

export type PersonalStatsMetricValues = Record<PersonalStatsHistoricalName, number | null>

export type PersonalStatsHistoricValue = {
  name: string
  value: number
  timestamp: number
}

export type DecodedPersonalStats =
  | {
      kind: "current"
      selection: "full" | "all" | "popular" | "category"
      category?: PersonalStatsCategory
      rawPersonalStats: Record<string, unknown>
      metrics: PersonalStatsMetricValues
      missingMetrics: PersonalStatsHistoricalName[]
    }
  | {
      kind: "historic"
      stats: PersonalStatsHistoricValue[]
      missingStats: PersonalStatsHistoricalName[]
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHistoricalName(value: string): value is PersonalStatsHistoricalName {
  return (PERSONAL_STATS_HISTORICAL_NAMES as readonly string[]).includes(value)
}

function valueAtPath(root: unknown, path: readonly string[]): number | null {
  let current: unknown = root
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return null
    current = current[segment]
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null
}

function emptyMetricValues(): PersonalStatsMetricValues {
  return Object.fromEntries(PERSONAL_STATS_HISTORICAL_NAMES.map((name) => [name, null])) as PersonalStatsMetricValues
}

/**
 * Builds an endpoint-relative path for GET /v2/user/{id}/personalstats.
 * Historical stat batches are deliberately capped at Torn's documented limit.
 */
export function buildPersonalStatsPath(
  playerId: string | number,
  request: PersonalStatsRequest,
): string {
  const id = String(playerId)
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new Error("Player ID must be a positive safe integer.")
  }

  const base = `/user/${id}/personalstats`
  if (request.kind === "full") return base
  if (request.kind === "all") return `${base}?cat=all`
  if (request.kind === "popular") return `${base}?cat=popular`
  if (request.kind === "category") return `${base}?cat=${encodeURIComponent(request.category)}`

  if (!Number.isSafeInteger(request.timestamp) || request.timestamp <= 0) {
    throw new Error("A positive Unix timestamp is required for historical personal stats.")
  }
  if (request.stats.length < 1 || request.stats.length > 10) {
    throw new Error("Historical personal stats requests must contain between 1 and 10 stat names.")
  }
  const unique = new Set(request.stats)
  if (unique.size !== request.stats.length) {
    throw new Error("Historical personal stats requests must not contain duplicate stat names.")
  }
  const query = new URLSearchParams({
    stat: request.stats.join(","),
    timestamp: String(request.timestamp),
  })
  return `${base}?${query.toString()}`
}

/**
 * Decodes the response according to the request that produced it. The Torn
 * OpenAPI schema leaves Full, FullPublic and Popular payloads as unknown, so
 * this function validates their runtime structure instead of asserting a type.
 * Missing/non-numeric metrics are kept null and listed explicitly.
 */
export function decodePersonalStatsResponse(
  payload: unknown,
  request: PersonalStatsRequest,
): DecodedPersonalStats {
  if (!isRecord(payload) || !("personalstats" in payload)) {
    throw new Error("Torn personalstats response is missing its personalstats property.")
  }

  const personalstats: unknown = payload.personalstats

  if (request.kind === "historic") {
    if (!Array.isArray(personalstats)) {
      throw new Error("Torn historical personalstats response must contain a personalstats array.")
    }

    const stats: PersonalStatsHistoricValue[] = personalstats.map((item, index) => {
      if (!isRecord(item) || typeof item.name !== "string" ||
        typeof item.value !== "number" || !Number.isFinite(item.value) ||
        typeof item.timestamp !== "number" || !Number.isSafeInteger(item.timestamp) || item.timestamp <= 0) {
        throw new Error(`Torn historical personalstats item ${index} has an invalid name, value or timestamp.`)
      }
      return { name: item.name, value: item.value, timestamp: item.timestamp }
    })

    const found = new Set(stats.map((item) => item.name))
    return {
      kind: "historic",
      stats,
      missingStats: request.stats.filter((name) => !found.has(name)),
    }
  }

  if (!isRecord(personalstats)) {
    throw new Error("Torn current personalstats response must contain a personalstats object.")
  }

  if (request.kind === "category" && !isRecord(personalstats[request.category])) {
    throw new Error(`Torn personalstats category response did not include the requested ${request.category} category.`)
  }

  const metrics = emptyMetricValues()
  for (const name of PERSONAL_STATS_HISTORICAL_NAMES) {
    metrics[name] = valueAtPath(personalstats, PERSONAL_STATS_METRIC_PATHS[name])
  }

  const missingMetrics = PERSONAL_STATS_HISTORICAL_NAMES.filter((name) => metrics[name] === null)
  return {
    kind: "current",
    selection: request.kind,
    ...(request.kind === "category" ? { category: request.category } : {}),
    rawPersonalStats: personalstats,
    metrics,
    missingMetrics,
  }
}

/**
 * Returns the specific category requests that can fill missing dashboard
 * metrics. It intentionally does not escalate to cat=all: callers should use
 * Popular first, then the smallest category selection needed.
 */
export function categoriesForMissingPersonalStats(
  missingMetrics: readonly PersonalStatsHistoricalName[],
): PersonalStatsCategory[] {
  const categories = new Set<PersonalStatsCategory>()
  for (const name of missingMetrics) {
    const category = PERSONAL_STATS_METRIC_PATHS[name][0]
    if ((PERSONAL_STATS_CATEGORIES as readonly string[]).includes(category)) {
      categories.add(category as PersonalStatsCategory)
    }
  }
  return PERSONAL_STATS_CATEGORIES.filter((category) => categories.has(category))
}
