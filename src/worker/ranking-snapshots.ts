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
  isDirector: number | boolean
}

export type FactionCompanyRankSnapshot = RankingCompanyInput & RankingSnapshotMetadata & {
  factionId: string
  playerId: string
  factionRank: number
  typeRank: number
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

/** Rank only confirmed faction directors whose companies occur in the same global capture. */
export function buildFactionCompanyRankSnapshots(
  members: readonly FactionDirectorRankingInput[],
  globalCompanies: readonly RankingCompanyInput[],
  metadata: RankingSnapshotMetadata,
): FactionCompanyRankSnapshot[] {
  const byCompany = new Map(globalCompanies.map((company) => [String(company.companyId), company]))
  const factions = new Map<string, Map<string, { company: RankingCompanyInput; member: FactionDirectorRankingInput }>>()
  for (const member of members) {
    if (!(member.isDirector === true || member.isDirector === 1) || member.companyId === null) continue
    const factionId = String(member.factionId)
    const companyId = String(member.companyId)
    const company = byCompany.get(companyId)
    if (!company || !factionId || !companyId) continue
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
        directorName: member.playerName || company.directorName,
        factionRank: index + 1,
        typeRank,
      })
    })
  }
  return snapshots
}
