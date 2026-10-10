import positionsData from "../../lib/company/positions.json"
import { runEngine } from "../../lib/company/engine"
import type { CompanyPositionCatalog } from "../../lib/company/types"

type IncomeSnapshot = { fetchedAt: string; dailyIncome: number | null }
type SavedCompany = { company_id: string; company_name: string | null; company_type: string | null; fetched_at: string; has_api_key?: boolean }
type RankingCompany = { companyId: string; companyName: string; companyType: string; companyTypeId: number | string | null; starRating: number | null; weeklyIncome: number | null; dailyIncome: number | null; averageDailyIncome: number | null; directorName: string; playerId: string; fetchedAt: string }
const catalog = positionsData as CompanyPositionCatalog
const companyNames = Object.keys(catalog.companies).sort()

export function createDemoData() {
  const typeName = companyNames.find((name) => name.toLowerCase() === "oil rig") ?? companyNames[0] ?? "Oil Rig"
  const typeId = typeName.toLowerCase() === "oil rig" ? 28 : 1
  const positionName = catalog.companies[typeName]?.[0]?.rank ?? "Manager"
  const now = Date.now()
  const fetchedAt = new Date(now).toISOString()
  const name = `Northstar Demo ${typeName} [SAMPLE]`
  const profile = { profile: { id: 900001, name, type: { id: typeId, name: typeName }, rating: 9, days_old: 108, director: { id: 1000001, name: "Demo Director" }, employees: { hired: 4, capacity: 10 }, income: { daily: 14200000, weekly: 99400000 }, customers: { daily: 230, weekly: 1610 }, applications_allowed: true, advertising_budget: 1320000, ratings: { popularity: 74, efficiency: 81, environment: 68 } } }
  const employees = { employees: [
    { id: 900002, name: "Alex Example", position: { id: 1, name: positionName }, days_in_company: 108, wage: 85000, stats: { manual_labor: 1800, intelligence: 2400, endurance: 1600 }, effectiveness: { total: 94 }, status: { description: "Okay" }, last_action: { relative: "2 minutes ago" } },
    { id: 900003, name: "Sam Sample", position: { id: 2, name: positionName }, days_in_company: 73, wage: 72000, stats: { manual_labor: 1450, intelligence: 1950, endurance: 2100 }, effectiveness: { total: 89 }, status: { description: "Okay" }, last_action: { relative: "5 minutes ago" } },
    { id: 900004, name: "Taylor Demo", position: { id: 3, name: positionName }, days_in_company: 41, wage: 61000, stats: { manual_labor: 900, intelligence: 1700, endurance: 1250 }, effectiveness: { total: 83 }, status: { description: "Okay" }, last_action: { relative: "12 minutes ago" } },
    { id: 900005, name: "Jamie Fiction", position: { id: 4, name: positionName }, days_in_company: 19, wage: 54000, status: { description: "Okay" }, last_action: { relative: "1 hour ago" } },
  ] }
  const stock = { stock: [{ id: 173, name: "Demo oil barrel", in_stock: 18, cost: 42500 }, { id: 174, name: "Demo equipment crate", in_stock: 3, cost: 210000 }] }
  const model = runEngine(profile, employees, catalog)
  if (!model) throw new Error("The demo company data could not be normalized.")
  const incomeHistory: IncomeSnapshot[] = Array.from({ length: 31 }, (_, index) => ({ fetchedAt: new Date(now - (30 - index) * 86400000).toISOString(), dailyIncome: 14200000 + ((index % 5) - 2) * 180000 }))
  const company: SavedCompany = { company_id: "900001", company_name: name, company_type: typeName, fetched_at: fetchedAt, has_api_key: true }
  const rankings: RankingCompany[] = [
    { companyId: "900001", companyName: name, companyType: typeName, companyTypeId: typeId, starRating: 9, weeklyIncome: 99400000, dailyIncome: 14200000, averageDailyIncome: 14200000, directorName: "Demo Director", playerId: "demo-player", fetchedAt },
    { companyId: "900002", companyName: "Copper Horizon [SAMPLE]", companyType: typeName, companyTypeId: typeId, starRating: 8, weeklyIncome: 91300000, dailyIncome: 13042857, averageDailyIncome: 13042857, directorName: "Sample Director", playerId: "demo-peer-1", fetchedAt },
    { companyId: "900003", companyName: "Blue Current [SAMPLE]", companyType: typeName, companyTypeId: typeId, starRating: 7, weeklyIncome: 82100000, dailyIncome: 11728571, averageDailyIncome: 11728571, directorName: "Example Director", playerId: "demo-peer-2", fetchedAt },
  ]
  return { result: { profile, employees, stock, incomeHistory, model }, company, rankings, typeName }
}
