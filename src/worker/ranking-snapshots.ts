export type RankingCompanyInput = {
  companyId: string | number
  companyName: string
  companyType: string
  companyTypeId: string | number | null
  starRating: number | null
  weeklyIncome: number | null
  dailyIncome: number | null
  averageDailyIncome: number | null
  directorName: string
  playerId?: string
}

export type RankingSnapshotMetadata = {
  reportingDay: string
  sourceFetchedAt: string
  capturedAt: string
  source: string
}

export type GlobalCompanyRankSnapshot = RankingCompanyInput & RankingSnapshotMetadata & {
  globalRank: number
  typeRank: number
}

export type FactionDirectorRankingInput = {
  playerId: string | number
  playerName: string
  factionId: string | number
  companyId: string | number | null
  companyName: string | null
  companyType: string | null
  companyTypeId: number | null
  companyRating: number | null
  dailyIncome: number | null
  weeklyIncome: number | null
  memberCheckedAt: string | null
  isDirector: number | boolean
}

export type FactionCompanyRankSnapshot = RankingCompanyInput & RankingSnapshotMetadata & {
  factionId: string
  playerId: string
  memberCheckedAt: string | null
  factionRank: number
  typeRank: number
}

export type FactionDirectorySyncStatus = {
  checkedAt: string
  pendingCount: number
  invalidMemberCount: number
  complete: number
}

/**
 * Only a fully traversed, recently checked faction directory can produce a
 * canonical daily faction ranking. A partial roster must never be ranked as
 * though it represented the entire faction.
 */
export function isFactionDirectorySnapshotEligible(
  status: FactionDirectorySyncStatus | null | undefined,
  sourceFetchedAt: string,
  maxClockSkewMs = 30 * 60 * 1000,
): boolean {
  if (!status || status.complete !== 1 || status.pendingCount !== 0 || status.invalidMemberCount !== 0) return false
  const checkedAt = Date.parse(status.checkedAt)
  const sourceAt = Date.parse(sourceFetchedAt)
  return Number.isFinite(checkedAt) && Number.isFinite(sourceAt) &&
    Math.abs(checkedAt - sourceAt) <= maxClockSkewMs
}

function typeKey(company: RankingCompanyInput): string {
  const numericId = Number(company.companyTypeId)
  return Number.isFinite(numericId) && numericId > 0
    ? String(numericId)
    : company.companyType.trim().toLocaleLowerCase()
}

function incomeValue(company: RankingCompanyInput): number {
  return typeof company.weeklyIncome === "number" && Number.isFinite(company.weeklyIncome)
    ? company.weeklyIncome
    : -1
}

/** Reproduce the dashboard's stable weekly-income ordering and same-type rank. */
export function buildGlobalCompanyRankSnapshots(
  companies: readonly RankingCompanyInput[],
  metadata: RankingSnapshotMetadata,
): GlobalCompanyRankSnapshot[] {
  const ordered = companies
    .map((company, sourceIndex) => ({ company, sourceIndex }))
    .sort((a, b) => incomeValue(b.company) - incomeValue(a.company) || a.sourceIndex - b.sourceIndex)
  const typePositions = new Map<string, number>()
  return ordered.map(({ company }, index) => {
    const key = typeKey(company)
    const typeRank = (typePositions.get(key) ?? 0) + 1
    typePositions.set(key, typeRank)
    return { ...company, ...metadata, globalRank: index + 1, typeRank }
  })
}

/**
 * Rank only confirmed faction directors from the faction directory itself.
 * This mirrors the Faction Rankings page and does not drop a director merely
 * because their company was absent from the global ranking response.
 */
export function buildFactionCompanyRankSnapshots(
  members: readonly FactionDirectorRankingInput[],
  metadata: RankingSnapshotMetadata,
): FactionCompanyRankSnapshot[] {
  const factions = new Map<string, Map<string, { company: RankingCompanyInput; member: FactionDirectorRankingInput }>>()
  for (const member of members) {
    if (!(member.isDirector === true || member.isDirector === 1) || member.companyId === null) continue
    if (typeof member.weeklyIncome !== "number" || !Number.isFinite(member.weeklyIncome)) continue
    const factionId = String(member.factionId)
    const companyId = String(member.companyId)
    if (!factionId || !companyId) continue
    const company: RankingCompanyInput = {
      companyId,
      companyName: member.companyName?.trim() || "Company #" + companyId,
      companyType: member.companyType?.trim() || "Unknown",
      companyTypeId: member.companyTypeId,
      starRating: member.companyRating,
      weeklyIncome: member.weeklyIncome,
      dailyIncome: member.dailyIncome,
      averageDailyIncome: member.weeklyIncome / 7,
      directorName: member.playerName,
      playerId: String(member.playerId),
    }
    let faction = factions.get(factionId)
    if (!faction) {
      faction = new Map()
      factions.set(factionId, faction)
    }
    if (!faction.has(companyId)) faction.set(companyId, { company, member })
  }

  const snapshots: FactionCompanyRankSnapshot[] = []
  for (const [factionId, faction] of factions) {
    const ordered = Array.from(faction.values())
      .map((entry, sourceIndex) => ({ ...entry, sourceIndex }))
      .sort((a, b) => incomeValue(b.company) - incomeValue(a.company) || a.sourceIndex - b.sourceIndex)
    const typePositions = new Map<string, number>()
    ordered.forEach(({ company, member }, index) => {
      const key = typeKey(company)
      const typeRank = (typePositions.get(key) ?? 0) + 1
      typePositions.set(key, typeRank)
      snapshots.push({
        ...company,
        ...metadata,
        factionId,
        playerId: String(member.playerId),
        memberCheckedAt: member.memberCheckedAt,
        factionRank: index + 1,
        typeRank,
      })
    })
  }
  return snapshots
}
