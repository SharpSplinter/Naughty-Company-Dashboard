export type CompanyPosition = {
  id: string
  name: string
}

export type StatCode = "MAN" | "INT" | "END"

export type PositionRequirement = {
  rank: string
  primary: StatCode
  primaryMin: number
  secondary: StatCode
  secondaryMin: number
  special: string | null
}

export type CompanyPositionCatalog = {
  companies: Record<string, PositionRequirement[]>
}

export type NormalizedCompany = {
  id: number
  name: string
  typeId: number | null
  typeName: string
  rating: number | null
  daysOld: number | null
  directorName: string | null
  employeesHired: number | null
  employeeCapacity: number | null
  dailyIncome: number | null
  weeklyIncome: number | null
  dailyCustomers: number | null
  weeklyCustomers: number | null
  applicationsAllowed: boolean | null
}

export type NormalizedEmployee = {
  id: number
  name: string
  positionId: number | null
  positionName: string
  daysInCompany: number | null
  status: string | null
  lastAction: string | null
  stats: Record<StatCode, number> | null
  workStatsEffectiveness: number | null
  inactivityEffectiveness: number | null
  addictionEffectiveness: number | null
  totalPositionEffectiveness: number | null
  wage: number | null
  requirement: PositionRequirement | null
  fit: "meets" | "below" | "unknown" | "unmapped"
  primaryGap: number | null
  secondaryGap: number | null
}

export type CompanyDashboardModel = {
  company: NormalizedCompany
  employees: NormalizedEmployee[]
  positionCatalogName: string | null
  matchedPositionCount: number
  employeesWithStats: number
  employeesMeetingRequirements: number
  employeesBelowRequirements: number
  employeesWithUnknownFit: number
  fetchedAt: string
}
