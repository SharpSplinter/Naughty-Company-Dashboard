import { useEffect, useMemo, useState } from "react"
import positionsData from "../../lib/company/positions.json"
import { runEngine } from "../../lib/company/engine"
import type { CompanyDashboardModel, CompanyPositionCatalog } from "../../lib/company/types"

const catalog = positionsData as CompanyPositionCatalog
const companyNames = Object.keys(catalog.companies).sort()
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
  || "https://naughty-company-api.kboone801.workers.dev"

type IncomeSnapshot = { fetchedAt: string; dailyIncome: number | null }
type ApiResult = { model: CompanyDashboardModel; profile: unknown; employees: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[] }
type SavedCompany = { company_id: string; company_name: string | null; company_type: string | null; fetched_at: string; has_api_key?: boolean }
type RankingCompany = { companyId: string; companyName: string; companyType: string; companyTypeId: number | string | null; starRating: number | null; weeklyIncome: number | null; dailyIncome: number | null; averageDailyIncome: number | null; directorName: string; playerId: string; fetchedAt: string }
type FactionDirector = { playerId: string; directorName: string; companyId: string; companyName: string; companyType: string | null; companyTypeId: number | string | null; starRating: number | null; dailyIncome: number | null; weeklyIncome: number | null; fetchedAt: string }
type CompareHistoryPoint = { day: string; dailyIncome: number | null; weeklyIncome: number | null; stock: unknown }
type CompareData = { director: FactionDirector; history: CompareHistoryPoint[]; stockHistoryAvailable: boolean }
type ChartSeries = { label: string; values: { label: string; value: number | null }[] }

function LineChart({ title, series, money = false }: { title: string; series: ChartSeries[]; money?: boolean }) {
  const values = series.flatMap((item) => item.values.map((point) => point.value).filter((value): value is number => value !== null && Number.isFinite(value)))
  if (!values.length) return <section className="panel chart-panel"><div className="panel-heading"><h2>{title}</h2></div><div className="empty-state">Not enough saved history to draw this graph yet. The chart fills in as daily snapshots are collected.</div></section>
  const width = 720, height = 230, left = 56, right = 18, top = 20, bottom = 38
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1
  const longest = Math.max(2, ...series.map((item) => item.values.length))
  const x = (index: number) => left + index * (width - left - right) / (longest - 1)
  const y = (value: number) => top + (max - value) * (height - top - bottom) / range
  const label = (value: number) => money ? formatMoney(value) : value.toLocaleString()
  return <section className="panel chart-panel"><div className="panel-heading"><div><h2>{title}</h2><p>Daily snapshots, UTC</p></div><div className="chart-legend">{series.map((item, index) => <span key={item.label}><i className={`chart-key chart-key-${index % 3}`} />{item.label}</span>)}</div></div><div className="chart-scroll"><svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>{Array.from({length:4},(_,i)=>{const yy=top+i*(height-top-bottom)/3;return <g key={i}><line x1={left} x2={width-right} y1={yy} y2={yy} className="chart-grid"/><text x={left-8} y={yy+4} textAnchor="end" className="chart-label">{label(max-i*range/3)}</text></g>})}{series.map((item,index)=>{const points=item.values.flatMap((point,i)=>point.value===null?[]:[`${x(i)},${y(point.value)}`]).join(" ");return <g key={item.label}><polyline points={points} className={`chart-line chart-line-${index%3}`}/>{item.values.map((point,i)=>point.value===null?null:<circle key={`${point.label}-${i}`} cx={x(i)} cy={y(point.value)} r="3" className={`chart-point chart-line-${index%3}`} />)}</g>})}<text x={left} y={height-10} className="chart-label">{series.flatMap(s=>s.values)[0]?.label ?? ""}</text><text x={width-right} y={height-10} textAnchor="end" className="chart-label">{series.flatMap(s=>s.values).at(-1)?.label ?? ""}</text></svg></div></section>
}
function stockInventoryValue(stock: unknown): number | null {
  if (!stock || typeof stock !== "object") return null
  const values: number[] = []
  const visit = (value: unknown, depth: number) => { if (!value || typeof value !== "object" || depth > 6) return; if (Array.isArray(value)) { value.forEach((item) => visit(item, depth+1)); return } const row=value as Record<string,unknown>; const qty=[row.in_stock,row.quantity,row.amount].find((n)=>typeof n==="number"&&Number.isFinite(n)) as number|undefined; const cost=[row.cost,row.unit_cost,row.cost_per_unit].find((n)=>typeof n==="number"&&Number.isFinite(n)) as number|undefined; if(qty!==undefined&&cost!==undefined)values.push(Math.max(0,qty)*Math.max(0,cost)); for(const [key,child] of Object.entries(row))if(!["in_stock","quantity","amount","cost","unit_cost","cost_per_unit"].includes(key))visit(child,depth+1) }
  visit(stock,0); return values.length ? values.reduce((sum,value)=>sum+value,0) : null
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString()
}

function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : "$" + value.toLocaleString()
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "No data returned."
}
function firstNumeric(root: unknown, names: string[]): number | null {
  const visit = (value: unknown, depth: number): number | null => {
    if (!value || typeof value !== "object" || depth > 5) return null
    const object = value as Record<string, unknown>
    for (const name of names) if (typeof object[name] === "number" && Number.isFinite(object[name])) return object[name] as number
    for (const child of Object.values(object)) { const found = visit(child, depth + 1); if (found !== null) return found }
    return null
  }
  return visit(root, 0)
}
function stockCostTotal(value: unknown): number {
  let total = 0
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object" || depth > 6) return
    if (Array.isArray(item)) { item.forEach((child) => visit(child, depth + 1)); return }
    const row = item as Record<string, unknown>
    const quantity = [row.quantity, row.amount, row.in_stock, row.stock].find((n) => typeof n === "number" && Number.isFinite(n)) as number | undefined
    const unitCost = [row.cost, row.unit_cost, row.cost_per_unit, row.purchase_price].find((n) => typeof n === "number" && Number.isFinite(n)) as number | undefined
    if (quantity !== undefined && unitCost !== undefined) total += Math.max(0, quantity) * Math.max(0, unitCost)
    for (const [key, child] of Object.entries(row)) if (!['quantity','amount','in_stock','cost','unit_cost','cost_per_unit','purchase_price'].includes(key)) visit(child, depth + 1)
  }
  visit(value, 0)
  return total
}
function financialCosts(profile: unknown, stock: unknown, normalized: CompanyDashboardModel) {
  const adBudget = firstNumeric(profile, ["advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"]) ?? 0
  const wages = normalized.employees.reduce((sum, employee) => sum + Math.max(0, employee.wage ?? 0), 0)
  const stockCosts = stockCostTotal(stock)
  return { adBudget, wages, stockCosts, hasStockCosts: stock !== null && stock !== undefined, dailyCosts: adBudget + wages + stockCosts }
}

function createDemoData() {
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

export function FloorApp() {
  const [activeView, setActiveView] = useState<"overview" | "employees" | "catalog" | "connect" | "type-rankings" | "faction-rankings" | "charts">("overview")
  const [search, setSearch] = useState("")
  const [selectedCompany, setSelectedCompany] = useState(companyNames[0] ?? "")
  const [apiKey, setApiKey] = useState("")
  const [secondaryCompanyKey, setSecondaryCompanyKey] = useState("")
  const [companyKeySaved, setCompanyKeySaved] = useState(false)
  const [needsSecondaryKey, setNeedsSecondaryKey] = useState(false)
  const [isDirector, setIsDirector] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [sessionToken, setSessionToken] = useState("")
  const [authChecking, setAuthChecking] = useState(true)
  const [demoMode, setDemoMode] = useState(false)
  const [playerName, setPlayerName] = useState("")
  const [playerId, setPlayerId] = useState("")
  const [selectedCompanyId, setSelectedCompanyId] = useState("")
  const [showCompanySelector, setShowCompanySelector] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [savedCompanies, setSavedCompanies] = useState<SavedCompany[]>([])
  const [rankingCompanies, setRankingCompanies] = useState<RankingCompany[]>([])
  const [globalRankingCompanies, setGlobalRankingCompanies] = useState<RankingCompany[]>([])
  const [rankingsUpdatedAt, setRankingsUpdatedAt] = useState("")
  const [rankingError, setRankingError] = useState("")
  const [factionDirectors, setFactionDirectors] = useState<FactionDirector[]>([])
  const [factionSyncPending, setFactionSyncPending] = useState(0)
  const [selectedComparePlayerId, setSelectedComparePlayerId] = useState("")
  const [compareData, setCompareData] = useState<CompareData | null>(null)
  const [ownCompareData, setOwnCompareData] = useState<CompareData | null>(null)
  const [compareError, setCompareError] = useState("")
  const [factionSyncing, setFactionSyncing] = useState(false)
  const [selectedRankingType, setSelectedRankingType] = useState("")

  useEffect(() => {
    const token = sessionStorage.getItem("ncd_session") || ""
    if (!token) { setAuthChecking(false); return }
    let cancelled = false
    async function restoreSession() {
      try {
        const response = await fetch(`${API_BASE}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error("Session expired")
        const session = await response.json() as { player: { id: string; name: string }; key: { saved: boolean }; company?: { isDirector?: boolean; key?: { saved?: boolean }; needsSecondaryKey?: boolean } }
        if (cancelled) return
        setSessionToken(token)
        setPlayerName(session.player.name)
        setPlayerId(session.player.id)
        setKeySaved(session.key.saved)
        setIsDirector(session.company?.isDirector ?? false)
        setCompanyKeySaved(session.company?.key?.saved ?? false)
        setNeedsSecondaryKey(session.company?.needsSecondaryKey ?? !(session.company?.key?.saved ?? false))
        const listResponse = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${token}` } })
        if (!listResponse.ok) return
        const list = await listResponse.json() as { companies: SavedCompany[] }
        if (cancelled) return
        setSavedCompanies(list.companies || [])
        if (list.companies?.length) {
          const company = list.companies[0]
          setSelectedCompanyId(company.company_id)
          let dataResponse = await fetch(`${API_BASE}/api/me/companies/${company.company_id}`, { headers: { Authorization: `Bearer ${token}` } })
          if (!dataResponse.ok) dataResponse = await fetch(`${API_BASE}/api/company/refresh`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ companyId: company.company_id }) })
          if (!dataResponse.ok || cancelled) return
          const data = await dataResponse.json() as { profile: unknown; employees: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[]; companyId?: string | number }
          const normalized = runEngine(data.profile, data.employees, catalog)
          if (normalized && !cancelled) {
            setResult({ profile: data.profile, employees: data.employees, stock: data.stock, incomeHistory: data.incomeHistory, model: normalized })
            setSelectedCompanyId(String(data.companyId ?? normalized.company.id))
            setSelectedRankingType(normalized.company.typeName)
            const refreshed = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${token}` } })
            if (refreshed.ok && !cancelled) { const saved = await refreshed.json() as { companies: SavedCompany[] }; setSavedCompanies(saved.companies || []) }
          }
        }
      } catch {
        sessionStorage.removeItem("ncd_session")
      } finally {
        if (!cancelled) setAuthChecking(false)
      }
    }
    void restoreSession()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!sessionToken || (activeView !== "type-rankings" && activeView !== "faction-rankings" && activeView !== "charts")) return
    let cancelled = false
    let pollTimer: number | undefined
    let hasPolled = false
    async function loadRankings() {
      setRankingError("")
      if (activeView === "faction-rankings" || activeView === "charts") {
        try {
          const response = await fetch(`${API_BASE}/api/faction/directors`, { headers: { Authorization: `Bearer ${sessionToken}` } })
          const payload = await response.json() as { error?: string; directors?: FactionDirector[]; processed?: number; pending?: number; syncing?: boolean; generatedAt?: string }
          if (!response.ok) throw new Error(payload.error || "Could not load the faction director directory.")
          if (cancelled) return
          const directors = payload.directors || []
          setFactionDirectors(directors)
          setFactionSyncPending(payload.pending || 0)
          setRankingCompanies(directors.map((director) => ({ companyId: String(director.companyId), companyName: director.companyName, companyType: director.companyType || "Unknown", companyTypeId: director.companyTypeId, starRating: director.starRating, weeklyIncome: director.weeklyIncome, dailyIncome: director.dailyIncome, averageDailyIncome: director.weeklyIncome === null ? null : director.weeklyIncome / 7, directorName: director.directorName, playerId: String(director.playerId), fetchedAt: director.fetchedAt })))
          setRankingsUpdatedAt(payload.generatedAt || "")
          setSelectedComparePlayerId((current) => current || String(directors.find((director) => String(director.playerId) !== String(playerId))?.playerId || directors[0]?.playerId || ""))
          if (payload.syncing && !hasPolled) { hasPolled = true; pollTimer = window.setTimeout(() => { if (!cancelled) void loadRankings() }, 8000) }
        } catch (caught) { if (!cancelled) setRankingError(caught instanceof Error ? caught.message : "Could not load the faction director directory.") }
        return
      }
      const connectedType = result?.model.company.typeName || selectedRankingType || savedCompanies.find((company) => company.company_type)?.company_type || ""
      if (!connectedType) { setRankingCompanies([]); setGlobalRankingCompanies([]); setRankingError("Connect a company first. Company rankings are limited to your connected company type."); return }
      try {
        const response = await fetch(`${API_BASE}/api/rankings?scope=global&type=${encodeURIComponent(connectedType)}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; companies?: RankingCompany[]; generatedAt?: string }
        if (!response.ok) throw new Error(payload.error || "Could not load company rankings.")
        if (cancelled) return
        const sorted = (payload.companies || []).slice().sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1))
        setGlobalRankingCompanies(sorted); setRankingCompanies(sorted); setSelectedRankingType(connectedType); setRankingsUpdatedAt(payload.generatedAt || "")
      } catch (caught) { if (!cancelled) setRankingError(caught instanceof Error ? caught.message : "Could not load company rankings.") }
    }
    void loadRankings()
    return () => { cancelled = true; if (pollTimer !== undefined) window.clearTimeout(pollTimer) }
  }, [activeView, sessionToken, selectedRankingType, result?.model.company.typeName, savedCompanies, playerId])

  useEffect(() => {
    if (!sessionToken || activeView !== "charts" || !selectedComparePlayerId) return
    let cancelled = false
    async function loadComparison() {
      setCompareError("")
      try {
        const [peerResponse, ownResponse] = await Promise.all([
          fetch(`${API_BASE}/api/faction/compare?playerId=${encodeURIComponent(selectedComparePlayerId)}`, { headers: { Authorization: `Bearer ${sessionToken}` } }),
          fetch(`${API_BASE}/api/faction/compare?playerId=${encodeURIComponent(playerId)}`, { headers: { Authorization: `Bearer ${sessionToken}` } }),
        ])
        const peer = await peerResponse.json() as CompareData & { error?: string }
        const own = await ownResponse.json() as CompareData & { error?: string }
        if (!peerResponse.ok) throw new Error(peer.error || "Could not load the selected director's history.")
        if (!cancelled) { setCompareData(peer); setOwnCompareData(ownResponse.ok ? own : null) }
      } catch (caught) { if (!cancelled) { setCompareError(caught instanceof Error ? caught.message : "Could not load comparison data."); setCompareData(null); setOwnCompareData(null) } }
    }
    void loadComparison()
    return () => { cancelled = true }
  }, [sessionToken, activeView, selectedComparePlayerId, playerId])

  async function refreshFactionDirectory() {
    if (!sessionToken || factionSyncing) return
    setFactionSyncing(true); setRankingError("")
    try {
      const response = await fetch(`${API_BASE}/api/faction/directors`, { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string; directors?: FactionDirector[]; pending?: number; generatedAt?: string }
      if (!response.ok) throw new Error(payload.error || "Could not refresh the faction directory.")
      const directors = payload.directors || []
      setFactionDirectors(directors); setFactionSyncPending(payload.pending || 0); setRankingsUpdatedAt(payload.generatedAt || "")
      setRankingCompanies(directors.map((director) => ({ companyId: String(director.companyId), companyName: director.companyName, companyType: director.companyType || "Unknown", companyTypeId: director.companyTypeId, starRating: director.starRating, weeklyIncome: director.weeklyIncome, dailyIncome: director.dailyIncome, averageDailyIncome: director.weeklyIncome === null ? null : director.weeklyIncome / 7, directorName: director.directorName, playerId: String(director.playerId), fetchedAt: director.fetchedAt })))
      setSelectedComparePlayerId((current) => current || String(directors[0]?.playerId || ""))
    } catch (caught) { setRankingError(caught instanceof Error ? caught.message : "Could not refresh the faction directory.") }
    finally { setFactionSyncing(false) }
  }

  const filteredCompanies = useMemo(
    () => companyNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())),
    [search],
  )
  const positions = catalog.companies[selectedCompany] ?? []
  const allTornRows = activeView === "faction-rankings" ? rankingCompanies : globalRankingCompanies.length ? globalRankingCompanies : activeView === "type-rankings" ? rankingCompanies : []
  const model = result?.model
  const currentRankingCompany = model ? allTornRows.find((row) => row.companyId === String(model.company.id)) : undefined
  const companyPeerRows = model ? allTornRows.filter((row) => row.companyType === model.company.typeName) : currentRankingCompany ? allTornRows.filter((row) => row.companyType === currentRankingCompany.companyType) : []
  const currentStar = currentRankingCompany?.starRating ?? model?.company.rating ?? null
  const nextStarIncome = currentStar === null ? null : companyPeerRows.filter((row) => row.starRating !== null && row.starRating > currentStar && row.weeklyIncome !== null).sort((a, b) => (a.starRating! - b.starRating!) || (a.weeklyIncome! - b.weeklyIncome!))[0]?.weeklyIncome ?? null
  const previousStarIncome = currentStar === null ? null : companyPeerRows.filter((row) => row.starRating !== null && row.starRating < currentStar && row.weeklyIncome !== null).sort((a, b) => (b.starRating! - a.starRating!) || (b.weeklyIncome! - a.weeklyIncome!))[0]?.weeklyIncome ?? null
  const currentWeeklyIncome = model?.company.weeklyIncome ?? currentRankingCompany?.weeklyIncome ?? null
  const nextStarGap = nextStarIncome === null || currentWeeklyIncome === null ? null : Math.max(0, nextStarIncome - currentWeeklyIncome)
  const previousStarGap = previousStarIncome === null || currentWeeklyIncome === null ? null : Math.max(0, currentWeeklyIncome - previousStarIncome)
  const profileRoot = getObject(getObject(result?.profile)?.company) ?? getObject(getObject(result?.profile)?.profile) ?? getObject(result?.profile) ?? {}
  const operatingRatings = getObject(profileRoot.ratings) ?? profileRoot
  const popularity = typeof operatingRatings.popularity === "number" ? operatingRatings.popularity : null
  const efficiency = typeof operatingRatings.efficiency === "number" ? operatingRatings.efficiency : null
  const environment = typeof operatingRatings.environment === "number" ? operatingRatings.environment : null
  const costs = model && result ? financialCosts(result.profile, result.stock, model) : null
  const dailyProfit = model?.company.dailyIncome == null || !costs ? null : model.company.dailyIncome - costs.dailyCosts
  const utcNow = new Date()
  const periodStart = (kind: "week" | "month") => {
    const boundary = new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), 1, 18))
    if (kind === "week") {
      const daysSinceSunday = utcNow.getUTCDay()
      boundary.setUTCDate(utcNow.getUTCDate() - daysSinceSunday)
      if (utcNow.getUTCHours() < 18) boundary.setUTCDate(boundary.getUTCDate() - 7)
      boundary.setUTCHours(18, 0, 0, 0)
      return boundary
    }
    if (utcNow < boundary) boundary.setUTCMonth(boundary.getUTCMonth() - 1)
    return boundary
  }
  const dailySamples = (result?.incomeHistory ?? []).filter((item) => item.dailyIncome !== null && new Date(item.fetchedAt) >= periodStart("week") && new Date(item.fetchedAt) <= utcNow)
  const dedupedSamples = Array.from(new Map(dailySamples.map((item) => [new Date(new Date(item.fetchedAt).getTime() - 18 * 3600000).toISOString().slice(0, 10), item])).values())
  const weekSamples = dedupedSamples.filter((item) => new Date(item.fetchedAt) >= periodStart("week"))
  const monthSamples = dedupedSamples.filter((item) => new Date(item.fetchedAt) >= periodStart("month"))
  const weeklyIncome = weekSamples.length ? weekSamples.reduce((sum, item) => sum + (item.dailyIncome ?? 0), 0) : null
  const monthlyIncome = monthSamples.length ? monthSamples.reduce((sum, item) => sum + (item.dailyIncome ?? 0), 0) : null
  const weeklyProfit = weeklyIncome === null || !costs ? null : weeklyIncome - costs.dailyCosts * weekSamples.length
  const monthlyProfit = monthlyIncome === null || !costs ? null : monthlyIncome - costs.dailyCosts * monthSamples.length
  const rankingRows = useMemo(() => rankingCompanies
    .filter((company) => activeView === "faction-rankings"
      ? Boolean(selectedRankingType || model?.company.typeName) && company.companyType === (selectedRankingType || model?.company.typeName)
      : activeView === "type-rankings"
        ? Boolean(selectedRankingType || model?.company.typeName) && company.companyType === (selectedRankingType || model?.company.typeName)
        : true)
    .slice()
    .sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1)), [rankingCompanies, activeView, selectedRankingType, model?.company.typeName, playerId])
  function placement(company: RankingCompany, dimension: "type" | "stars"): string {
    const target = allTornRows.find((row) => row.companyId === company.companyId)
    if (!target) return "—"
    const reference = dimension === "type"
      ? allTornRows.filter((row) => row.companyType === target.companyType)
      : allTornRows.filter((row) => row.companyType === target.companyType && row.starRating !== null && row.starRating === target.starRating)
    if (!reference.length || (dimension === "stars" && target.starRating === null)) return "—"
    const rank = reference.filter((row) => (row.weeklyIncome ?? -1) > (target.weeklyIncome ?? -1)).length + 1
    const total = reference.length
    const suffix = total % 100 >= 11 && total % 100 <= 13 ? "th" : total % 10 === 1 ? "st" : total % 10 === 2 ? "nd" : total % 10 === 3 ? "rd" : "th"
    return `${rank}/${total}${suffix}`
  }

  async function deleteSavedKey() {
    if (!sessionToken || !window.confirm("Permanently delete your saved login and company keys? Your player profile and saved company data will remain.")) return
    setError("")
    try {
      const response = await fetch(`${API_BASE}/api/auth/key`, { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not delete the saved key.")
      setKeySaved(false)
      setCompanyKeySaved(false)
      setNeedsSecondaryKey(true)
      setIsDirector(false)
      setApiKey("")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not delete the saved key.") }
  }

  async function loadSavedCompany(id: string) {
    if (demoMode) { setSelectedCompanyId(id); setShowCompanySelector(false); setActiveView("overview"); return }
    if (!sessionToken) return
    setError("")
    setLoading(true)
    try {
      let response = await fetch(`${API_BASE}/api/me/companies/${id}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
      let payload = await response.json() as { error?: string; profile?: unknown; employees?: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[] }
      if (!response.ok) {
        response = await fetch(`${API_BASE}/api/company/refresh`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ companyId: id }) })
        payload = await response.json() as { error?: string; profile?: unknown; employees?: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[] }
      }
      if (!response.ok) throw new Error(payload.error || "Could not load saved company data.")
      const normalized = runEngine(payload.profile, payload.employees, catalog)
      if (!normalized) throw new Error("The saved company profile could not be normalized.")
      setResult({ profile: payload.profile, employees: payload.employees, stock: payload.stock, incomeHistory: payload.incomeHistory, model: normalized })
      setSelectedCompanyId(id)
      setShowCompanySelector(false)
      setActiveView("overview")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load saved company data.") }
    finally { setLoading(false) }
  }

  function startDemo() {
    const demo = createDemoData()
    sessionStorage.removeItem("ncd_session")
    setSessionToken("")
    setDemoMode(true)
    setPlayerName("Demo Director")
    setPlayerId("demo-player")
    setKeySaved(false)
    setIsDirector(true)
    setCompanyKeySaved(true)
    setNeedsSecondaryKey(false)
    setResult(demo.result)
    setSavedCompanies([demo.company])
    setSelectedCompanyId(demo.company.company_id)
    setSelectedRankingType(demo.typeName)
    setRankingCompanies(demo.rankings)
    setGlobalRankingCompanies(demo.rankings)
    setRankingsUpdatedAt(new Date().toISOString())
    setRankingError("")
    setError("")
    setActiveView("overview")
    setShowCompanySelector(false)
  }

  function exitDemo() { signOut() }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setDemoMode(false)
    setError("")
    if (!apiKey.trim()) { setError("Enter your limited-access Torn API key to continue."); return }
    setLoading(true)
    try {
      const response = await fetch(`${API_BASE}/api/auth/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim(), secondaryCompanyKey: secondaryCompanyKey.trim() }),
      })
      const payload = await response.json() as { error?: string; token?: string; player?: { id: string; name: string }; key?: { saved: boolean }; company?: { isDirector?: boolean; key?: { saved?: boolean }; needsSecondaryKey?: boolean } }
      if (!response.ok) throw new Error(payload.error || "Sign-in failed. Check that your Torn key is valid and has limited permissions.")
      if (!payload.token) throw new Error("The sign-in service did not return a session. Please try again.")
      sessionStorage.setItem("ncd_session", payload.token)
      setSessionToken(payload.token)
      setPlayerName(payload.player?.name || "Torn member")
      setPlayerId(payload.player?.id || "")
      setKeySaved(payload.key?.saved ?? true)
      setIsDirector(payload.company?.isDirector ?? false)
      setCompanyKeySaved(payload.company?.key?.saved ?? false)
      setNeedsSecondaryKey(payload.company?.needsSecondaryKey ?? !(payload.company?.key?.saved ?? false))
      setApiKey("")
      setSecondaryCompanyKey("")
      const listResponse = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${payload.token}` } })
      let companies: SavedCompany[] = []
      if (listResponse.ok) {
        const list = await listResponse.json() as { companies: SavedCompany[] }
        companies = list.companies || []
        setSavedCompanies(companies)
      }
      if (companies.length) {
        const company = companies[0]
        setSelectedCompanyId(company.company_id)
        let companyResponse = await fetch(`${API_BASE}/api/me/companies/${company.company_id}`, { headers: { Authorization: `Bearer ${payload.token}` } })
        if (!companyResponse.ok) companyResponse = await fetch(`${API_BASE}/api/company/refresh`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${payload.token}` }, body: JSON.stringify({ companyId: company.company_id }) })
        if (companyResponse.ok) {
          const data = await companyResponse.json() as { profile: unknown; employees: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[]; companyId?: string | number }
          const normalized = runEngine(data.profile, data.employees, catalog)
          if (normalized) {
            setResult({ profile: data.profile, employees: data.employees, stock: data.stock, incomeHistory: data.incomeHistory, model: normalized })
            setSelectedCompanyId(String(data.companyId ?? normalized.company.id))
            setSelectedRankingType(normalized.company.typeName)
          }
          const refreshedList = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${payload.token}` } })
          if (refreshedList.ok) { const saved = await refreshedList.json() as { companies: SavedCompany[] }; setSavedCompanies(saved.companies || []) }
        }
      } else if (payload.company?.key?.saved) {
        const companyResponse = await fetch(`${API_BASE}/api/company/refresh`, { method: "POST", headers: { Authorization: `Bearer ${payload.token}` } })
        if (companyResponse.ok) {
          const data = await companyResponse.json() as { profile: unknown; employees: unknown; stock?: unknown; companyId?: string | number; incomeHistory?: IncomeSnapshot[] }
          const normalized = runEngine(data.profile, data.employees, catalog)
          if (normalized) { setResult({ profile: data.profile, employees: data.employees, stock: data.stock, incomeHistory: data.incomeHistory, model: normalized }); setSelectedCompanyId(String(data.companyId ?? normalized.company.id)); setSelectedRankingType(normalized.company.typeName) }
          const refreshedList = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${payload.token}` } })
          if (refreshedList.ok) { const saved = await refreshedList.json() as { companies: SavedCompany[] }; setSavedCompanies(saved.companies || []) }
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.")
    } finally { setLoading(false) }
  }

  function signOut() {
    sessionStorage.removeItem("ncd_session")
    setDemoMode(false)
    setSessionToken("")
    setPlayerName("")
    setPlayerId("")
    setSelectedCompanyId("")
    setShowCompanySelector(false)
    setKeySaved(false)
    setCompanyKeySaved(false)
    setNeedsSecondaryKey(false)
    setIsDirector(false)
    setSecondaryCompanyKey("")
    setSavedCompanies([])
    setResult(null)
    setRankingCompanies([])
    setGlobalRankingCompanies([])
    setRankingsUpdatedAt("")
    setRankingError("")
    setApiKey("")
    setActiveView("overview")
  }

  async function connectCompany(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (demoMode) { setError("Live Torn connections are disabled in the demo workspace. Exit demo to connect real data."); return }
    setError("")
    if (!sessionToken && !apiKey.trim()) { setError("Sign in with your Torn API key to create your player workspace."); return }
    setLoading(true)
    try {
      let token = sessionToken
      let targetCompanyId = selectedCompanyId
      if (secondaryCompanyKey.trim()) {
        if (!token) throw new Error("Sign in with your primary Torn API key first.")
        const keyResponse = await fetch(`${API_BASE}/api/auth/company-key`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ apiKey: secondaryCompanyKey.trim() }) })
        const keyPayload = await keyResponse.json() as { error?: string; saved?: boolean; companyId?: string | number }
        if (!keyResponse.ok) throw new Error(keyPayload.error || "Could not save the authorized company key.")
        targetCompanyId = String(keyPayload.companyId ?? "")
        setCompanyKeySaved(true)
        setNeedsSecondaryKey(false)
        setSecondaryCompanyKey("")
      }
      if (!token) throw new Error("Sign in with a Torn API key first.")
      const response = await fetch(`${API_BASE}/api/company/refresh`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: targetCompanyId ? JSON.stringify({ companyId: targetCompanyId }) : "{}" })
      const payload = await response.json() as { error?: string; profile?: unknown; employees?: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[] }
      if (!response.ok) throw new Error(payload.error || "The API request failed. Check the key and its company-data permissions.")
      const normalized = runEngine(payload.profile, payload.employees, catalog)
      if (!normalized) throw new Error("Torn returned an unexpected company profile. The response was not added to your saved workspace.")
      setResult({ profile: payload.profile, employees: payload.employees, stock: payload.stock, incomeHistory: payload.incomeHistory, model: normalized })
      setSelectedRankingType(normalized.company.typeName)
      setSelectedCompanyId(String(normalized.company.id))
      setShowCompanySelector(false)
      setActiveView("overview")
      const listResponse = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${token}` } })
      if (listResponse.ok) { const list = await listResponse.json() as { companies: SavedCompany[] }; setSavedCompanies(list.companies || []) }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect to the Torn API.") }
    finally { setLoading(false) }
  }

  if (authChecking) return <div className="login-screen"><div className="login-card login-loading"><span className="brand-mark">NC</span><p>Checking your member session…</p></div></div>

  if (!sessionToken && !demoMode) return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand"><span className="brand-mark">NC</span><span><strong>NAUGHTY</strong><small>COMPANY OPERATIONS</small></span></div>
        <div className="login-eyebrow"><span className="eyebrow-line" /> FACTION MEMBER ACCESS</div>
        <h1 id="login-title">Naughty Company Dashboard</h1>
        <p className="login-subtitle">A private operations workspace for members of <strong>Naughty Souls</strong>.</p>
        <div className="member-notice"><span>◆</span><p><strong>Naughty Souls members only</strong><br />Sign in with your own limited-access Torn API key. Use the minimum permissions needed for the company data you are authorized to view.</p></div>
        <form className="login-form" onSubmit={signIn}>
          <label htmlFor="login-api-key">Limited-access Torn API key</label>
          <input id="login-api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste your Torn API key" required />
          <p className="login-hint">Your key is sent securely to the dashboard API for validation. It is never stored in this browser's local storage.</p>
          <p className="login-hint">Your login key will be checked for company access first. A secondary company key is only needed if Torn does not allow company data access with your login key.</p>
          {error && <div className={`error-banner${error.startsWith("ACCESS DENIED:") ? " access-denied-banner" : ""}`} role="alert">{error.startsWith("ACCESS DENIED:") && <strong>ACCESS DENIED · NAUGHTY SOULS MEMBERSHIP REQUIRED</strong>}{error.startsWith("ACCESS DENIED:") && <br />}{error}</div>}
          <button className="primary-button form-submit" disabled={loading}>{loading ? <><span className="spinner" /> Verifying key…</> : <>Sign in securely <span>→</span></>}</button>
        </form>
        <button className="login-demo-button" type="button" onClick={startDemo} disabled={loading}>Explore the demo dashboard <span>→</span></button>
        <p className="login-hint demo-caption">No Torn key needed. The demo uses fictional data and never contacts Torn.</p>
        <div className="policy-block"><strong>Data & API policy</strong><p>Use only a key you own and keep its access limited. The dashboard requests Torn data available to that key, which may include company and employee details, and stores retrieved company records to support your workspace. Saved keys are intended to be encrypted at rest; deleting a key does not delete previously saved company records. Data is for Naughty Souls faction operations only. Do not submit another player's key or use data you are not authorized to access.</p></div>
        <div className="login-footer"><span>NAUGHTY COMPANY DASHBOARD</span><span>TORN API · CLOUDFLARE</span></div>
      </section>
    </main>
  )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setActiveView("overview") }}>
          <span className="brand-mark">NC</span>
          <span><strong>NAUGHTY</strong><small>COMPANY OPERATIONS</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          <button className={activeView === "overview" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("overview")}><span>◫</span> Overview</button>
          <button className={activeView === "employees" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("employees")}><span>♙</span> Employees</button>
          <button className={activeView === "catalog" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("catalog")}><span>▦</span> Position catalog <em>{companyNames.length}</em></button>
          <button className={activeView === "type-rankings" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("type-rankings")}><span>↗</span> Company rankings</button>
          <button className={activeView === "faction-rankings" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("faction-rankings")}><span>♜</span> Faction rankings</button>
          <button className={activeView === "charts" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("charts")}><span>⌁</span> Compare graphs</button>
          <button className={activeView === "connect" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("connect")}><span>↔</span> Connect Torn API</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-indicator"><span className={result ? "status-dot live" : "status-dot"} />{demoMode ? "Demo workspace · sample data" : keySaved ? `Signed in${playerName ? ` as ${playerName}` : ""}` : "Player signed in · key deleted"}</div><button className="signout-button" onClick={demoMode ? exitDemo : signOut}>{demoMode ? "Exit demo" : "Sign out"}</button>
          <div className="sidebar-foot">EARLY ACCESS <span>•</span> BUILD 0.2</div>
        </div>
      </aside>

      <main className="main-area">
        {demoMode && <div className="demo-banner"><strong>DEMO MODE</strong><span>All player, company, employee and income data below is fictional. Live Torn connections are disabled.</span><button type="button" onClick={exitDemo}>Exit demo ×</button></div>}
        <header className="topbar">
          <div className="breadcrumbs">Workspace <span>/</span> <strong>{activeView === "overview" ? "Overview" : activeView === "employees" ? "Employees" : activeView === "catalog" ? "Position catalog" : activeView === "type-rankings" ? "Company rankings" : activeView === "faction-rankings" ? "Faction rankings" : activeView === "charts" ? "Compare graphs" : "Connect Torn API"}</strong></div>
          <div className="topbar-right"><span className="environment-pill"><i /> {demoMode ? "DEMO DATA" : "CLOUDFLARE WORKER"}</span><div className="user-company-switcher"><button className="user-company-trigger" type="button" aria-expanded={showCompanySelector} onClick={() => setShowCompanySelector((open) => !open)}><span className="avatar">{playerName.slice(0, 2).toUpperCase() || "NC"}</span><span className="user-company-label"><strong>{playerName || "Connected user"}</strong><small>Torn ID {playerId || "—"} · {result?.model.company.name || "No company loaded"} · {result?.model.company.typeName || "No company type"}</small></span><span className="switch-chevron">⌄</span></button>{showCompanySelector && <div className="company-switcher-menu"><strong>Choose a company</strong>{savedCompanies.length ? savedCompanies.map((company) => <button key={company.company_id} type="button" className={selectedCompanyId === company.company_id ? "company-switcher-option selected" : "company-switcher-option"} onClick={() => void loadSavedCompany(company.company_id)}><span>{company.company_name || `Company #${company.company_id}`}</span><small>{company.company_type || "Company"} · #{company.company_id}</small></button>) : <p>No saved companies yet. Connect a company key to add one.</p>}</div>}</div></div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div><div className="eyebrow"><span className="eyebrow-line" /> COMPANY INTELLIGENCE</div><h1>{activeView === "overview" ? "Company overview" : activeView === "employees" ? "Employee operations" : activeView === "catalog" ? "Position catalog" : activeView === "type-rankings" ? "Company type rankings" : activeView === "faction-rankings" ? "Faction company rankings" : activeView === "charts" ? "Income & stock comparison" : "Connect your company"}</h1><p className="subtitle">{activeView === "overview" ? "A focused view of company performance, income, and star-level progress." : activeView === "employees" ? "Employee details, role fit, and position projections in one dedicated workspace." : activeView === "catalog" ? "Explore role requirements across the Torn company ecosystem." : activeView === "type-rankings" ? "Compare companies within the same Torn company type, ranked by weekly income." : activeView === "faction-rankings" ? "See all confirmed faction directors, including members who do not use this dashboard." : activeView === "charts" ? "Compare saved daily income trends and available stock snapshots against another faction director." : "Pull live company data through your secure API connection."}</p></div>
            <button className="primary-button" onClick={() => setActiveView("connect")}><span>＋</span> Connect company</button>
          </section>

          {activeView === "type-rankings" || activeView === "faction-rankings" ? (
            <section className="panel ranking-panel">
              <div className="panel-heading ranking-heading"><div><h2>{activeView === "type-rankings" ? "Rank within company type" : "Faction directors by company type"}</h2><p>{activeView === "type-rankings" ? "Companies matching the connected company type, ranked by weekly income." : "Confirmed directors from the faction roster, whether or not they use this dashboard. Select Compare to open income and stock graphs."}</p></div>{activeView === "type-rankings" ? <span className="count-chip">{selectedRankingType || "Connected company type"}</span> : <button className="secondary-button" onClick={() => void refreshFactionDirectory()} disabled={factionSyncing}>{factionSyncing ? "Checking members…" : "Refresh faction data"}</button>}</div>
              <div className="ranking-meta"><span><i className="status-dot live" /> {rankingRows.length.toLocaleString()} {activeView === "type-rankings" ? "companies in your connected company type" : "faction directors in your company type"}</span><span>Data refresh: daily at 18:05 UTC · Star ratings update Sundays after 18:00 UTC</span></div>
              {rankingError && <div className="error-banner" role="alert">{rankingError}</div>}
              <div className="table-scroll"><table className="ranking-table"><thead><tr><th>RANK</th><th>COMPANY</th>{activeView === "faction-rankings" && <th>DIRECTOR</th>}{activeView === "faction-rankings" && <th>COMPARE</th>}<th>STARS</th><th>TYPE + STAR PLACE</th><th>TYPE PLACE</th><th>WEEKLY INCOME</th><th>DAILY INCOME</th><th>AVG / DAY</th><th>DATA AS OF (UTC)</th></tr></thead><tbody>{rankingRows.map((company, index) => <tr key={`${company.playerId}-${company.companyId}`}><td><span className={`rank-number $(company.weeklyIncome !== null && rankingRows.findIndex((row) => row.weeklyIncome === company.weeklyIncome) < 3) ? "top-rank" : ""}`}>{company.weeklyIncome === null ? "—" : rankingRows.findIndex((row) => row.weeklyIncome === company.weeklyIncome) + 1}</span></td><td><strong>{company.companyName}</strong><div className="muted">Company #{company.companyId}</div></td>{activeView === "faction-rankings" && <td>{company.directorName}</td>}{activeView === "faction-rankings" && <td><button className="text-button compare-row-button" onClick={() => { setSelectedComparePlayerId(company.playerId); setActiveView("charts") }}>Compare ↗</button></td>}<td><span className="star-rating">{company.starRating === null ? "—" : `${company.starRating} ★`}</span></td><td>{placement(company, "stars")}</td><td>{placement(company, "type")}</td><td className="income-primary">{formatMoney(company.weeklyIncome)}</td><td>{formatMoney(company.dailyIncome)}</td><td>{formatMoney(company.averageDailyIncome)}</td><td className="muted">{company.fetchedAt ? new Date(company.fetchedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}</td></tr>)}</tbody></table></div>
              {rankingRows.length === 0 && <div className="empty-state">{activeView === "type-rankings" ? "No companies were returned for your connected company type." : "No faction directors have been discovered yet. Refresh faction data to process the next batch of member IDs."}</div>}{activeView === "faction-rankings" && factionSyncPending > 0 && <div className="ranking-footnote"><p>{factionSyncPending} faction members are still queued for director checks. Refresh again to process another batch.</p></div>}
              <div className="ranking-footnote"><strong>How ranking works</strong><p>Rank is determined exclusively by weekly income, highest first. Average daily income is weekly income divided by seven. Company Rankings is filtered to your connected company type. Faction Rankings includes confirmed faction directors whether or not they use the dashboard, filtered to the connected company type.</p><p>{rankingsUpdatedAt ? `${activeView === "type-rankings" ? "Torn snapshot retrieved" : "Faction leaderboard checked"} ${new Date(rankingsUpdatedAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}.` : "Leaderboard refreshes from saved company profiles."} Daily company income data locks at 18:00 UTC; star-rating changes lock on Sundays at 18:00 UTC.</p></div>
            </section>
          ) : activeView === "charts" ? (
            <div className="charts-workspace">
              <section className="panel compare-picker"><div className="panel-heading"><div><h2>Choose a faction director</h2><p>Compare your connected company against a confirmed director from the faction roster.</p></div></div><div className="compare-picker-row"><label htmlFor="compare-director">Faction member / director</label><select id="compare-director" value={selectedComparePlayerId} onChange={(event) => setSelectedComparePlayerId(event.target.value)}><option value="">Select a director…</option>{factionDirectors.filter((director) => String(director.playerId) !== String(playerId)).map((director) => <option key={director.playerId} value={director.playerId}>{director.directorName} · {director.companyName} ({director.companyType || "Unknown type"})</option>)}</select><button className="secondary-button" onClick={() => void refreshFactionDirectory()} disabled={factionSyncing}>{factionSyncing ? "Refreshing…" : "Refresh directory"}</button></div>{compareError && <div className="error-banner" role="alert">{compareError}</div>}{compareData && <div className="compare-summary"><div><small>SELECTED DIRECTOR</small><strong>{compareData.director.directorName}</strong></div><div><small>COMPANY</small><strong>{compareData.director.companyName}</strong></div><div><small>TYPE / RATING</small><strong>{compareData.director.companyType || "Unknown"} · {compareData.director.starRating ?? "—"} ★</strong></div><div><small>WEEKLY INCOME</small><strong>{formatMoney(compareData.director.weeklyIncome)}</strong></div></div>}</section>
              <LineChart title="Daily company income" money series={[{label:"Your company",values:(ownCompareData?.history.length ? ownCompareData.history.map((point)=>({label:point.day,value:point.dailyIncome})) : (result?.incomeHistory || []).map((point)=>({label:new Date(point.fetchedAt).toISOString().slice(0,10),value:point.dailyIncome})))},{label:compareData?.director.directorName || "Selected director",values:(compareData?.history || []).map((point)=>({label:point.day,value:point.dailyIncome}))}]} />
              <LineChart title="Weekly company income" money series={[{label:"Your company",values:(ownCompareData?.history || []).map((point)=>({label:point.day,value:point.weeklyIncome}))},{label:compareData?.director.directorName || "Selected director",values:(compareData?.history || []).map((point)=>({label:point.day,value:point.weeklyIncome}))}]} />
              <LineChart title="Stock inventory cost value" money series={[{label:"Your company",values:(ownCompareData?.history || []).map((point)=>({label:point.day,value:stockInventoryValue(point.stock)}))},{label:compareData?.director.directorName || "Selected director",values:(compareData?.history || []).map((point)=>({label:point.day,value:stockInventoryValue(point.stock)}))}]} />
              <div className="ranking-footnote"><strong>Data availability</strong><p>Income and company type/rating come from Torn's public company profile. Torn's current OpenAPI defines company stock for the authenticated company only, not a public company-ID stock endpoint. Stock comparisons therefore appear only where a director has connected an authorized company key and stock snapshots have been collected. Historical graphs build from the time the dashboard begins saving daily snapshots.</p></div>
            </div>
          ) : activeView === "employees" ? (
            <section className="panel employee-page-panel">
              <div className="panel-heading"><div><h2>Employee details & position fit</h2><p>Work stats, role configuration matches, and requirement gaps are kept off the company overview.</p></div><span className="count-chip">{model ? model.employees.length : 0} employees</span></div>
              {model ? <><div className="employee-summary-strip"><span><small>ROLE MATCHES</small><strong>{model.matchedPositionCount}</strong></span><span><small>MEET REQUIREMENTS</small><strong>{model.employeesMeetingRequirements}</strong></span><span><small>BELOW REQUIREMENTS</small><strong>{model.employeesBelowRequirements}</strong></span><span><small>RESTRICTED STATS</small><strong>{model.employeesWithUnknownFit}</strong></span></div><div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>POSITION</th><th>WORK STATS</th><th>ROLE FIT</th><th>PRIMARY TARGET</th><th>SECONDARY TARGET</th><th>SPECIALTY</th><th>PRIMARY GAP</th><th>SECONDARY GAP</th><th>EFFECTIVENESS</th><th>WAGE</th><th>DAYS IN COMPANY</th></tr></thead><tbody>{model.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name}</strong><div className="muted">#{employee.id}</div></td><td>{employee.positionName}</td><td>{employee.stats ? `MAN ${formatNumber(employee.stats.MAN)} · INT ${formatNumber(employee.stats.INT)} · END ${formatNumber(employee.stats.END)}` : <span className="muted">Restricted</span>}</td><td><span className={`fit-chip ${employee.fit}`}>{employee.fit === "meets" ? "Meets" : employee.fit === "below" ? "Below minimum" : employee.fit === "unknown" ? "Stats hidden" : "Unmapped"}</span></td><td>{employee.requirement ? `${employee.requirement.primary} ${formatNumber(employee.requirement.primaryMin)}` : "—"}</td><td>{employee.requirement ? `${employee.requirement.secondary} ${formatNumber(employee.requirement.secondaryMin)}` : "—"}</td><td>{employee.requirement?.special ?? "—"}</td><td>{formatNumber(employee.primaryGap)}</td><td>{formatNumber(employee.secondaryGap)}</td><td>{employee.effectiveness === null ? "—" : `${employee.effectiveness}%`}</td><td>{formatMoney(employee.wage)}</td><td>{formatNumber(employee.daysInCompany)}</td></tr>)}</tbody></table></div>{model.employees.length === 0 && <div className="empty-state">The API returned no employees for this company.</div>}{showRaw && <div className="raw-data"><h3>Profile response</h3><pre>{pretty(result?.profile)}</pre><h3>Employee response</h3><pre>{pretty(result?.employees)}</pre></div>}<div className="employee-heading"><div><h3>Position configurations</h3><p>Reference minimums for this company type are maintained in the position catalog.</p></div><button className="text-button" onClick={() => setActiveView("catalog")}>Open position catalog ↗</button></div></> : <div className="empty-state">Connect a company to see employee details and position projections.</div>}
            </section>
          ) : activeView === "catalog" ? (
            <section className="panel catalog-panel">
              <div className="panel-heading"><div><h2>Company role library</h2><p>{companyNames.length} company types · position requirements reference</p></div><div className="search-wrap"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search company types..." /></div></div>
              <div className="company-grid">{filteredCompanies.map((name) => <button key={name} className={selectedCompany === name ? "company-card selected" : "company-card"} onClick={() => setSelectedCompany(name)}><span className="company-glyph">{name.slice(0, 1)}</span><span className="company-card-copy"><strong>{name}</strong><small>{catalog.companies[name].length} defined roles</small></span><span className="card-arrow">↗</span></button>)}</div>
              {filteredCompanies.length === 0 && <div className="empty-state">No company types match that search.</div>}
              <div className="role-detail"><div className="role-title"><div><span className="eyebrow">SELECTED COMPANY</span><h3>{selectedCompany}</h3></div><span className="count-chip">{positions.length} positions</span></div><div className="table-scroll"><table><thead><tr><th>ROLE</th><th>PRIMARY STAT</th><th>PRIMARY MIN.</th><th>SECONDARY STAT</th><th>SECONDARY MIN.</th><th>SPECIALTY</th></tr></thead><tbody>{positions.map((position, index) => <tr key={position.rank + index}><td><strong>{position.rank}</strong></td><td><span className="stat-chip">{position.primary}</span></td><td>{position.primaryMin.toLocaleString()}</td><td><span className="stat-chip">{position.secondary}</span></td><td>{position.secondaryMin.toLocaleString()}</td><td>{position.special ? <span className="special-chip">{position.special}</span> : <span className="muted">None</span>}</td></tr>)}</tbody></table></div></div>
            </section>
          ) : activeView === "connect" ? (
            <section className="connect-layout">
              <div className="panel connect-panel"><div className="panel-heading"><div><h2>Connect to Torn</h2><p>Add an authorized key for each company you manage, including companies where you are the appointed director</p></div><span className="big-icon">⌁</span></div><form onSubmit={connectCompany}><label htmlFor="company-key">{needsSecondaryKey ? "First company API key" : "Add another company API key"}</label><input id="company-key" type="password" autoComplete="off" value={secondaryCompanyKey} onChange={(event) => setSecondaryCompanyKey(event.target.value)} placeholder={demoMode ? "Disabled in demo mode" : "Paste an authorized API key for a company you are permitted to manage"} disabled={demoMode} /><p className="field-hint"><span>♢</span> "Each key is validated for company profile and employee access, then saved against that company. Only add keys you have permission to use."</p>{error && <div className={`error-banner${error.startsWith("ACCESS DENIED:") ? " access-denied-banner" : ""}`} role="alert">{error.startsWith("ACCESS DENIED:") && <strong>ACCESS DENIED · NAUGHTY SOULS MEMBERSHIP REQUIRED</strong>}{error.startsWith("ACCESS DENIED:") && <br />}{error}</div>}{demoMode && <p className="demo-caption">This tutorial workspace is read-only. Exit demo to connect real Torn data.</p>}<button className="primary-button form-submit" disabled={loading || demoMode}>{loading ? <><span className="spinner" /> Connecting...</> : <>Fetch company data <span>↗</span></>}</button></form>{sessionToken && <div className="key-store-panel"><div><strong>{keySaved ? "Torn API key saved" : "No Torn API key saved"}</strong><p>"Company keys are encrypted and stored separately, so adding another company does not replace your other saved company keys."</p></div>{(keySaved || companyKeySaved) && <button className="text-button danger-text" type="button" onClick={deleteSavedKey}>Permanently delete saved keys</button>}{savedCompanies.length > 0 && <div className="saved-company-list"><strong>Saved company records</strong>{savedCompanies.map((company) => <button key={company.company_id} type="button" className="saved-company-link" onClick={() => void loadSavedCompany(company.company_id)}>{company.company_name || `Company #${company.company_id}`} <span>#{company.company_id}</span></button>)}</div>}</div>}</div>
              <div className="panel guide-panel"><span className="guide-icon">✳</span><h2>Before you connect</h2><ul><li>Use a Torn API key with the access needed for your company.</li><li>Private employee stats may only be available to authorized company directors.</li><li>Requests pass through the Cloudflare Worker to Torn's API.</li></ul><div className="guide-note"><strong>Privacy by design</strong><p>Your player account is identified by Torn. Deleting the saved key does not delete recorded company data.</p></div></div>
            </section>
          ) : (
            <>
              {model ? <>
                <section className="panel company-panel company-overview-panel"><div className="panel-heading"><div><h2>{model.company.name}</h2><p>{model.company.typeName} · Company #{model.company.id}</p></div><span className="status-badge success"><i /> COMPANY DATA</span></div>
                  <div className="company-facts overview-facts"><div><small>COMPANY TYPE</small><strong>{model.company.typeName}</strong></div><div><small>EMPLOYEES</small><strong>{formatNumber(model.company.employeesHired ?? model.employees.length)} / {formatNumber(model.company.employeeCapacity)}</strong></div><div><small>STAR RATING</small><strong>{currentStar === null ? "—" : `${currentStar} ★`}</strong></div><div><small>DIRECTOR</small><strong>{model.company.directorName ?? "Restricted"}</strong></div></div>
                  <div className="income-grid"><article><small>DAILY INCOME</small><strong>{formatMoney(model.company.dailyIncome)}</strong><span className="profit-line">Profit {formatMoney(dailyProfit)}</span></article><article><small>WEEKLY INCOME</small><strong>{formatMoney(weeklyIncome)}</strong><span className="profit-line">Profit {formatMoney(weeklyProfit)}</span><span>Sunday 18:00 UTC to Sunday 18:00 UTC</span></article><article><small>MONTH-TO-DATE INCOME</small><strong>{formatMoney(monthlyIncome)}</strong><span className="profit-line">Profit {formatMoney(monthlyProfit)}</span><span>Since the 1st at 18:00 UTC</span></article></div>{costs && <p className="profit-footnote">Estimated daily costs: {formatMoney(costs.adBudget)} ad budget + {formatMoney(costs.wages)} employee wages + {formatMoney(costs.stockCosts)} identified stock costs.</p>}
                  <div className="ratings-section"><div className="section-heading"><div><h3>Operating ratings</h3><p>Current company performance indicators from Torn.</p></div></div><div className="ratings-grid"><div><span>POPULARITY</span><strong>{formatNumber(popularity)}</strong></div><div><span>EFFICIENCY</span><strong>{formatNumber(efficiency)}</strong></div><div><span>ENVIRONMENT</span><strong>{formatNumber(environment)}</strong></div></div></div>
                  <div className="employee-heading overview-actions"><div><h3>Company health scorecard</h3><p>Benchmarked against companies of the same type.</p></div><button className="text-button" onClick={() => setActiveView("type-rankings")}>View rankings ↗</button></div>
                  <div className="health-grid"><div><small>TYPE + STAR PLACE</small><strong>{currentRankingCompany ? placement(currentRankingCompany, "stars") : "—"}</strong><span>Same company type and star level</span></div><div><small>WEEKLY INCOME VS TYPE</small><strong>{currentRankingCompany && currentRankingCompany.weeklyIncome !== null ? formatMoney(currentRankingCompany.weeklyIncome) : formatMoney(currentWeeklyIncome)}</strong><span>{companyPeerRows.length ? `${companyPeerRows.length} same-type companies in snapshot` : "Comparison snapshot unavailable"}</span></div><div><small>GAP TO NEXT STAR</small><strong>{nextStarGap === null ? "—" : formatMoney(nextStarGap)}</strong><span>{nextStarIncome === null ? "No higher-star benchmark available" : `Observed next-level benchmark: ${formatMoney(nextStarIncome)}/week`}</span></div><div><small>GAP TO PREVIOUS STAR</small><strong>{previousStarGap === null ? "—" : formatMoney(previousStarGap)}</strong><span>{previousStarIncome === null ? "No lower-star benchmark available" : `Observed previous-level benchmark: ${formatMoney(previousStarIncome)}/week`}</span></div></div>
                  <div className="overview-bottom-actions"><button className="secondary-button" onClick={() => setActiveView("employees")}>Open employee details <span>→</span></button><button className="text-button" onClick={() => setShowRaw((current) => !current)}>{showRaw ? "Hide raw API data" : "Inspect API data"}</button></div>{showRaw && <div className="raw-data"><h3>Profile response</h3><pre>{pretty(result?.profile)}</pre></div>}
                </section>
              </> : <section className="panel company-panel"><div className="empty-company"><div className="empty-illustration"><div className="empty-ring ring-one" /><div className="empty-ring ring-two" /><div className="empty-center">NC</div><span className="float-star star-one">✳</span><span className="float-star star-two">✦</span></div><h3>Your company workspace is ready.</h3><p>Connect your Torn company to see its details, income, operating ratings, and competitive health scorecard.</p><button className="secondary-button" onClick={() => setActiveView("connect")}>Connect company <span>→</span></button></div></section>}
              <section className="content-grid overview-quick-grid"><article className="panel quick-panel"><div className="panel-heading"><div><h2>Company tools</h2><p>Open a focused workspace when you need more detail.</p></div></div><button className="quick-link" onClick={() => setActiveView("employees")}><span className="quick-icon violet">♙</span><span><strong>Employee operations</strong><small>Role fit, work stats, wages, and requirement gaps</small></span><b>→</b></button><button className="quick-link" onClick={() => setActiveView("catalog")}><span className="quick-icon blue">▦</span><span><strong>Position catalog</strong><small>Reference role requirements by company type</small></span><b>→</b></button></article></section>
            </>
          )}
          <footer className="page-footer"><span>NAUGHTY COMPANY DASHBOARD <b>•</b> DEVELOPMENT BUILD</span><span>POWERED BY TORN API & CLOUDFLARE</span></footer>
        </div>
      </main>
    </div>
  )
}
