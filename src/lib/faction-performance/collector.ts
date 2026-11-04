import {
  decodePersonalStatsResponse,
  PERSONAL_STATS_HISTORICAL_NAMES,
  type PersonalStatsHistoricalName,
} from "../torn/personalstats"

export type FactionReviveSetting = "Everyone" | "Friends & faction" | "No one" | "Unknown"
export type FactionOnlineStatus = "Online" | "Idle" | "Offline" | null

export const FACTION_STAT_NAMES = [
  "medicalitemsused",
  "criminaloffences",
  "organisedcrimerespect",
  "organisedcrimemoney",
  "organisedcrimesuccess",
  "organisedcrimefail",
  "attackswon",
  "attackslost",
  "attackschain",
  "attacksleave",
  "attacksmug",
  "attackshosp",
  "bestchain",
  "busts",
  "revives",
  "jails",
  "hosps",
  "medicalitemrecovery",
  "medicalcooldownused",
  "gymtrains",
  "gymstrength",
  "gymspeed",
  "gymenergy",
  "gymdefense",
  "gymdexterity",
  "candyused",
  "alcoholused",
  "energydrinkused",
  "drugsused",
  "drugoverdoses",
  "rehabs",
  "caymaninterest",
  "traveltimes",
  "traveltime",
  "hunting",
  "attacksdamagehits",
  "attacksdamage",
  "hosptimegiven",
  "hosptimereceived",
  "attacksdamaging",
  "attacksrunaway",
  "highestterritories",
  "territoryrespect",
  "membersamount",
] as const

export type FactionStatName = (typeof FACTION_STAT_NAMES)[number]
export type FactionStat = { name: FactionStatName; value: number }
export type FactionStatsResponse = { stats: FactionStat[] }
export type ParsedFactionStatsResponse = {
  stats: FactionStat[]
  missingStatNames: FactionStatName[]
  unexpectedStatNames: string[]
}

/** Validates Torn's faction-wide /faction/stats totals and reports schema drift. */
export function parseFactionStatsResponse(payload: unknown): ParsedFactionStatsResponse {
  if (!isRecord(payload) || !Array.isArray(payload.stats)) {
    throw new Error("Torn faction stats response is missing its stats array.")
  }
  const allowedNames = new Set<string>(FACTION_STAT_NAMES)
  const seen = new Set<string>()
  const unexpected = new Set<string>()
  const stats: FactionStat[] = []
  for (const raw of payload.stats) {
    if (!isRecord(raw) || typeof raw.name !== "string") {
      throw new Error("Torn faction stats response contains an invalid stat entry.")
    }
    const name = raw.name.trim()
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
      throw new Error("Torn faction stats response contains an invalid stat name.")
    }
    if (!allowedNames.has(name)) {
      unexpected.add(name)
      continue
    }
    if (seen.has(name)) throw new Error("Torn faction stats response contains a duplicate stat name.")
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) {
      throw new Error("Torn faction stats response contains a non-numeric stat value.")
    }
    seen.add(name)
    stats.push({ name: name as FactionStatName, value: raw.value })
  }
  return {
    stats,
    missingStatNames: FACTION_STAT_NAMES.filter((name) => !seen.has(name)),
    unexpectedStatNames: Array.from(unexpected).sort(),
  }
}


export type FactionRosterMember = {
  userId: string
  name: string | null
  position: string | null
  level: number | null
  daysInFaction: number | null
  lastActionStatus: FactionOnlineStatus
  lastActionTimestamp: number | null
  lastActionRelative: string | null
  statusDescription: string | null
  statusDetails: string | null
  statusState: string | null
  statusUntil: string | null
  statusColor: string | null
  isRevivable: boolean | null
  reviveSetting: FactionReviveSetting
  isOnWall: boolean | null
  isInOc: boolean | null
  hasEarlyDischarge: boolean | null
}

export type FactionGymEnergyContributor = {
  userId: string
  username: string | null
  value: number | null
  inFaction: boolean | null
}

export type FactionPublicStats = Record<PersonalStatsHistoricalName, number | null> & {
  missingMetrics: PersonalStatsHistoricalName[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeId(value: unknown): string | null {
  const id = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value : ""
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function nullableUnixSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseReviveSetting(value: unknown): FactionReviveSetting {
  return value === "Everyone" || value === "Friends & faction" || value === "No one"
    ? value
    : "Unknown"
}

/** Validates the live Torn /faction/members wrapper and normalizes public roster fields. */
export function parseFactionRosterResponse(payload: unknown): FactionRosterMember[] {
  if (!isRecord(payload) || !Array.isArray(payload.members)) {
    throw new Error("Torn faction roster response is missing its members array.")
  }

  const members: FactionRosterMember[] = []
  const seen = new Set<string>()
  for (const raw of payload.members) {
    if (!isRecord(raw)) continue
    const userId = safeId(raw.id)
    if (!userId || seen.has(userId)) continue
    seen.add(userId)

    const lastAction = isRecord(raw.last_action) ? raw.last_action : {}
    const status = isRecord(raw.status) ? raw.status : {}
    const online = lastAction.status
    members.push({
      userId,
      name: nullableString(raw.name),
      position: nullableString(raw.position),
      level: nullableNumber(raw.level),
      daysInFaction: nullableNumber(raw.days_in_faction),
      lastActionStatus: online === "Online" || online === "Idle" || online === "Offline" ? online : null,
      lastActionTimestamp: nullableUnixSeconds(lastAction.timestamp),
      lastActionRelative: nullableString(lastAction.relative),
      statusDescription: nullableString(status.description),
      statusDetails: nullableString(status.details),
      statusState: nullableString(status.state),
      statusUntil: nullableString(status.until),
      statusColor: nullableString(status.color),
      isRevivable: nullableBoolean(raw.is_revivable),
      reviveSetting: parseReviveSetting(raw.revive_setting),
      isOnWall: nullableBoolean(raw.is_on_wall),
      isInOc: nullableBoolean(raw.is_in_oc),
      hasEarlyDischarge: nullableBoolean(raw.has_early_discharge),
    })
  }
  return members
}

/** Validates /faction/contributors?stat=gymenergy without treating missing values as zero. */
export function parseFactionGymEnergyResponse(payload: unknown): FactionGymEnergyContributor[] {
  if (!isRecord(payload) || !Array.isArray(payload.contributors)) {
    throw new Error("Torn gym-energy response is missing its contributors array.")
  }

  const contributors: FactionGymEnergyContributor[] = []
  const seen = new Set<string>()
  for (const raw of payload.contributors) {
    if (!isRecord(raw)) continue
    const userId = safeId(raw.id)
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    const value = nullableNumber(raw.value)
    contributors.push({
      userId,
      username: nullableString(raw.username),
      value: value !== null && value >= 0 ? value : null,
      inFaction: nullableBoolean(raw.in_faction),
    })
  }
  return contributors
}

/** Decodes the live Popular selection into the stable 18-metric storage shape. */
export function parseFactionPublicStatsResponse(payload: unknown): FactionPublicStats {
  const decoded = decodePersonalStatsResponse(payload, { kind: "popular" })
  if (decoded.kind !== "current") throw new Error("Torn Popular response did not decode as current personal stats.")
  const stats = Object.fromEntries(
    PERSONAL_STATS_HISTORICAL_NAMES.map((name) => [name, decoded.metrics[name]]),
  ) as Record<PersonalStatsHistoricalName, number | null>
  return { ...stats, missingMetrics: decoded.missingMetrics }
}

export const FACTION_PUBLIC_STAT_COLUMNS = PERSONAL_STATS_HISTORICAL_NAMES

export function countCompletePublicMetrics(stats: FactionPublicStats): number {
  return PERSONAL_STATS_HISTORICAL_NAMES.reduce((total, name) => total + (stats[name] === null ? 0 : 1), 0)
}
