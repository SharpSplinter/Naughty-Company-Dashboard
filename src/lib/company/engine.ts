import type {
  CompanyDashboardModel,
  CompanyPositionCatalog,
  NormalizedCompany,
  NormalizedEmployee,
  PositionRequirement,
  StatCode,
} from "./types"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nestedNumber(source: UnknownRecord, key: string, child: string): number | null {
  return finiteNumber(record(source[key])[child])
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function unwrap(value: unknown, key: string): unknown {
  const root = record(value)
  return root[key] ?? value
}

function normalizeCompany(value: unknown): NormalizedCompany {
  const profile = record(unwrap(value, "profile"))
  const type = record(profile.type)
  const director = record(profile.director)
  const employees = record(profile.employees)
  const status = record(director.status)
  const lastAction = record(director.last_action)

  return {
    id: finiteNumber(profile.id) ?? 0,
    name: text(profile.name) ?? "Unknown company",
    typeId: finiteNumber(type.id),
    typeName: text(type.name) ?? "Unknown company type",
    rating: finiteNumber(profile.rating),
    daysOld: finiteNumber(profile.days_old),
    directorName: text(director.name),
    employeesHired: finiteNumber(employees.hired),
    employeeCapacity: finiteNumber(employees.capacity),
    dailyIncome: nestedNumber(profile, "income", "daily"),
    weeklyIncome: nestedNumber(profile, "income", "weekly"),
    dailyCustomers: nestedNumber(profile, "customers", "daily"),
    weeklyCustomers: nestedNumber(profile, "customers", "weekly"),
    applicationsAllowed:
      typeof profile.applications_allowed === "boolean"
        ? profile.applications_allowed
        : null,
  }
}

function normalizeStats(value: unknown): Record<StatCode, number> | null {
  const stats = record(value)
  const manual = finiteNumber(stats.manual_labor)
  const intelligence = finiteNumber(stats.intelligence)
  const endurance = finiteNumber(stats.endurance)
  if (manual === null || intelligence === null || endurance === null) return null
  return { MAN: manual, INT: intelligence, END: endurance }
}

function normalizeStatus(value: unknown): string | null {
  const status = record(value)
  return text(status.description) ?? text(status.state) ?? text(status.details)
}

function normalizeLastAction(value: unknown): string | null {
  const action = record(value)
  const relative = text(action.relative)
  if (relative) return relative
  const status = text(action.status)
  return status
}

function findRequirement(
  positionName: string,
  requirements: PositionRequirement[],
): PositionRequirement | null {
  const key = positionName.trim().toLocaleLowerCase()
  return requirements.find((item) => item.rank.trim().toLocaleLowerCase() === key) ?? null
}

function normalizeEmployee(
  value: unknown,
  requirements: PositionRequirement[],
): NormalizedEmployee | null {
  const employee = record(value)
  const id = finiteNumber(employee.id)
  const name = text(employee.name)
  if (id === null || !name) return null

  const position = record(employee.position)
  const positionName = text(position.name) ?? "Unknown position"
  const stats = normalizeStats(employee.stats)
  const requirement = findRequirement(positionName, requirements)
  let fit: NormalizedEmployee["fit"] = "unmapped"
  let primaryGap: number | null = null
  let secondaryGap: number | null = null

  if (requirement) {
    if (!stats) {
      fit = "unknown"
    } else {
      primaryGap = Math.max(0, requirement.primaryMin - stats[requirement.primary])
      secondaryGap = Math.max(0, requirement.secondaryMin - stats[requirement.secondary])
      fit = primaryGap === 0 && secondaryGap === 0 ? "meets" : "below"
    }
  }

  const effectiveness = record(employee.effectiveness)
  const lastAction = record(employee.last_action)
  const workStatsEffectiveness = finiteNumber(effectiveness.working_stats ?? effectiveness.work_stats ?? effectiveness.workStats)
  const inactivityEffectiveness = finiteNumber(effectiveness.inactivity ?? effectiveness.inactive ?? effectiveness.settled_in ?? effectiveness.settledIn)
  const addictionEffectiveness = finiteNumber(effectiveness.addiction)
  const totalPositionEffectiveness = finiteNumber(effectiveness.total)

  return {
    id,
    name,
    positionId: finiteNumber(position.id),
    positionName,
    daysInCompany: finiteNumber(employee.days_in_company),
    status: normalizeStatus(employee.status),
    lastAction: normalizeLastAction(lastAction),
    lastActionTimestamp: finiteNumber(lastAction.timestamp),
    stats,
    workStatsEffectiveness,
    inactivityEffectiveness,
    addictionEffectiveness,
    totalPositionEffectiveness,
    wage: finiteNumber(employee.wage),
    requirement,
    fit,
    primaryGap,
    secondaryGap,
  }
}

/**
 * Normalizes Torn API v2 profile and employee responses into a stable dashboard model.
 * Restricted employee stats remain null and are never treated as zero.
 */
export function runEngine(
  profileResponse: unknown,
  employeeResponse: unknown,
  catalog: CompanyPositionCatalog,
): CompanyDashboardModel | null {
  const company = normalizeCompany(profileResponse)
  if (!company.id || company.name === "Unknown company") return null

  const positionCatalogName =
    Object.keys(catalog.companies).find(
      (name) => name.trim().toLocaleLowerCase() === company.typeName.trim().toLocaleLowerCase(),
    ) ?? null
  const requirements = positionCatalogName ? catalog.companies[positionCatalogName] : []
  const rawEmployees = record(unwrap(employeeResponse, "employees")).employees
  const employeeList = Array.isArray(unwrap(employeeResponse, "employees"))
    ? unwrap(employeeResponse, "employees") as unknown[]
    : Array.isArray(rawEmployees)
      ? rawEmployees
      : []

  const employees = employeeList
    .map((item) => normalizeEmployee(item, requirements))
    .filter((item): item is NormalizedEmployee => item !== null)
    .sort((a, b) => a.positionName.localeCompare(b.positionName) || a.name.localeCompare(b.name))

  return {
    company,
    employees,
    positionCatalogName,
    matchedPositionCount: employees.filter((employee) => employee.requirement !== null).length,
    employeesWithStats: employees.filter((employee) => employee.stats !== null).length,
    employeesMeetingRequirements: employees.filter((employee) => employee.fit === "meets").length,
    employeesBelowRequirements: employees.filter((employee) => employee.fit === "below").length,
    employeesWithUnknownFit: employees.filter((employee) => employee.fit === "unknown").length,
    fetchedAt: new Date().toISOString(),
  }
}
