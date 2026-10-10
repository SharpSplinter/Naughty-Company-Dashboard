import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import positionsData from "../../lib/company/positions.json"
import { runEngine } from "../../lib/company/engine"
import type { CompanyDashboardModel, CompanyPositionCatalog } from "../../lib/company/types"
import { buildChartSeriesFor, LineChart } from "./chart-utils"
import type { ChartSeries, SnapshotHistoryCompany, SnapshotMetric } from "./chart-utils"
import { createDemoData } from "./demo-data"
import { placement } from "./ranking-utils"
import { AdminPanel } from "./admin-panel"
import { InsightsWorkspace } from "./insights-workspace"
import { AlertsPanel, NotificationSettingsPanel } from "./alerts-panel"
import { companyTypeIdFromProfile, financialCosts, formatMoney, formatNumber, getObject, pretty, stockPriceRows } from "./financial-utils"

const catalog = positionsData as CompanyPositionCatalog
const companyNames = Object.keys(catalog.companies).sort()

function formatLastSeenElapsed(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0) return "Last seen time unavailable"
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp * 1000) / 60000))
  const days = Math.floor(elapsedMinutes / 1440)
  const hours = Math.floor((elapsedMinutes % 1440) / 60)
  const minutes = elapsedMinutes % 60
  const parts = [
    ...(days ? [`${days} day${days === 1 ? "" : "s"}`] : []),
    ...(hours ? [`${hours} hour${hours === 1 ? "" : "s"}`] : []),
    `${minutes} minute${minutes === 1 ? "" : "s"}`,
  ]
  return `Last seen ${parts.join(" ")} ago`
}
const dashboardViews = ["overview", "employees", "catalog", "dashboard-members", "connect", "type-rankings", "faction-rankings", "charts", "data-transfer", "data-sharing", "executive", "health", "trends", "member-insights", "roster-insights", "performance-insights", "layout", "alerts", "admin"] as const
type DashboardView = typeof dashboardViews[number]
type DashboardPreferences = { density: "comfortable" | "compact"; contentWidth: "standard" | "wide" }
const DEFAULT_DASHBOARD_PREFERENCES: DashboardPreferences = { density: "comfortable", contentWidth: "standard" }
type TransferPageKey = "company" | "employees" | "charts" | "rankings" | "references" | "settings" | "master"
const transferPages: { key: TransferPageKey; title: string; description: string }[] = [
  { key: "company", title: "Company Details", description: "Saved company profiles, income, and financial context." },
  { key: "employees", title: "Employees", description: "Employee records, work stats, positions, effectiveness, and wages." },
  { key: "charts", title: "Trends & Charts", description: "Import or export the legacy company history JSON archive." },
  { key: "rankings", title: "Rankings", description: "Your saved ranking-page data and comparison context." },
  { key: "references", title: "References", description: "Position catalog and role requirement reference data." },
  { key: "settings", title: "Settings", description: "Dashboard connection and saved settings." },
]
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
  || "https://naughty-company-api.kboone801.workers.dev"

type IncomeSnapshot = { fetchedAt: string; dailyIncome: number | null }
type ApiResult = { model: CompanyDashboardModel; profile: unknown; employees: unknown; stock?: unknown; incomeHistory?: IncomeSnapshot[] }
type SavedCompany = { company_id: string; company_name: string | null; company_type: string | null; fetched_at: string; has_api_key?: boolean; key_last_four?: string | null; key_updated_at?: string | null }
type RankingCompany = { companyId: string; companyName: string; companyType: string; companyTypeId: number | string | null; starRating: number | null; weeklyIncome: number | null; dailyIncome: number | null; averageDailyIncome: number | null; directorName: string; playerId: string; fetchedAt: string }
type FactionDirector = { playerId: string; directorName: string; companyId: string; companyName: string; companyType: string | null; companyTypeId: number | string | null; starRating: number | null; dailyIncome: number | null; weeklyIncome: number | null; fetchedAt: string }
type WeeklyStarCount = { starRating: number; companyCount: number }
type CompareHistoryPoint = { day: string; dailyIncome: number | null; weeklyIncome: number | null; dailyProfit: number | null; weeklyProfit?: number | null; stockQuantity: number | null; stock: unknown }
type CompareData = { director: FactionDirector; history: CompareHistoryPoint[]; stockHistoryAvailable: boolean }
type SharingKey = "shareFinancialData" | "shareEmployeeData" | "shareTrendData"
type SharingRecipient = { playerId: string; directorName: string; companyName: string | null; companyType: string | null; shareFinancialData: boolean; shareEmployeeData: boolean; shareTrendData: boolean }
type DashboardMember = { playerId: string; playerName: string; companyName: string | null; companyType: string | null; companyTypeId: number | string | null }
type SharedEmployee = { name?: string; position?: string; stats?: { MAN?: number; INT?: number; END?: number }; effectiveness?: number; wage?: number }
type SharedStockItem = { name?: string; quantity?: number; unitPrice?: number }
type SharedCompany = { playerId: string; directorName: string; companyId: string; companyName: string; companyType: string; companyTypeId: number | string | null; fetchedAt: string; shareFinancialData: boolean; shareEmployeeData: boolean; shareTrendData: boolean; adBudget?: number; employees?: SharedEmployee[]; stock?: SharedStockItem[] }



export function FloorApp() {
  const [activeView, setActiveView] = useState<DashboardView>(() => {
    try { const saved = sessionStorage.getItem("ncd_active_view"); if (saved && dashboardViews.includes(saved as DashboardView)) return saved as DashboardView } catch { /* Storage may be disabled. */ }
    return "overview"
  })
  const [openNavGroups, setOpenNavGroups] = useState<Record<string, boolean>>({ company: true, rankings: true, references: true, settings: true })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [dashboardPreferences, setDashboardPreferences] = useState<DashboardPreferences>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ncd_dashboard_preferences") || "null") as Partial<DashboardPreferences> | null
      return { density: saved?.density === "compact" ? "compact" : "comfortable", contentWidth: saved?.contentWidth === "wide" ? "wide" : "standard" }
    } catch { return DEFAULT_DASHBOARD_PREFERENCES }
  })
  const importInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferError, setTransferError] = useState("")
  const [transferNotice, setTransferNotice] = useState("")
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
  const [sessionActionBusy, setSessionActionBusy] = useState(false)
  const [companyKeyActionBusy, setCompanyKeyActionBusy] = useState("")
  const [authChecking, setAuthChecking] = useState(true)
  const [demoMode, setDemoMode] = useState(false)
  const [playerName, setPlayerName] = useState("")
  const [playerId, setPlayerId] = useState("")
  const [isAdmin, setIsAdmin] = useState(false)
  const [selectedCompanyId, setSelectedCompanyId] = useState("")
  const [showCompanySelector, setShowCompanySelector] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [savedCompanies, setSavedCompanies] = useState<SavedCompany[]>([])
  const [rankingCompanies, setRankingCompanies] = useState<RankingCompany[]>([])
  const [globalRankingCompanies, setGlobalRankingCompanies] = useState<RankingCompany[]>([])
  const [rankingsUpdatedAt, setRankingsUpdatedAt] = useState("")
  const [rankingError, setRankingError] = useState("")
  const [factionDirectors, setFactionDirectors] = useState<FactionDirector[]>([])
  const [weeklyStarCounts, setWeeklyStarCounts] = useState<WeeklyStarCount[]>([])
  const [weeklyStarCountsCapturedAt, setWeeklyStarCountsCapturedAt] = useState("")
  const [factionSyncPending, setFactionSyncPending] = useState(0)
  const [selectedComparePlayerId, setSelectedComparePlayerId] = useState("")
  const [compareData, setCompareData] = useState<CompareData | null>(null)
  const [ownCompareData, setOwnCompareData] = useState<CompareData | null>(null)
  const [compareError, setCompareError] = useState("")
  const [factionSyncing, setFactionSyncing] = useState(false)
  const [factionSyncProgress, setFactionSyncProgress] = useState("")
  const [selectedRankingType, setSelectedRankingType] = useState("")
  const [snapshotHistory, setSnapshotHistory] = useState<SnapshotHistoryCompany[]>([])
  const [snapshotSourceCreatedAt, setSnapshotSourceCreatedAt] = useState("")
  const [snapshotHistoryLoading, setSnapshotHistoryLoading] = useState(true)
  const [snapshotHistoryError, setSnapshotHistoryError] = useState("")
  const [sharingRecipients, setSharingRecipients] = useState<SharingRecipient[]>([])
  const [dashboardMembers, setDashboardMembers] = useState<DashboardMember[]>([])
  const [dashboardMembersLoading, setDashboardMembersLoading] = useState(false)
  const [dashboardMembersError, setDashboardMembersError] = useState("")
  const [sharingSettingsLoaded, setSharingSettingsLoaded] = useState(false)
  const [sharingSaving, setSharingSaving] = useState(false)
  const [sharingError, setSharingError] = useState("")
  const [sharingNotice, setSharingNotice] = useState("")
  const [sharedCompanies, setSharedCompanies] = useState<SharedCompany[]>([])
  const [employeeComparePlayerId, setEmployeeComparePlayerId] = useState("")

  useEffect(() => {
    try { sessionStorage.setItem("ncd_active_view", activeView) } catch { /* Storage may be disabled. */ }
  }, [activeView])

  const updateDashboardPreferences = useCallback((next: DashboardPreferences) => setDashboardPreferences(next), [])

  useEffect(() => {
    let cancelled = false
    async function loadImportedHistory() {
      try {
        const response = await fetch("/history/knotty-company-history.json")
        if (!response.ok) throw new Error("Could not load the imported company history file.")
        const payload = await response.json() as { sourceSnapshotCreatedAt?: string; companies?: SnapshotHistoryCompany[] }
        if (!cancelled) {
          setSnapshotHistory((current) => {
            const merged = new Map<string, SnapshotHistoryCompany>()
            for (const company of [...current, ...(payload.companies || [])]) {
              const key = String(company.companyId), previous = merged.get(key)
              if (!previous) { merged.set(key, company); continue }
              const points = new Map(previous.history.map((point) => [point.day, point]))
              for (const point of company.history) points.set(point.day, { ...points.get(point.day), ...point })
              merged.set(key, { ...previous, ...company, history: Array.from(points.values()).sort((a, b) => a.period - b.period) })
            }
            return Array.from(merged.values())
          })
          setSnapshotSourceCreatedAt((current) => current || payload.sourceSnapshotCreatedAt || "")
        }
      } catch (caught) {
        if (!cancelled) setSnapshotHistoryError(caught instanceof Error ? caught.message : "Could not load imported company history.")
      } finally {
        if (!cancelled) setSnapshotHistoryLoading(false)
      }
    }
    void loadImportedHistory()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const token = localStorage.getItem("ncd_session") || ""
    if (!token) { setAuthChecking(false); return }
    let cancelled = false
    async function restoreSession() {
      try {
        const response = await fetch(`${API_BASE}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error("Session expired")
        const session = await response.json() as { player: { id: string; name: string }; isAdmin?: boolean; key: { saved: boolean }; company?: { isDirector?: boolean; key?: { saved?: boolean }; needsSecondaryKey?: boolean } }
        if (cancelled) return
        setSessionToken(token)
        setPlayerName(session.player.name)
        setPlayerId(session.player.id)
        setIsAdmin(session.isAdmin === true && session.player.id === "351311")
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
        localStorage.removeItem("ncd_session")
      } finally {
        if (!cancelled) setAuthChecking(false)
      }
    }
    void restoreSession()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const adminOnlyViews = ["admin", "dashboard-members", "member-insights"]
    if (!authChecking && adminOnlyViews.includes(activeView) && (!isAdmin || demoMode)) setActiveView("overview")
  }, [authChecking, activeView, isAdmin, demoMode])

  useEffect(() => {
    if (!sessionToken) return
    let cancelled = false
    async function loadFactionDirectory() {
      try {
        const response = await fetch(`${API_BASE}/api/faction/directors`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; directors?: FactionDirector[]; pending?: number; generatedAt?: string; weeklyStarCounts?: WeeklyStarCount[]; weeklyStarCountsCapturedAt?: string }
        if (!response.ok) throw new Error(payload.error || "Could not load the faction director directory.")
        if (cancelled) return
        setFactionDirectors(payload.directors || [])
        setWeeklyStarCounts(payload.weeklyStarCounts || [])
        setWeeklyStarCountsCapturedAt(payload.weeklyStarCountsCapturedAt || "")
        setFactionSyncPending(payload.pending || 0)
        setRankingCompanies((payload.directors || []).map((director) => ({ companyId: String(director.companyId), companyName: director.companyName, companyType: director.companyType || "Unknown", companyTypeId: director.companyTypeId, starRating: director.starRating, weeklyIncome: director.weeklyIncome, dailyIncome: director.dailyIncome, averageDailyIncome: director.weeklyIncome === null ? null : director.weeklyIncome / 7, directorName: director.directorName, playerId: String(director.playerId), fetchedAt: director.fetchedAt })))
        setRankingsUpdatedAt(payload.generatedAt || "")
      } catch (caught) {
        if (!cancelled) setRankingError(caught instanceof Error ? caught.message : "Could not load the faction director directory.")
      }
    }
    void loadFactionDirectory()
    return () => { cancelled = true }
  }, [sessionToken])

  useEffect(() => {
    const current = result?.model
    if (!sessionToken || !current) return
    let cancelled = false
    async function loadGlobalRankings() {
      if (!current) return
      setRankingError("")
      try {
        // The Worker returns the shared server-side snapshot. Filter it client-side so
        // every company type can use the same cached dataset for accurate star ranks.
        const response = await fetch(`${API_BASE}/api/rankings?scope=global`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; companies?: RankingCompany[]; generatedAt?: string }
        if (!response.ok) throw new Error(payload.error || "Could not load company rankings.")
        if (cancelled) return
        const liveCompany: RankingCompany = {
          companyId: String(current.company.id), companyName: current.company.name,
          companyType: current.company.typeName, companyTypeId: companyTypeIdFromProfile(result?.profile) ?? current.company.typeId,
          starRating: current.company.rating, weeklyIncome: current.company.weeklyIncome, dailyIncome: current.company.dailyIncome,
          averageDailyIncome: current.company.weeklyIncome === null ? null : current.company.weeklyIncome / 7,
          directorName: current.company.directorName || playerName || "Current user", playerId: String(playerId), fetchedAt: current.fetchedAt,
        }
        const merged = [...(payload.companies || []).filter((company) => String(company.companyId) !== liveCompany.companyId), liveCompany]
          .sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1))
        setGlobalRankingCompanies(merged)
        setSelectedRankingType(current.company.typeName)
        setRankingsUpdatedAt(payload.generatedAt || "")
      } catch (caught) {
        if (!cancelled) setRankingError(caught instanceof Error ? caught.message : "Could not load company rankings.")
      }
    }
    void loadGlobalRankings()
    return () => { cancelled = true }
  }, [sessionToken, result?.model.company.id, result?.model.company.typeName, result?.model.company.weeklyIncome, result?.model.company.dailyIncome, result?.model.company.rating, result?.profile, playerId, playerName])

  useEffect(() => {
    if (!sessionToken || demoMode) { setDashboardMembers([]); return }
    let cancelled = false
    setDashboardMembersLoading(true)
    setDashboardMembersError("")
    async function loadDashboardMembers() {
      try {
        const response = await fetch(`${API_BASE}/api/dashboard-members`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; members?: DashboardMember[] }
        if (!response.ok) throw new Error(payload.error || "Could not load dashboard members.")
        if (!cancelled) setDashboardMembers(payload.members || [])
      } catch (caught) {
        if (!cancelled) setDashboardMembersError(caught instanceof Error ? caught.message : "Could not load dashboard members.")
      } finally { if (!cancelled) setDashboardMembersLoading(false) }
    }
    void loadDashboardMembers()
    return () => { cancelled = true }
  }, [sessionToken, demoMode])

  useEffect(() => {
    if (!sessionToken || demoMode) return
    setSharingSettingsLoaded(false)
    let cancelled = false
    async function loadSharingSettings() {
      try {
        const response = await fetch(`${API_BASE}/api/me/data-sharing`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; recipients?: SharingRecipient[] }
        if (!response.ok) throw new Error(payload.error || "Could not load your sharing preferences.")
        if (!cancelled) { setSharingRecipients(payload.recipients || []); setSharingSettingsLoaded(true) }
      } catch (caught) {
        if (!cancelled) setSharingError(caught instanceof Error ? caught.message : "Could not load your sharing preferences.")
      }
    }
    void loadSharingSettings()
    return () => { cancelled = true }
  }, [sessionToken, demoMode])

  useEffect(() => {
    const current = result?.model
    if (!sessionToken || demoMode || !current) return
    let cancelled = false
    async function loadSharedCompanyData() {
      if (!current) return
      try {
        const response = await fetch(`${API_BASE}/api/faction/shared-company-data`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; companies?: SharedCompany[] }
        if (!response.ok) throw new Error(payload.error || "Could not load opted-in company data.")
        if (!cancelled) setSharedCompanies(payload.companies || [])
      } catch (caught) {
        if (!cancelled) setSharingError(caught instanceof Error ? caught.message : "Could not load opted-in company data.")
      }
    }
    void loadSharedCompanyData()
    return () => { cancelled = true }
  }, [sessionToken, demoMode])

  useEffect(() => {
    if (!sessionToken || demoMode) return
    let cancelled = false
    async function restorePersonalHistory() {
      try {
        const response = await fetch(`${API_BASE}/api/me/data-backup`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        if (!response.ok) return
        const backup = await response.json() as { pages?: { charts?: { history?: { sourceSnapshotCreatedAt?: string; companies?: SnapshotHistoryCompany[] } | null } } }
        const archive = backup.pages?.charts?.history
        if (!archive || !Array.isArray(archive.companies) || !archive.companies.length || cancelled) return
        setSnapshotHistory((current) => {
          const merged = new Map<string, SnapshotHistoryCompany>()
          for (const company of [...current, ...archive.companies!]) {
            const key = String(company.companyId)
            const previous = merged.get(key)
            if (!previous) { merged.set(key, company); continue }
            const points = new Map(previous.history.map((point) => [point.day, point]))
            for (const point of company.history) points.set(point.day, { ...points.get(point.day), ...point })
            merged.set(key, { ...previous, ...company, history: Array.from(points.values()).sort((a, b) => a.period - b.period) })
          }
          return Array.from(merged.values())
        })
        if (archive.sourceSnapshotCreatedAt) setSnapshotSourceCreatedAt(archive.sourceSnapshotCreatedAt)
      } catch { /* A backup endpoint being temporarily unavailable should not block the dashboard. */ }
    }
    void restorePersonalHistory()
    return () => { cancelled = true }
  }, [sessionToken, demoMode])

  useEffect(() => {
    if (!sessionToken || activeView !== "charts") return
    let cancelled = false
    async function loadComparison() {
      setCompareError("")
      try {
        const ownResponse = await fetch(`${API_BASE}/api/faction/compare?playerId=${encodeURIComponent(playerId)}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const own = await ownResponse.json() as CompareData & { error?: string }
        let peer: (CompareData & { error?: string }) | null = null
        if (selectedComparePlayerId) {
          const peerResponse = await fetch(`${API_BASE}/api/faction/compare?playerId=${encodeURIComponent(selectedComparePlayerId)}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
          peer = await peerResponse.json() as CompareData & { error?: string }
          if (!peerResponse.ok) throw new Error(peer.error || "Could not load the selected director's history.")
        }
        if (!cancelled) { setCompareData(peer); setOwnCompareData(ownResponse.ok ? own : null) }
      } catch (caught) { if (!cancelled) { setCompareError(caught instanceof Error ? caught.message : "Could not load comparison data."); setCompareData(null); setOwnCompareData(null) } }
    }
    void loadComparison()
    return () => { cancelled = true }
  }, [sessionToken, activeView, selectedComparePlayerId, playerId])

  async function refreshFactionDirectory() {
    if (!sessionToken || factionSyncing) return
    const pendingBefore = factionSyncPending
    setFactionSyncing(true); setRankingError(""); setFactionSyncProgress("Contacting Torn and checking the next batch of faction members…")
    try {
      const response = await fetch(`${API_BASE}/api/faction/directors`, { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string; directors?: FactionDirector[]; pending?: number; generatedAt?: string; weeklyStarCounts?: WeeklyStarCount[]; weeklyStarCountsCapturedAt?: string }
      if (!response.ok) throw new Error(payload.error || "Could not refresh the faction directory.")
      const directors = payload.directors || []
      const pendingAfter = payload.pending || 0
      const checked = pendingBefore > pendingAfter ? pendingBefore - pendingAfter : 0
      setFactionDirectors(directors); setWeeklyStarCounts(payload.weeklyStarCounts || []); setWeeklyStarCountsCapturedAt(payload.weeklyStarCountsCapturedAt || ""); setFactionSyncPending(pendingAfter); setRankingsUpdatedAt(payload.generatedAt || "")
      setFactionSyncProgress(pendingAfter > 0 ? `Updated ${directors.length} directors · ${pendingAfter.toLocaleString()} members still queued${checked ? ` · ${checked.toLocaleString()} checked this batch` : ""}.` : `Directory refresh complete · ${directors.length.toLocaleString()} directors confirmed.`)
      setRankingCompanies(directors.map((director) => ({ companyId: String(director.companyId), companyName: director.companyName, companyType: director.companyType || "Unknown", companyTypeId: director.companyTypeId, starRating: director.starRating, weeklyIncome: director.weeklyIncome, dailyIncome: director.dailyIncome, averageDailyIncome: director.weeklyIncome === null ? null : director.weeklyIncome / 7, directorName: director.directorName, playerId: String(director.playerId), fetchedAt: director.fetchedAt })))
    } catch (caught) { setRankingError(caught instanceof Error ? caught.message : "Could not refresh the faction directory."); setFactionSyncProgress("Refresh failed. Check the error and try again.") }
    finally { setFactionSyncing(false) }
  }

  async function updateSharingRecipient(recipientId: string, key: SharingKey, enabled: boolean) {
    if (!sessionToken || demoMode || sharingSaving || !sharingSettingsLoaded) return
    const previous = sharingRecipients
    const current = previous.find((recipient) => recipient.playerId === recipientId)
    if (!current) return
    const nextRecipient = { ...current, [key]: enabled }
    setSharingRecipients(previous.map((recipient) => recipient.playerId === recipientId ? nextRecipient : recipient))
    setSharingSaving(true)
    setSharingError("")
    setSharingNotice("")
    try {
      const response = await fetch(`${API_BASE}/api/me/data-sharing`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ recipientId, shareFinancialData: nextRecipient.shareFinancialData, shareEmployeeData: nextRecipient.shareEmployeeData, shareTrendData: nextRecipient.shareTrendData }),
      })
      const payload = await response.json() as { error?: string; recipient?: Partial<SharingRecipient> }
      if (!response.ok) throw new Error(payload.error || "Could not save this sharing permission.")
      setSharingRecipients((recipients) => recipients.map((recipient) => recipient.playerId === recipientId ? { ...recipient, ...nextRecipient, ...(payload.recipient || {}) } : recipient))
      const category = key === "shareFinancialData" ? "stock and advertising data" : key === "shareEmployeeData" ? "employee data" : "private trends and chart metrics"
      setSharingNotice(`${current.directorName}: ${enabled ? "sharing enabled" : "sharing disabled"} for ${category}.`)
    } catch (caught) {
      setSharingRecipients(previous)
      setSharingError(caught instanceof Error ? caught.message : "Could not save this sharing permission.")
    } finally {
      setSharingSaving(false)
    }
  }

  const filteredCompanies = useMemo(
    () => companyNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())),
    [search],
  )
  const positions = catalog.companies[selectedCompany] ?? []
  const model = result?.model
  const employeeEffectivenessRisks = (model?.employees ?? []).flatMap((employee) => {
    const flaggedMetrics = [
      { label: "Addiction", value: employee.addictionEffectiveness },
      { label: "Inactivity", value: employee.inactivityEffectiveness },
    ].flatMap((metric) => metric.value === null ? [] : [{ ...metric, severity: metric.value <= -12 ? "red" as const : metric.value >= -11 && metric.value <= -5 ? "yellow" as const : null }])
      .filter((metric) => metric.severity !== null)
    if (!flaggedMetrics.length) return []
    const riskSeverity = flaggedMetrics.some((metric) => metric.severity === "red") ? "red" : "yellow"
    return [{ ...employee, flaggedMetrics, riskSeverity }]
  })
  const highRiskEmployeeAlerts = employeeEffectivenessRisks.filter((employee) => employee.riskSeverity === "red")
  const connectedTypeId = companyTypeIdFromProfile(result?.profile) ?? model?.company.typeId ?? null
  const connectedTypeName = model?.company.typeName || selectedRankingType || savedCompanies.find((company) => company.company_type)?.company_type || ""
  const sameCompanyType = (company: RankingCompany) => connectedTypeId !== null
    ? Number(company.companyTypeId) === connectedTypeId
    : Boolean(connectedTypeName) && company.companyType.toLocaleLowerCase() === connectedTypeName.toLocaleLowerCase()
  const factionRankingCompanies = useMemo(() => {
    const rows = rankingCompanies.map((row) => {
      if (!model || String(row.playerId) !== String(playerId) || String(row.companyId) !== String(model.company.id)) return row
      return { ...row, companyName: model.company.name, companyType: model.company.typeName, companyTypeId: model.company.typeId ?? row.companyTypeId, starRating: model.company.rating, weeklyIncome: model.company.weeklyIncome, dailyIncome: model.company.dailyIncome, averageDailyIncome: model.company.weeklyIncome === null ? null : model.company.weeklyIncome / 7, fetchedAt: model.fetchedAt }
    })
    if (model && playerId && !rows.some((row) => String(row.playerId) === String(playerId))) rows.push({
      companyId: String(model.company.id), companyName: model.company.name, companyType: model.company.typeName, companyTypeId: model.company.typeId,
      starRating: model.company.rating, weeklyIncome: model.company.weeklyIncome, dailyIncome: model.company.dailyIncome,
      averageDailyIncome: model.company.weeklyIncome === null ? null : model.company.weeklyIncome / 7,
      directorName: model.company.directorName || playerName || "Current user", playerId: String(playerId), fetchedAt: model.fetchedAt,
    })
    return rows
  }, [rankingCompanies, model?.company.id, model?.company.name, model?.company.typeName, model?.company.typeId, model?.company.weeklyIncome, model?.company.dailyIncome, model?.company.rating, model?.fetchedAt, playerId, playerName])
  const currentRankingCompany = model ? globalRankingCompanies.find((row) => row.companyId === String(model.company.id)) : undefined
  const companyPeerRows = connectedTypeId !== null
    ? globalRankingCompanies.filter((row) => Number(row.companyTypeId) === connectedTypeId)
    : connectedTypeName ? globalRankingCompanies.filter((row) => row.companyType.toLocaleLowerCase() === connectedTypeName.toLocaleLowerCase()) : []
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
  const currentChartCompany = snapshotHistory.find((company) => company.companyId === String(model?.company.id ?? result?.model.company.id ?? ""))
  const dailyProfit = currentChartCompany?.history.at(-1)?.dailyProfit ?? (model?.company.dailyIncome == null || !costs ? null : model.company.dailyIncome - (costs.adBudget ?? 0) - costs.wages)
  const allDailySamples = (result?.incomeHistory ?? []).filter((item) => item.dailyIncome !== null && new Date(item.fetchedAt) <= utcNow)
  const dedupedSamples = Array.from(new Map(allDailySamples.map((item) => [new Date(new Date(item.fetchedAt).getTime() - 18 * 3600000).toISOString().slice(0, 10), item])).values())
  const weekStart = periodStart("week")
  const monthStart = periodStart("month")
  const weekSamples = dedupedSamples.filter((item) => new Date(item.fetchedAt) >= weekStart)
  const monthSamples = dedupedSamples.filter((item) => new Date(item.fetchedAt) >= monthStart)
  const archivedPoints = (currentChartCompany?.history ?? []).filter((point) => point.period <= utcNow.getTime())
  const archivedWeekPoints = archivedPoints.filter((point) => point.period >= weekStart.getTime())
  const archivedMonthPoints = archivedPoints.filter((point) => point.period >= monthStart.getTime())
  const monthIncomeByDay = new Map(archivedMonthPoints.filter((point) => point.dailyIncome !== null).map((point) => [point.day, point.dailyIncome as number]))
  monthSamples.forEach((item) => monthIncomeByDay.set(new Date(new Date(item.fetchedAt).getTime() - 18 * 3600000).toISOString().slice(0, 10), item.dailyIncome as number))
  const monthlyIncome = monthIncomeByDay.size ? Array.from(monthIncomeByDay.values()).reduce((sum, value) => sum + value, 0) : null
  const weeklyIncome = model?.company.weeklyIncome ?? null
  const latestReportedWeeklyProfit = archivedWeekPoints.filter((point) => point.weeklyProfit !== null).at(-1)?.weeklyProfit ?? null
  const archivedMonthProfit = archivedMonthPoints.filter((point) => point.dailyProfit !== null)
  const operatingDailyCosts = costs ? (costs.adBudget ?? 0) + costs.wages : null
  const weeklyProfit = latestReportedWeeklyProfit ?? (weeklyIncome === null || operatingDailyCosts === null ? null : weeklyIncome - operatingDailyCosts * Math.max(weekSamples.length, archivedWeekPoints.length))
  const monthlyProfit = archivedMonthProfit.length
    ? archivedMonthProfit.reduce((sum, point) => sum + (point.dailyProfit ?? 0), 0)
    : monthlyIncome === null || operatingDailyCosts === null ? null : monthlyIncome - operatingDailyCosts * Math.max(monthSamples.length, archivedMonthPoints.length)
  const weekCoverage = new Set([...weekSamples.map((item) => new Date(new Date(item.fetchedAt).getTime() - 18 * 3600000).toISOString().slice(0, 10)), ...archivedWeekPoints.map((point) => point.day)]).size
  const monthCoverage = new Set([...monthSamples.map((item) => new Date(new Date(item.fetchedAt).getTime() - 18 * 3600000).toISOString().slice(0, 10)), ...archivedMonthPoints.map((point) => point.day)]).size
  const expectedReportingDays = (start: Date) => Math.max(1, Math.floor((utcNow.getTime() - start.getTime()) / 86400000) + 1)
  const factionAllRows = useMemo(() => factionRankingCompanies.slice().sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1)), [factionRankingCompanies])
  const rankingRows = useMemo(() => (activeView === "type-rankings" ? globalRankingCompanies : factionRankingCompanies)
    .filter((company) => activeView === "faction-rankings" || activeView === "type-rankings" ? sameCompanyType(company) : true)
    .slice()
    .sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1)), [activeView, globalRankingCompanies, factionRankingCompanies, connectedTypeId, connectedTypeName])
  const rankByIncome = (company: RankingCompany, rows: RankingCompany[]) => {
    if (company.weeklyIncome === null) return null
    const ordered = rows.slice().sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1))
    const exactIndex = ordered.findIndex((row) => String(row.companyId) === String(company.companyId))
    return exactIndex >= 0 ? exactIndex + 1 : ordered.filter((row) => row.weeklyIncome !== null && row.weeklyIncome > company.weeklyIncome!).length + 1
  }
  const displayRank = (company: RankingCompany) => activeView === "faction-rankings"
    ? rankByIncome(company, factionAllRows)
    : rankByIncome(company, companyPeerRows)
  const currentGlobalCompanyRank = currentRankingCompany ? rankByIncome(currentRankingCompany, companyPeerRows) : null
  const chartSeriesFor = (metric: SnapshotMetric): ChartSeries[] => buildChartSeriesFor(metric, currentChartCompany, ownCompareData, result, model, selectedComparePlayerId, compareData, currentGlobalCompanyRank, currentStar)
  const activePageTitle = activeView === "executive" ? "Executive Overview" : activeView === "health" ? "API Health & Data Freshness" : activeView === "trends" ? "Historical Trends and Comparisons" : activeView === "member-insights" ? "Member Activity" : activeView === "roster-insights" ? "Roster Insights" : activeView === "performance-insights" ? "Performance & Staffing Insights" : activeView === "layout" ? "Customizable Dashboard Layout" : activeView === "overview" ? "Company Details" : activeView === "employees" ? "Employees" : activeView === "catalog" ? "Position Catalog" : activeView === "dashboard-members" ? "Dashboard Members" : activeView === "type-rankings" ? "Company Rankings" : activeView === "faction-rankings" ? "Faction Rankings" : activeView === "charts" ? "Trends & Charts" : activeView === "data-transfer" ? "Import / Export" : activeView === "data-sharing" ? "Data Sharing" : activeView === "alerts" ? "Automation Center" : activeView === "admin" ? "Administration" : "Settings"
  const activePageGroup = activeView === "member-insights" || activeView === "dashboard-members" || activeView === "catalog" || activeView === "trends" || activeView === "performance-insights" ? "References" : activeView === "roster-insights" || activeView === "overview" || activeView === "employees" || activeView === "charts" || activeView === "executive" || activeView === "layout" ? "Company" : activeView === "alerts" || activeView === "health" || activeView === "connect" || activeView === "data-transfer" || activeView === "data-sharing" ? "Settings" : activeView === "type-rankings" || activeView === "faction-rankings" ? "Rankings" : activeView === "admin" ? "Administration" : "Workspace"
  const currentStockRows = stockPriceRows(result?.stock)
  const totalStockValueRows = currentStockRows.filter((item) => item.quantity !== null && item.price !== null)
  const totalStockValue = totalStockValueRows.reduce((sum, item) => sum + Math.max(0, item.quantity ?? 0) * Math.max(0, item.price ?? 0), 0)
  const hasTotalStockValue = totalStockValueRows.length > 0
  const currentStockQuantity = currentStockRows.length && currentStockRows.every((item) => item.quantity !== null) ? currentStockRows.reduce((sum, item) => sum + (item.quantity ?? 0), 0) : null
  const currentSnapshotDay = new Date(Date.now() - 18 * 3600000).toISOString().slice(0, 10)
  const previousStockSnapshot = currentChartCompany?.history.filter((point) => point.stockQuantity !== null && point.day < currentSnapshotDay).at(-1)
  const stockDifference = currentStockQuantity !== null && previousStockSnapshot?.stockQuantity != null ? currentStockQuantity - previousStockSnapshot.stockQuantity : null

  function downloadJson(filename: string, value: unknown) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url)
  }

  async function exportPageJson(pageKey: TransferPageKey) {
    if (!sessionToken || demoMode || transferBusy) return
    setTransferBusy(true); setTransferError(""); setTransferNotice("")
    try {
      const response = await fetch(`${API_BASE}/api/me/data-backup`, { headers: { Authorization: `Bearer ${sessionToken}` } })
      const backup = await response.json() as Record<string, any>
      if (!response.ok) throw new Error(backup.error || "Could not export your saved dashboard data.")
      const pages = backup.pages && typeof backup.pages === "object" ? backup.pages as Record<string, any> : {}
      pages.charts = { ...(pages.charts || {}), history: { sourceSnapshotCreatedAt: snapshotSourceCreatedAt || backup.exportedAt, companies: snapshotHistory } }
      pages.references = { ...(pages.references || {}), catalog: catalog.companies }
      pages.rankings = { ...(pages.rankings || {}), factionDirectors, globalRankingCompanies, weeklyStarCounts, weeklyStarCountsCapturedAt, rankingsUpdatedAt }
      pages.settings = { ...(pages.settings || {}), selectedCompanyId, isDirector }
      if (pageKey === "master") {
        backup.pages = pages
        downloadJson(`naughty-company-master-backup-${new Date().toISOString().slice(0, 10)}.json`, backup)
      } else if (pageKey === "charts") {
        // Keep the established import format: { sourceSnapshotCreatedAt, companies: [...] }.
        downloadJson(`company-history-${new Date().toISOString().slice(0, 10)}.json`, pages.charts.history)
      } else {
        downloadJson(`naughty-company-${pageKey}-${new Date().toISOString().slice(0, 10)}.json`, { format: "naughty-company-dashboard-page", version: 1, page: pageKey, exportedAt: new Date().toISOString(), player: backup.player, data: pages[pageKey] ?? {} })
      }
      setTransferNotice(pageKey === "master" ? "Full personal dashboard backup exported. API keys and session tokens are excluded." : `${transferPages.find((page) => page.key === pageKey)?.title || "Page"} JSON exported.`)
    } catch (caught) { setTransferError(caught instanceof Error ? caught.message : "Could not export dashboard data.") }
    finally { setTransferBusy(false) }
  }

  async function importPageJson(pageKey: TransferPageKey, file: File | undefined) {
    if (!file || !sessionToken || demoMode || transferBusy) return
    setTransferBusy(true); setTransferError(""); setTransferNotice("")
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, any>
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Upload a JSON object, not a list or plain text file.")
      const isMaster = parsed.format === "naughty-company-dashboard-backup" && parsed.version === 1
      const isLegacyHistory = Array.isArray(parsed.companies) && parsed.companies.every((company: unknown) => !!company && typeof company === "object" && Array.isArray((company as Record<string, unknown>).history))
      if (isMaster && pageKey !== "master") throw new Error("That is a Master backup. Use the Master Import button to restore it.")
      if (!isMaster && pageKey === "master") throw new Error("Master Import requires a full Master backup JSON exported from this dashboard.")
      if (isLegacyHistory && pageKey !== "charts") throw new Error("Your earlier history JSON belongs in the Trends & Charts import row.")
      if (!isMaster && !isLegacyHistory && parsed.page !== pageKey) throw new Error(`This JSON is for ${String(parsed.page || "another page")}. Choose the matching Import button.`)
      const requestBody = isMaster ? parsed : { pageKey, data: isLegacyHistory ? parsed : parsed.data }
      const response = await fetch(`${API_BASE}/api/me/data-backup`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${sessionToken}` }, body: JSON.stringify(requestBody) })
      const payload = await response.json() as { error?: string; message?: string; imported?: boolean }
      if (!response.ok) throw new Error(payload.error || "Could not import this JSON file.")
      if (!isMaster && pageKey === "charts") {
        const history = isLegacyHistory ? parsed : parsed.data
        setSnapshotHistory((current) => {
          const merged = new Map<string, SnapshotHistoryCompany>()
          for (const company of [...current, ...(history.companies as SnapshotHistoryCompany[])]) {
            const key = String(company.companyId), previous = merged.get(key)
            if (!previous) { merged.set(key, company); continue }
            const points = new Map(previous.history.map((point) => [point.day, point]))
            for (const point of company.history) points.set(point.day, { ...points.get(point.day), ...point })
            merged.set(key, { ...previous, ...company, history: Array.from(points.values()).sort((a, b) => a.period - b.period) })
          }
          return Array.from(merged.values())
        })
        if (history.sourceSnapshotCreatedAt) setSnapshotSourceCreatedAt(history.sourceSnapshotCreatedAt)
        setTransferNotice(payload.message || "History imported and merged with your existing timeline.")
      } else {
        setTransferNotice(payload.message || "JSON imported successfully. Reloading saved records…")
        window.setTimeout(() => window.location.reload(), 650)
      }
    } catch (caught) { setTransferError(caught instanceof Error ? caught.message : "Could not import dashboard data.") }
    finally { setTransferBusy(false) }
  }


  async function deleteSavedCompanyKey(company: SavedCompany) {
    if (!sessionToken || !company.has_api_key || companyKeyActionBusy) return
    const name = company.company_name || `Company #${company.company_id}`
    if (!window.confirm(`Remove the saved API key for ${name}? Its saved company history will be retained.`)) return
    setCompanyKeyActionBusy(company.company_id)
    setError("")
    try {
      const response = await fetch(`${API_BASE}/api/auth/company-key?companyId=${encodeURIComponent(company.company_id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string; companyKeySaved?: boolean }
      if (!response.ok) throw new Error(payload.error || "Could not remove this company key.")
      setSavedCompanies((current) => current.map((item) => item.company_id === company.company_id ? { ...item, has_api_key: false, key_last_four: null, key_updated_at: null } : item))
      setCompanyKeySaved(payload.companyKeySaved ?? false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove this company key.")
    } finally {
      setCompanyKeyActionBusy("")
    }
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
    localStorage.removeItem("ncd_session")
    setSessionToken("")
    setDemoMode(true)
    setPlayerName("Demo Director")
    setPlayerId("demo-player")
    setIsAdmin(false)
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
      const payload = await response.json() as { error?: string; token?: string; isAdmin?: boolean; player?: { id: string; name: string }; key?: { saved: boolean }; company?: { isDirector?: boolean; key?: { saved?: boolean }; needsSecondaryKey?: boolean } }
      if (!response.ok) throw new Error(payload.error || "Sign-in failed. Check that your Torn key is valid and has limited permissions.")
      if (!payload.token) throw new Error("The sign-in service did not return a session. Please try again.")
      localStorage.setItem("ncd_session", payload.token)
      setSessionToken(payload.token)
      setPlayerName(payload.player?.name || "Torn member")
      setPlayerId(payload.player?.id || "")
      setIsAdmin(payload.isAdmin === true && payload.player?.id === "351311")
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

  function signOut(revokeServerSession = true) {
    const token = sessionToken || localStorage.getItem("ncd_session") || ""
    if (revokeServerSession && token) {
      void fetch(`${API_BASE}/api/auth/sign-out`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    }
    localStorage.removeItem("ncd_session")
    setDemoMode(false)
    setSessionToken("")
    setPlayerName("")
    setPlayerId("")
    setIsAdmin(false)
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

  async function signOutEverywhere() {
    if (!sessionToken || demoMode || sessionActionBusy) return
    if (!window.confirm("Sign out this account on all devices? Your current session will end too.")) return
    setSessionActionBusy(true)
    setError("")
    try {
      const response = await fetch(`${API_BASE}/api/auth/sign-out-all`, { method: "POST", headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not revoke account sessions.")
      signOut(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke account sessions.")
    } finally {
      setSessionActionBusy(false)
    }
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
      if (!secondaryCompanyKey.trim() && targetCompanyId) {
        await loadSavedCompany(targetCompanyId)
        return
      }
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
      if (!secondaryCompanyKey.trim() && !targetCompanyId) throw new Error("No saved company data is available yet. Add the authorized company key to initialize the company, or wait for the scheduled 18:10 UTC data refresh.")
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
    <div className={`app-shell dashboard-density-${dashboardPreferences.density} dashboard-width-${dashboardPreferences.contentWidth}${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setActiveView("overview") }}>
          <span className="brand-mark">NC</span>
          <span><strong>NAUGHTY</strong><small>COMPANY OPERATIONS</small></span>
        </a>
        <button className="sidebar-mobile-close" type="button" onClick={() => setSidebarCollapsed(true)} aria-label="Close navigation">×</button>
        <div className="side-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          <div className="nav-group"><button className="nav-group-trigger" type="button" aria-expanded={openNavGroups.company} onClick={() => setOpenNavGroups((groups) => ({ ...groups, company: !groups.company }))}><span>Company</span><b>{openNavGroups.company ? "⌄" : "›"}</b></button>{openNavGroups.company && <div className="nav-subitems"><button className={activeView === "overview" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("overview")}><span aria-hidden="true">◫</span><span className="nav-label">Company Details</span></button><button className={activeView === "employees" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("employees")}><span aria-hidden="true">♙</span><span className="nav-label">Employees</span></button><button className={activeView === "charts" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("charts")}><span aria-hidden="true">⌁</span><span className="nav-label">Trends & Charts</span></button><button className={activeView === "roster-insights" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("roster-insights")}><span aria-hidden="true">♙</span><span className="nav-label">Roster Insights</span></button><button className={activeView === "executive" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("executive")}><span aria-hidden="true">▤</span><span className="nav-label">Executive Overview</span></button><button className={activeView === "layout" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("layout")}><span aria-hidden="true">▤</span><span className="nav-label">Customize Layout</span></button></div>}</div>
          <div className="nav-group"><button className="nav-group-trigger" type="button" aria-expanded={openNavGroups.rankings} onClick={() => setOpenNavGroups((groups) => ({ ...groups, rankings: !groups.rankings }))}><span>Rankings</span><b>{openNavGroups.rankings ? "⌄" : "›"}</b></button>{openNavGroups.rankings && <div className="nav-subitems"><button className={activeView === "type-rankings" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("type-rankings")}><span aria-hidden="true">↗</span><span className="nav-label">Company Rankings</span></button><button className={activeView === "faction-rankings" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("faction-rankings")}><span aria-hidden="true">♜</span><span className="nav-label">Faction Rankings</span></button></div>}</div>
          <div className="nav-group"><button className="nav-group-trigger" type="button" aria-expanded={openNavGroups.references} onClick={() => setOpenNavGroups((groups) => ({ ...groups, references: !groups.references }))}><span>References</span><b>{openNavGroups.references ? "⌄" : "›"}</b></button>{openNavGroups.references && <div className="nav-subitems"><button className={activeView === "catalog" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("catalog")}><span aria-hidden="true">▦</span><span className="nav-label">Position Catalog</span><em>{companyNames.length}</em></button><button className={activeView === "trends" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("trends")}><span aria-hidden="true">⌁</span><span className="nav-label">Historical Trends</span></button><button className={activeView === "performance-insights" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("performance-insights")}><span aria-hidden="true">◈</span><span className="nav-label">Performance Insights</span></button>{isAdmin && <><button className={activeView === "dashboard-members" || activeView === "member-insights" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("dashboard-members")}><span aria-hidden="true">♙</span><span className="nav-label">Dashboard Members & Activity</span><em>{dashboardMembers.length || "—"}</em></button></>}</div>}</div>
          <div className="nav-group"><button className="nav-group-trigger" type="button" aria-expanded={openNavGroups.settings} onClick={() => setOpenNavGroups((groups) => ({ ...groups, settings: !groups.settings }))}><span>Settings</span><b>{openNavGroups.settings ? "⌄" : "›"}</b></button>{openNavGroups.settings && <div className="nav-subitems"><button className={activeView === "connect" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("connect")}><span aria-hidden="true">⚙</span><span className="nav-label">Settings</span></button><button className={activeView === "data-sharing" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("data-sharing")}><span aria-hidden="true">⇄</span><span className="nav-label">Data Sharing</span></button><button className={activeView === "data-transfer" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("data-transfer")}><span aria-hidden="true">⇅</span><span className="nav-label">Import / Export</span></button><button className={activeView === "health" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("health")}><span aria-hidden="true">♥</span><span className="nav-label">API Health & Freshness</span></button><button className={activeView === "alerts" ? "nav-item nav-subitem active" : "nav-item nav-subitem"} onClick={() => setActiveView("alerts")}><span aria-hidden="true">◷</span><span className="nav-label">Automation Center</span></button></div>}</div>
          {isAdmin && <div className="nav-group admin-nav-group"><div className="side-label">ADMINISTRATION</div><button type="button" className={activeView === "admin" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("admin")}><span aria-hidden="true">♜</span><span className="nav-label">Administration</span><em>ADMIN</em></button></div>}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-indicator"><span className={result ? "status-dot live" : "status-dot"} />{demoMode ? "Demo workspace · sample data" : keySaved ? `Signed in${playerName ? ` as ${playerName}` : ""}` : "Player signed in · key deleted"}</div><button className="signout-button" onClick={demoMode ? exitDemo : () => signOut()}>{demoMode ? "Exit demo" : "Sign out"}</button>
          <div className="sidebar-foot">EARLY ACCESS <span>•</span> BUILD 0.2</div>
        </div>
      </aside>

      <main className="main-area">
        {demoMode && <div className="demo-banner"><strong>DEMO MODE</strong><span>All player, company, employee and income data below is fictional. Live Torn connections are disabled.</span><button type="button" onClick={exitDemo}>Exit demo ×</button></div>}
        <header className="topbar">
          <div className="topbar-leading"><button className="sidebar-toggle" type="button" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? "Expand navigation sidebar" : "Minimize navigation sidebar"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Expand navigation" : "Minimize navigation"}><span aria-hidden="true">{sidebarCollapsed ? "☰" : "‹"}</span></button><div className="breadcrumbs">Workspace <span>/</span> {activePageGroup} <span>/</span> <strong>{activePageTitle}</strong></div></div>
          <div className="topbar-right"><span className="environment-pill"><i /> {demoMode ? "DEMO DATA" : "CLOUDFLARE WORKER"}</span><div className="user-company-switcher"><button className="user-company-trigger" type="button" aria-expanded={showCompanySelector} onClick={() => setShowCompanySelector((open) => !open)}><span className="avatar">{playerName.slice(0, 2).toUpperCase() || "NC"}</span><span className="user-company-label"><strong>{playerName || "Connected user"}</strong><small>Torn ID {playerId || "—"} · {result?.model.company.name || "No company loaded"} · {result?.model.company.typeName || "No company type"}</small></span><span className="switch-chevron">⌄</span></button>{showCompanySelector && <div className="company-switcher-menu"><div className="company-switcher-menu-heading"><strong>Choose a company</strong><button type="button" className="company-connect-plus" onClick={() => { setShowCompanySelector(false); setActiveView("connect") }} aria-label="Connect company" title="Connect company">＋</button></div>{savedCompanies.length ? savedCompanies.map((company) => <button key={company.company_id} type="button" className={selectedCompanyId === company.company_id ? "company-switcher-option selected" : "company-switcher-option"} onClick={() => void loadSavedCompany(company.company_id)}><span>{company.company_name || `Company #${company.company_id}`}</span><small>{company.company_type || "Company"} · #{company.company_id}</small></button>) : <p>No saved companies yet. Connect a company key to add one.</p>}</div>}</div></div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div><div className="eyebrow"><span className="eyebrow-line" /> COMPANY INTELLIGENCE</div><h1>{activeView === "executive" ? "Executive Overview" : activeView === "health" ? "API Health & Data Freshness" : activeView === "trends" ? "Historical Trends and Comparisons" : activeView === "member-insights" ? "Member Activity" : activeView === "roster-insights" ? "Roster Insights" : activeView === "performance-insights" ? "Performance & Staffing Insights" : activeView === "layout" ? "Customizable Dashboard Layout" : activeView === "alerts" ? "Automation Center" : activeView === "overview" ? "Company Details" : activeView === "employees" ? "Employees" : activeView === "catalog" ? "Position Catalog" : activeView === "dashboard-members" ? "Dashboard Members" : activeView === "type-rankings" ? "Company Rankings" : activeView === "faction-rankings" ? "Faction Rankings" : activeView === "charts" ? "Trends & Charts" : activeView === "data-transfer" ? "Import / Export" : activeView === "data-sharing" ? "Data Sharing" : activeView === "admin" ? "Administration" : "Settings"}</h1><p className="subtitle">{activeView === "executive" ? "A decision-ready summary of performance, operational health, staffing, alerts, and competitive context." : activeView === "health" ? "Worker availability, database connectivity, and company data freshness in one place." : activeView === "trends" ? "Compare income, star rating, and roster size across historical snapshots." : activeView === "performance-insights" ? "Find material performance changes, evidence-based staffing reviews, and track follow-through." : activeView === "member-insights" ? "Dashboard account activity and saved company-data coverage." : activeView === "roster-insights" ? "Workforce capacity, role mix, employee skills, wages, and tenure for the selected company." : activeView === "layout" ? "Customize the dashboard-wide reading experience and separately arrange Executive Overview widgets." : activeView === "overview" ? "A focused view of company performance, income, and star-level progress." : activeView === "employees" ? "Employee details, role fit, and position projections in one dedicated workspace." : activeView === "catalog" ? "Explore role requirements across the Torn company ecosystem." : activeView === "dashboard-members" ? "Directory of dashboard accounts and their latest saved Torn company details." : activeView === "type-rankings" ? "Compare companies within the same Torn company type, ranked by weekly income." : activeView === "faction-rankings" ? "See all confirmed faction directors, including members who do not use this dashboard." : activeView === "charts" ? "Track daily income, profit, stock levels, and historical company performance." : activeView === "data-transfer" ? "Import legacy company history or export page-by-page JSON backups of your saved dashboard data." : activeView === "data-sharing" ? "Choose exactly which dashboard members can see your trends, financial details, and employee data." : activeView === "admin" ? "Restricted administration for dashboard operations, data maintenance, and access management." : "Manage your Torn API connection and saved company keys."}</p></div>
          </section>

          {activeView === "alerts" && !demoMode ? (
            <AlertsPanel apiBase={API_BASE} sessionToken={sessionToken} companies={savedCompanies} selectedCompanyId={selectedCompanyId} demoMode={demoMode} onNavigateCharts={() => setActiveView("charts")} />
          ) : activeView === "executive" && !demoMode || activeView === "health" && !demoMode || activeView === "trends" || activeView === "member-insights" && isAdmin && !demoMode || activeView === "roster-insights" || activeView === "performance-insights" || activeView === "layout" ? (
            <InsightsWorkspace view={activeView} apiBase={API_BASE} sessionToken={sessionToken} isAdmin={isAdmin && !demoMode} demoMode={demoMode} companyId={selectedCompanyId} sharedRosterCompanies={sharedCompanies.filter((company) => company.shareEmployeeData)} model={model ?? null} companyRank={currentRankingCompany ? placement(currentRankingCompany, "type", globalRankingCompanies) : "—"} starRank={currentRankingCompany ? placement(currentRankingCompany, "stars", globalRankingCompanies) : "—"} nextStarGap={nextStarGap} sameTypeCount={companyPeerRows.length} dashboardPreferences={dashboardPreferences} onDashboardPreferencesChange={updateDashboardPreferences} onNavigate={(next) => setActiveView(next)} />
          ) : activeView === "admin" && isAdmin && !demoMode ? (
            <AdminPanel apiBase={API_BASE} sessionToken={sessionToken} playerId={playerId} playerName={playerName} />
          ) : activeView === "type-rankings" || activeView === "faction-rankings" ? (
            <section className="panel ranking-panel">
              <div className="panel-heading ranking-heading"><div><h2>{activeView === "type-rankings" ? "Rank within company type" : "Faction directors by company type"}</h2><p>{activeView === "type-rankings" ? "Companies matching the connected company type, ranked by weekly income." : "Confirmed directors from the faction roster, whether or not they use this dashboard. Select Compare to open income and stock graphs."}</p></div>{activeView === "type-rankings" ? <span className="count-chip">{selectedRankingType || "Connected company type"}</span> : <span className="count-chip">{factionDirectors.length} faction directors</span>}</div>
              <div className="ranking-meta"><span><i className="status-dot live" /> {rankingRows.length.toLocaleString()} {activeView === "type-rankings" ? "companies in your connected company type" : "same-type faction directors"}</span><span>Weekly income period: Sunday 18:00 UTC to Sunday 18:00 UTC · Data refresh: daily at 18:10 UTC · Star ratings lock Sundays at 18:10 UTC</span></div>{activeView === "faction-rankings" && <section className="weekly-star-counts" aria-label="Weekly company counts by star rating"><div><strong>Weekly star-level counts</strong><span>{weeklyStarCountsCapturedAt ? `Locked ${new Date(weeklyStarCountsCapturedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}` : "Counts lock on Sundays at 18:10 UTC"}</span></div>{weeklyStarCounts.length ? [...weeklyStarCounts].sort((a,b)=>a.starRating-b.starRating).map((entry)=><article key={entry.starRating}><small>{entry.starRating} ★</small><strong>{entry.companyCount.toLocaleString()}</strong></article>) : <p>Waiting for the first Sunday 18:10 UTC snapshot.</p>}</section>}{activeView === "faction-rankings" && (factionSyncing || factionSyncProgress) && <div className="faction-sync-status" role="status" aria-live="polite">{factionSyncing && <span className="loading-wheel" aria-hidden="true" />}<span>{factionSyncProgress || "Preparing faction directory refresh…"}</span>{factionSyncing && <div className="sync-progress-track"><i /></div>}</div>}
              {activeView === "type-rankings" && <section className="ranking-self-summary" aria-label="Your company ranking summary"><div className="ranking-self-heading"><div><h3>Your company snapshot</h3><p>{model?.company.name || result?.model.company.name || "Connected company"} · {model?.company.typeName || result?.model.company.typeName || "Company type unavailable"}</p></div><span className="count-chip">{currentRankingCompany && displayRank(currentRankingCompany) !== null ? `Rank #${displayRank(currentRankingCompany)}` : "Rank unavailable"}</span></div><div className="ranking-self-grid"><article><small>WEEKLY INCOME</small><strong>{formatMoney(currentWeeklyIncome)}</strong></article><article><small>DAILY INCOME</small><strong>{formatMoney(model?.company.dailyIncome ?? currentRankingCompany?.dailyIncome)}</strong></article><article><small>DAILY AVG INCOME</small><strong>{formatMoney(currentRankingCompany?.averageDailyIncome ?? (currentWeeklyIncome === null ? null : currentWeeklyIncome / 7))}</strong></article><article><small>GAP TO NEXT STAR</small><strong>{nextStarGap === null ? "—" : formatMoney(nextStarGap)}</strong><span>{nextStarIncome === null ? "No higher-star benchmark yet" : `Next star benchmark ${formatMoney(nextStarIncome)}/week`}</span></article><article><small>GAP TO PREVIOUS STAR</small><strong>{previousStarGap === null ? "—" : formatMoney(previousStarGap)}</strong><span>{previousStarIncome === null ? "No lower-star benchmark yet" : `Previous star benchmark ${formatMoney(previousStarIncome)}/week`}</span></article></div></section>}
              {rankingError && <div className="error-banner" role="alert">{rankingError}</div>}
              <div className="table-scroll"><table className="ranking-table ranking-compact-table"><thead><tr><th className="ranking-rank-col">RANK</th><th className="ranking-company-col">{activeView === "faction-rankings" ? "COMPANY / DIRECTOR" : "COMPANY"}</th><th>STARS</th><th>WEEKLY INCOME</th><th className="ranking-hide-mobile">DAILY / AVG</th><th className="ranking-hide-mobile">DATA AS OF (UTC)</th><th>{activeView === "faction-rankings" ? <span className="ranking-header-stack"><span>STAR RANKING</span><span>GLOBAL COMPANY TYPE RANKING</span></span> : "STAR RANKING"}</th></tr></thead><tbody>{rankingRows.map((company) => <tr key={`${company.playerId}-${company.companyId}`}><td><span className={`rank-number ${displayRank(company) !== null && displayRank(company)! <= 3 ? "top-rank" : ""}`} title={activeView === "faction-rankings" ? "Rank among all confirmed faction directors by weekly income" : "Rank among all companies of this type by weekly income"}>{displayRank(company) ?? "—"}</span></td><td className="ranking-company-cell"><strong>{company.companyName}</strong>{activeView === "faction-rankings" && <div className="ranking-director">{company.directorName}</div>}<div className="ranking-company-meta"><span>#{company.companyId} · {activeView === "faction-rankings" ? `${company.companyType || "Unknown type"} · type_id ${company.companyTypeId ?? "—"}` : company.companyType || (company.companyTypeId == null ? "Unknown type" : `Type #${company.companyTypeId}`)}</span>{activeView === "faction-rankings" && <button className="text-button compare-row-button" onClick={() => { setSelectedComparePlayerId(company.playerId); setActiveView("charts") }}>Compare ↗</button>}</div></td><td><span className="star-rating">{company.starRating === null ? "—" : `${company.starRating} ★`}</span></td><td className="income-primary">{formatMoney(company.weeklyIncome)}</td><td className="ranking-hide-mobile"><div className="ranking-stack ranking-metrics-stack"><span><small>DAILY</small>{formatMoney(company.dailyIncome)}</span><span><small>AVG</small>{formatMoney(company.averageDailyIncome)}</span></div></td><td className="muted ranking-hide-mobile">{company.fetchedAt ? new Date(company.fetchedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}</td><td>{activeView === "faction-rankings" ? <div className="ranking-stack" title="Rank among companies with the same type and star level, followed by rank among all companies of the same type"><span><small>STAR</small>{placement(company, "stars", globalRankingCompanies)}</span><span><small>TYPE</small>{placement(company, "type", globalRankingCompanies)}</span></div> : placement(company, "stars", globalRankingCompanies)}</td></tr>)}</tbody></table></div>
              {activeView === "faction-rankings" && <section className="faction-all-rankings"><div className="panel-heading ranking-heading"><div><h2>All faction directors, every company type</h2><p>Cross-type comparison of every confirmed faction director, sorted by weekly income.</p></div><span className="count-chip">{factionAllRows.length} directors</span></div><div className="table-scroll"><table className="ranking-table ranking-compact-table"><thead><tr><th className="ranking-rank-col">RANK</th><th className="ranking-company-col">COMPANY / DIRECTOR</th><th>STARS</th><th>WEEKLY INCOME</th><th className="ranking-hide-mobile">DAILY / AVG</th><th className="ranking-hide-mobile">DATA AS OF (UTC)</th><th><span className="ranking-header-stack"><span>STAR RANKING</span><span>GLOBAL COMPANY TYPE RANKING</span></span></th></tr></thead><tbody>{factionAllRows.map((company) => <tr key={`all-${company.playerId}-${company.companyId}`}><td><span className={`rank-number ${rankByIncome(company, factionAllRows) !== null && rankByIncome(company, factionAllRows)! <= 3 ? "top-rank" : ""}`} title="Rank among all confirmed faction directors by weekly income">{rankByIncome(company, factionAllRows) ?? "—"}</span></td><td className="ranking-company-cell"><strong>{company.companyName}</strong><div className="ranking-director">{company.directorName}</div><div className="ranking-company-meta"><span>#{company.companyId} · {activeView === "faction-rankings" ? `${company.companyType || "Unknown type"} · type_id ${company.companyTypeId ?? "—"}` : company.companyType || (company.companyTypeId == null ? "Unknown type" : `Type #${company.companyTypeId}`)}</span><button className="text-button compare-row-button" onClick={() => { setSelectedComparePlayerId(company.playerId); setActiveView("charts") }}>Compare ↗</button></div></td><td><span className="star-rating">{company.starRating === null ? "—" : `${company.starRating} ★`}</span></td><td className="income-primary">{formatMoney(company.weeklyIncome)}</td><td className="ranking-hide-mobile"><div className="ranking-stack ranking-metrics-stack"><span><small>DAILY</small>{formatMoney(company.dailyIncome)}</span><span><small>AVG</small>{formatMoney(company.averageDailyIncome)}</span></div></td><td className="muted ranking-hide-mobile">{company.fetchedAt ? new Date(company.fetchedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}</td><td><div className="ranking-stack" title="Rank among companies with the same type and star level, followed by rank among all companies of the same type"><span><small>STAR</small>{placement(company, "stars", globalRankingCompanies)}</span><span><small>TYPE</small>{placement(company, "type", globalRankingCompanies)}</span></div></td></tr>)}</tbody></table></div>{factionAllRows.length === 0 && <div className="empty-state">No faction directors have been discovered yet. Open Charts and use Refresh directory to process the next batch of member IDs.</div>}</section>}
              {rankingRows.length === 0 && <div className="empty-state">{activeView === "type-rankings" ? "No companies were returned for your connected company type." : "No faction directors have been discovered yet. Open Charts and use Refresh directory to process the next batch of member IDs."}</div>}{activeView === "faction-rankings" && factionSyncPending > 0 && <div className="ranking-footnote"><p>{factionSyncPending} faction members are still queued for director checks. Open Charts and refresh the directory again to process another batch.</p></div>}
              <div className="ranking-footnote"><strong>How ranking works</strong><p>Rank is determined exclusively by weekly income, highest first; tied incomes receive sequential places in the stable income-sorted list. Average daily income is weekly income divided by seven. Company Rankings is filtered to your connected company type. Faction Rankings has two tables: the first compares faction directors of the connected company type; the second includes all confirmed faction directors across every company type.</p><p>{rankingsUpdatedAt ? `${activeView === "type-rankings" ? "Torn snapshot retrieved" : "Faction leaderboard checked"} ${new Date(rankingsUpdatedAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}.` : "Leaderboard refreshes from saved company profiles."} Weekly income uses Torn’s reported total for the fixed Sunday 18:00 UTC to Sunday 18:00 UTC period, not a rolling sum of daily samples. The leaderboard refreshes daily at 18:10 UTC; star-rating changes lock on Sundays at 18:00 UTC, with the weekly refresh at 18:10 UTC.</p></div>
            </section>
          ) : activeView === "charts" ? (
            <div className="charts-workspace">
              <section className="panel sharing-control-panel">
                <div className="sharing-control-heading"><div><h2>Compare a faction director</h2><p>Public daily and weekly income history is comparable for any faction director, regardless of company type or private-sharing choices. Private stock, advertising, employee details, and profit-history metrics appear only when that director has explicitly shared them with you.</p></div><button className="secondary-button" onClick={() => void refreshFactionDirectory()} disabled={factionSyncing || !sessionToken}>{factionSyncing ? <><span className="loading-wheel" aria-hidden="true" /> Refreshing…</> : "Refresh directory"}</button></div>
                <div className="shared-data-compare"><label htmlFor="financial-compare-user">Compare shared financial data / public income trends</label><select id="financial-compare-user" value={selectedComparePlayerId} onChange={(event) => setSelectedComparePlayerId(event.target.value)}><option value="">No comparison · selected company only</option>{factionDirectors.filter((director) => String(director.playerId) !== String(playerId)).map((director) => <option key={director.playerId} value={director.playerId}>{director.directorName} · {director.companyName} ({director.companyType || "Unknown type"})</option>)}</select></div>
                {compareError && <div className="error-banner" role="alert">{compareError}</div>}
                {selectedComparePlayerId && compareData && <div className="compare-summary"><div><small>SELECTED DIRECTOR</small><strong>{compareData.director.directorName}</strong></div><div><small>COMPANY</small><strong>{compareData.director.companyName}</strong></div><div><small>TYPE / RATING</small><strong>{compareData.director.companyType || "Unknown"} · {compareData.director.starRating ?? "—"} ★</strong></div><div><small>WEEKLY INCOME</small><strong>{formatMoney(compareData.director.weeklyIncome)}</strong></div></div>}
                {selectedComparePlayerId && compareData && (() => { const peer = sharedCompanies.find((company) => company.playerId === selectedComparePlayerId && company.shareFinancialData); return peer ? <div className="shared-financial-summary"><article><small>COMPANY</small><strong>{peer.companyName}</strong><span>{peer.directorName} · {peer.companyType}</span></article><article><small>ADVERTISING BUDGET</small><strong>{peer.adBudget == null ? "Not returned" : formatMoney(peer.adBudget)}</strong></article><article className="shared-stock-summary"><small>SHARED STOCK</small>{peer.stock?.length ? peer.stock.map((item, index) => <span key={`${item.name || "stock"}-${index}`}>{item.name || "Stock item"}: {item.quantity == null ? "Qty n/a" : formatNumber(item.quantity)} · {item.unitPrice == null ? "Price n/a" : formatMoney(item.unitPrice)}</span>) : <span>No stock pricing available in the latest saved snapshot.</span>}</article></div> : <p className="sharing-privacy-note">Private stock and advertising data has not been shared with you by this director. Public income charts remain available.</p> })()}
              </section>
              <section className="panel imported-history-panel">
                <div className="panel-heading"><div><h2>Company history & live charts</h2><p>One continuous timeline for the selected company. Imported snapshots are merged with live readings by reporting date; no other company is shown unless you select a director above.</p></div><span className="count-chip">{currentChartCompany?.history.length ?? 0} imported snapshots</span></div>
                {snapshotSourceCreatedAt && <p className="snapshot-source-note">Imported backup created {new Date(snapshotSourceCreatedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}. Dates are UTC.</p>}
                {snapshotHistoryError && <div className="error-banner" role="alert">{snapshotHistoryError}</div>}
                {snapshotHistoryLoading ? <div className="empty-state">Loading company history…</div> : <>
                  {currentChartCompany && <div className="snapshot-summary-grid"><article className="snapshot-summary-card"><div className="snapshot-company-heading"><div><strong>{currentChartCompany.name}</strong><span>Company #{currentChartCompany.companyId} · {currentChartCompany.typeName}</span></div><span className="star-rating">{currentChartCompany.history.at(-1)?.rating == null ? "—" : `${currentChartCompany.history.at(-1)?.rating} ★`}</span></div><div className="snapshot-metric-grid"><span><small>DAILY INCOME</small><strong>{formatMoney(model?.company.dailyIncome ?? currentChartCompany.history.at(-1)?.dailyIncome ?? null)}</strong></span><span><small>WEEKLY INCOME</small><strong>{formatMoney(model?.company.weeklyIncome ?? currentChartCompany.history.at(-1)?.weeklyIncome ?? null)}</strong></span><span><small>DAILY PROFIT</small><strong>{formatMoney(currentChartCompany.history.at(-1)?.dailyProfit ?? null)}</strong></span><span><small>WEEKLY PROFIT</small><strong>{formatMoney(currentChartCompany.history.at(-1)?.weeklyProfit ?? null)}</strong></span><span><small>COMPANY RANK</small><strong>{currentChartCompany.history.at(-1)?.companyRank == null ? "—" : `#${currentChartCompany.history.at(-1)?.companyRank}${currentChartCompany.history.at(-1)?.companyRankTotal == null ? "" : ` / ${currentChartCompany.history.at(-1)?.companyRankTotal}`}`}</strong></span><span><small>STOCK QUANTITY</small><strong>{currentChartCompany.history.at(-1)?.stockQuantity == null ? "—" : formatNumber(currentChartCompany.history.at(-1)?.stockQuantity)}</strong></span></div><p className="snapshot-date-range">{currentChartCompany.history[0]?.day || "—"} to {currentChartCompany.history.at(-1)?.day || "—"} · {currentChartCompany.history.length} imported daily records, plus any newer live samples</p></article></div>}
                  {!currentChartCompany && <div className="empty-state">No imported archive matches the currently selected company. Live company readings will still appear below when available.</div>}
                  <LineChart title="Daily company income" money series={chartSeriesFor("dailyIncome")} />
                  <LineChart title="Weekly company income" money series={chartSeriesFor("weeklyIncome")} />
                  <LineChart title="Daily company profit" money series={chartSeriesFor("dailyProfit")} />
                  <LineChart title="Weekly company profit" money series={chartSeriesFor("weeklyProfit")} />
                  <LineChart title="Daily stock quantity" series={chartSeriesFor("stockQuantity")} />
                  <LineChart title="Star-rating history" invertY series={chartSeriesFor("rating")} />
                  <LineChart title="Global company ranking · same company type" invertY series={chartSeriesFor("companyRank")} />
                </>}
              </section>
              <div className="ranking-footnote"><strong>Data coverage</strong><p>Historical and live values are joined by reporting date, with live values taking precedence when both sources contain the same day. Missing days are left blank, never interpolated. Weekly profit uses the latest recorded reported weekly-profit total when available; month-to-date totals use recorded daily snapshots and can be partial if a day is missing.</p></div>
            </div>
          ) : activeView === "employees" ? (
            <section className="panel employee-page-panel">
              <div className="panel-heading"><div><h2>Employee details & position fit</h2><p>Work stats, role configuration matches, and requirement gaps are kept off the company overview.</p></div><span className="count-chip">{model ? model.employees.length : 0} employees</span></div>
              <section className="panel employee-compare-panel"><div className="panel-heading"><div><h3>Compare employees with another dashboard user</h3><p>Only members you have explicitly shared employee data with appear here.</p></div></div><div className="shared-data-compare"><label htmlFor="employee-compare-user">Compare with</label><select id="employee-compare-user" value={employeeComparePlayerId} onChange={(event) => setEmployeeComparePlayerId(event.target.value)}><option value="">No comparison</option>{sharedCompanies.filter((company) => company.shareEmployeeData).map((company) => <option key={`${company.playerId}-${company.companyId}`} value={company.playerId}>{company.directorName} · {company.companyName}</option>)}</select></div>
                {employeeComparePlayerId && (() => { const peer = sharedCompanies.find((company) => company.playerId === employeeComparePlayerId && company.shareEmployeeData); return peer ? <><div className="shared-company-compare-heading"><strong>{peer.companyName}</strong><span>{peer.directorName} · {peer.companyType} · Updated {new Date(peer.fetchedAt).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })}</span></div><div className="table-scroll"><table className="shared-employee-table"><thead><tr><th>EMPLOYEE</th><th>CURRENT POSITION</th><th>WORK STATS (MAN / INT / END)</th><th>TOTAL EFFECTIVENESS</th><th>WAGE</th></tr></thead><tbody>{(peer.employees || []).map((employee, index) => <tr key={`${employee.name || "employee"}-${index}`}><td>{employee.name || "Employee"}</td><td>{employee.position || "—"}</td><td>{employee.stats ? `MAN ${formatNumber(employee.stats.MAN)} · INT ${formatNumber(employee.stats.INT)} · END ${formatNumber(employee.stats.END)}` : "Not shared"}</td><td>{employee.effectiveness == null ? "—" : formatNumber(employee.effectiveness)}</td><td>{employee.wage == null ? "—" : formatMoney(employee.wage)}</td></tr>)}</tbody></table></div>{!peer.employees?.length && <div className="empty-state">No employee details are available in the latest saved company snapshot.</div>}</> : null })()}
              </section>
              {model ? <><div className="employee-summary-strip"><span><small>ROLE MATCHES</small><strong>{model.matchedPositionCount}</strong></span><span><small>MEET REQUIREMENTS</small><strong>{model.employeesMeetingRequirements}</strong></span><span><small>BELOW REQUIREMENTS</small><strong>{model.employeesBelowRequirements}</strong></span><span><small>RESTRICTED STATS</small><strong>{model.employeesWithUnknownFit}</strong></span></div><div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>POSITION</th><th>WORK STATS</th><th>ROLE FIT</th><th>SPECIALTY</th><th>PRIMARY GAP</th><th>SECONDARY GAP</th><th>WORK STATS EFFECTIVENESS</th><th>INACTIVITY EFFECTIVENESS</th><th>ADDICTION EFFECTIVENESS</th><th>TOTAL POSITION EFFECTIVENESS</th><th>WAGE</th><th>DAYS IN COMPANY</th></tr></thead><tbody>{model.employees.map((employee) => { const effectivenessValues = [employee.addictionEffectiveness, employee.inactivityEffectiveness].filter((value): value is number => value !== null); const riskSeverity = effectivenessValues.some((value) => value <= -12) ? "red" : effectivenessValues.some((value) => value >= -11 && value <= -5) ? "yellow" : null; return <tr key={employee.id} className={riskSeverity ? `employee-effectiveness-risk-${riskSeverity}` : undefined}><td><strong>{employee.name}</strong><div className="muted">#{employee.id}</div></td><td>{employee.positionName}</td><td>{employee.stats ? `MAN ${formatNumber(employee.stats.MAN)} · INT ${formatNumber(employee.stats.INT)} · END ${formatNumber(employee.stats.END)}` : <span className="muted">Restricted</span>}</td><td><span className={`fit-chip ${employee.fit}`}>{employee.fit === "meets" ? "Meets" : employee.fit === "below" ? "Below minimum" : employee.fit === "unknown" ? "Stats hidden" : "Unmapped"}</span></td><td>{employee.requirement?.special ?? "—"}</td><td>{formatNumber(employee.primaryGap)}</td><td>{formatNumber(employee.secondaryGap)}</td><td>{employee.workStatsEffectiveness === null ? "—" : formatNumber(employee.workStatsEffectiveness)}</td><td>{employee.inactivityEffectiveness === null ? "—" : formatNumber(employee.inactivityEffectiveness)}</td><td>{employee.addictionEffectiveness === null ? "—" : formatNumber(employee.addictionEffectiveness)}</td><td>{employee.totalPositionEffectiveness === null ? "—" : formatNumber(employee.totalPositionEffectiveness)}</td><td>{formatMoney(employee.wage)}</td><td>{formatNumber(employee.daysInCompany)}</td></tr> })}</tbody></table></div>{model.employees.length === 0 && <div className="empty-state">The API returned no employees for this company.</div>}{showRaw && <div className="raw-data"><h3>Profile response</h3><pre>{pretty(result?.profile)}</pre><h3>Employee response</h3><pre>{pretty(result?.employees)}</pre></div>}<div className="employee-heading"><div><h3>Position configurations</h3><p>Reference minimums for this company type are maintained in the position catalog.</p></div><button className="text-button" onClick={() => setActiveView("catalog")}>Open position catalog ↗</button></div></> : <div className="empty-state">Connect a company to see employee details and position projections.</div>}
            </section>
          ) : activeView === "dashboard-members" ? (
            <>
            <section className="panel dashboard-members-panel">
              <div className="panel-heading"><div><h2>Dashboard member directory</h2><p>Every account that has signed into the dashboard, including members who have not saved a company profile yet.</p></div><span className="count-chip">{dashboardMembers.length} members</span></div>
              {!sessionToken || demoMode ? <div className="empty-state">Sign in to view the dashboard member directory. It is unavailable in demo mode.</div> : dashboardMembersLoading ? <div className="empty-state">Loading dashboard members…</div> : dashboardMembersError ? <div className="error-banner" role="alert">{dashboardMembersError}</div> : dashboardMembers.length ? <div className="table-scroll"><table className="dashboard-members-table"><thead><tr><th>TORN PLAYER NAME</th><th>PLAYER ID</th><th>COMPANY NAME</th><th>COMPANY TYPE</th><th>COMPANY TYPE_ID</th></tr></thead><tbody>{dashboardMembers.map((member) => <tr key={member.playerId}><td><strong>{member.playerName}</strong></td><td>{member.playerId}</td><td>{member.companyName || "—"}</td><td>{member.companyType || "—"}</td><td>{member.companyTypeId ?? "—"}</td></tr>)}</tbody></table></div> : <div className="empty-state">No dashboard accounts found.</div>}
            </section>
            <InsightsWorkspace view="member-insights" apiBase={API_BASE} sessionToken={sessionToken} isAdmin={isAdmin && !demoMode} demoMode={demoMode} companyId={selectedCompanyId} sharedRosterCompanies={sharedCompanies.filter((company) => company.shareEmployeeData)} model={model ?? null} companyRank={currentRankingCompany ? placement(currentRankingCompany, "type", globalRankingCompanies) : "—"} starRank={currentRankingCompany ? placement(currentRankingCompany, "stars", globalRankingCompanies) : "—"} nextStarGap={nextStarGap} sameTypeCount={companyPeerRows.length} dashboardPreferences={dashboardPreferences} onDashboardPreferencesChange={updateDashboardPreferences} onNavigate={(next) => setActiveView(next)} />
            </>
          ) : activeView === "catalog" ? (
            <section className="panel catalog-panel">
              <div className="panel-heading"><div><h2>Company role library</h2><p>{companyNames.length} company types · position requirements reference</p></div><div className="search-wrap"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search company types..." /></div></div>
              <div className="company-grid">{filteredCompanies.map((name) => <button key={name} className={selectedCompany === name ? "company-card selected" : "company-card"} onClick={() => setSelectedCompany(name)}><span className="company-glyph">{name.slice(0, 1)}</span><span className="company-card-copy"><strong>{name}</strong><small>{catalog.companies[name].length} defined roles</small></span><span className="card-arrow">↗</span></button>)}</div>
              {filteredCompanies.length === 0 && <div className="empty-state">No company types match that search.</div>}
              <div className="role-detail"><div className="role-title"><div><span className="eyebrow">SELECTED COMPANY</span><h3>{selectedCompany}</h3></div><span className="count-chip">{positions.length} positions</span></div><div className="table-scroll"><table><thead><tr><th>ROLE</th><th>PRIMARY STAT</th><th>PRIMARY MIN.</th><th>SECONDARY STAT</th><th>SECONDARY MIN.</th><th>SPECIALTY</th></tr></thead><tbody>{positions.map((position, index) => <tr key={position.rank + index}><td><strong>{position.rank}</strong></td><td><span className="stat-chip">{position.primary}</span></td><td>{position.primaryMin.toLocaleString()}</td><td><span className="stat-chip">{position.secondary}</span></td><td>{position.secondaryMin.toLocaleString()}</td><td>{position.special ? <span className="special-chip">{position.special}</span> : <span className="muted">None</span>}</td></tr>)}</tbody></table></div></div>
            </section>
          ) : activeView === "data-transfer" ? (
            <section className="panel data-transfer-panel">
              <div className="panel-heading"><div><h2>JSON data portability</h2><p>Export each page separately or create a full personal backup. Your Torn API keys and active sessions are never included in backups.</p></div><span className="count-chip">JSON only</span></div>
              {!sessionToken || demoMode ? <div className="empty-state">Sign in to your dashboard account to import or export your saved records. Demo data is not written to your account.</div> : <>
                <div className="transfer-master-row"><div><strong>Master Import / Export</strong><p>Full backup of your own saved company profiles, employee data, stock records, snapshots, chart history, and sharing preferences.</p></div><div className="transfer-actions"><button className="secondary-button" type="button" disabled={transferBusy} onClick={() => void exportPageJson("master")}>Export full backup ↓</button><button className="primary-button" type="button" disabled={transferBusy} onClick={() => importInputs.current.master?.click()}>Import full backup ↑</button><input ref={(element) => { importInputs.current.master = element }} className="transfer-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void importPageJson("master", file) }} /></div></div>
                <div className="transfer-page-list">{transferPages.map((page) => <article className="transfer-page-row" key={page.key}><div><strong>{page.title}</strong><p>{page.description}</p></div><div className="transfer-actions"><button className="secondary-button" type="button" disabled={transferBusy} onClick={() => void exportPageJson(page.key)}>Export JSON ↓</button><button className="text-button" type="button" disabled={transferBusy} onClick={() => importInputs.current[page.key]?.click()}>Import JSON ↑</button><input ref={(element) => { importInputs.current[page.key] = element }} className="transfer-file-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void importPageJson(page.key, file) }} /></div></article>)}</div>
                <div className="transfer-format-note"><strong>Import formats</strong><p>Trends & Charts accepts your earlier history JSON format (<code>sourceSnapshotCreatedAt</code> and <code>companies</code> with daily <code>history</code> records). Other page imports accept matching page exports, and Master Import accepts a full Master backup. Imported history is merged by company and reporting day rather than replacing unrelated records.</p></div>
              </>}
              {transferBusy && <div className="transfer-status" role="status" aria-live="polite"><span className="loading-wheel" /> Processing JSON…</div>}{transferError && <div className="error-banner" role="alert">{transferError}</div>}{transferNotice && <div className="transfer-success" role="status" aria-live="polite">{transferNotice}</div>}
            </section>
          ) : activeView === "data-sharing" ? (
            <section className="panel sharing-control-panel data-sharing-page">
              <div className="panel-heading"><div><h2>Choose who can see your data</h2><p>Sharing is private by default and saved separately for each dashboard member. Choose access independently for trends and charts, stock and advertising details, and employee records. Recipient choices include every dashboard user, regardless of company type.</p></div><span className="count-chip">Per-member access</span></div>
              {sharingSaving && <p className="field-hint" role="status">Saving sharing permission…</p>}{sharingError && <div className="error-banner" role="alert">{sharingError}</div>}{sharingNotice && <p className="sharing-notice" role="status">{sharingNotice}</p>}
              {!sessionToken || demoMode ? <div className="empty-state">Sign in to manage data-sharing permissions. Sharing controls are unavailable in demo mode.</div> : !sharingSettingsLoaded ? <div className="empty-state">Loading sharing permissions…</div> : sharingRecipients.length ? <div className="sharing-recipient-list"><div className="sharing-recipient-row sharing-recipient-header"><strong>DASHBOARD MEMBER</strong><strong>TRENDS & CHARTS</strong><strong>STOCK & AD BUDGET</strong><strong>EMPLOYEE DATA</strong></div>{sharingRecipients.map((recipient) => <div className="sharing-recipient-row" key={recipient.playerId}><div className="sharing-recipient-name"><strong>{recipient.directorName}</strong><small>{recipient.companyName || "No saved company"}{recipient.companyType ? ` · ${recipient.companyType}` : ""}</small></div><label className="recipient-toggle"><span>Trends & charts</span><input type="checkbox" checked={recipient.shareTrendData} onChange={(event) => void updateSharingRecipient(recipient.playerId, "shareTrendData", event.target.checked)} disabled={!sessionToken || demoMode || sharingSaving || !sharingSettingsLoaded} /></label><label className="recipient-toggle"><span>Stock & ad budget</span><input type="checkbox" checked={recipient.shareFinancialData} onChange={(event) => void updateSharingRecipient(recipient.playerId, "shareFinancialData", event.target.checked)} disabled={!sessionToken || demoMode || sharingSaving || !sharingSettingsLoaded} /></label><label className="recipient-toggle"><span>Employee data</span><input type="checkbox" checked={recipient.shareEmployeeData} onChange={(event) => void updateSharingRecipient(recipient.playerId, "shareEmployeeData", event.target.checked)} disabled={!sessionToken || demoMode || sharingSaving || !sharingSettingsLoaded} /></label></div>)}</div> : <div className="empty-state">No other dashboard members have signed in yet. Members will appear here when they create a dashboard account.</div>}
            </section>
          ) : activeView === "connect" ? (
            <div className="settings-workspace"><NotificationSettingsPanel apiBase={API_BASE} sessionToken={sessionToken} demoMode={demoMode} /><section className="connect-layout">
              <div className="panel connect-panel"><div className="panel-heading"><div><h2>Torn API & company connections</h2><p>Manage your player login and authorized company keys for companies you direct.</p></div><span className="big-icon">⌁</span></div><form onSubmit={connectCompany}><label htmlFor="company-key">{needsSecondaryKey ? "First company API key" : "Add another company API key"}</label><input id="company-key" type="password" autoComplete="off" value={secondaryCompanyKey} onChange={(event) => setSecondaryCompanyKey(event.target.value)} placeholder={demoMode ? "Disabled in demo mode" : "Paste an authorized API key for a company you are permitted to manage"} disabled={demoMode} /><p className="field-hint"><span>♥</span> "Each key is validated for company profile and employee access, then saved against that company. Only add keys you have permission to use."</p>{error && <div className={`error-banner${error.startsWith("ACCESS DENIED:") ? " access-denied-banner" : ""}`} role="alert">{error.startsWith("ACCESS DENIED:") && <strong>ACCESS DENIED · NAUGHTY SOULS MEMBERSHIP REQUIRED</strong>}{error.startsWith("ACCESS DENIED:") && <br />}{error}</div>}{demoMode && <p className="demo-caption">This tutorial workspace is read-only. Exit demo to connect real Torn data.</p>}<button className="primary-button form-submit" disabled={loading || demoMode}>{loading ? <><span className="spinner" /> Connecting...</> : <>Fetch company data <span>↗</span></>}</button></form>{sessionToken && <div className="key-store-panel"><div><strong>{keySaved ? "Torn API key saved" : "No Torn API key saved"}</strong><p>"Company keys are encrypted and stored separately, so adding another company does not replace your other saved company keys."</p></div>{(keySaved || companyKeySaved) && <button className="text-button danger-text" type="button" onClick={deleteSavedKey}>Permanently delete saved keys</button>}{savedCompanies.length > 0 && <div className="saved-company-list"><strong>Saved company records</strong>{savedCompanies.map((company) => <div key={company.company_id} className="saved-company-row"><button type="button" className="saved-company-link" onClick={() => void loadSavedCompany(company.company_id)}><span className="saved-company-title">{company.company_name || `Company #${company.company_id}`}</span><span>#{company.company_id}</span></button>{company.has_api_key && <button type="button" className="text-button danger-text saved-company-remove" disabled={companyKeyActionBusy !== ""} onClick={() => void deleteSavedCompanyKey(company)}>{companyKeyActionBusy === company.company_id ? "Removing…" : "Remove key"}</button>}</div>)}</div>}</div>}{sessionToken && <div className="key-store-panel"><div><strong>Account security</strong><p>Sign out of all active dashboard sessions while keeping saved keys and company history.</p></div><button className="text-button danger-text" type="button" disabled={sessionActionBusy || demoMode} onClick={() => void signOutEverywhere()}>{sessionActionBusy ? "Revoking sessions…" : "Sign out all devices"}</button></div>}</div>
              <div className="panel guide-panel"><span className="guide-icon">✓</span><h2>Before you connect</h2><ul><li>Use a Torn API key with the access needed for your company.</li><li>Private employee stats may only be available to authorized company directors.</li><li>Requests pass through the Cloudflare Worker to Torn's API.</li></ul><div className="guide-note"><strong>Privacy by design</strong><p>Your player account is identified by Torn. Deleting the saved key does not delete recorded company data.</p></div></div>
            </section></div>
          ) : (
            <>
              {model ? <>
                <section className="panel company-panel company-overview-panel"><div className="panel-heading"><div><h2>{model.company.name}</h2><p>{model.company.typeName} · Company #{model.company.id}</p></div><span className="status-badge success"><i /> COMPANY DATA</span></div>
                  <div className="company-facts overview-facts"><div><small>COMPANY TYPE</small><strong>{model.company.typeName}</strong></div><div><small>EMPLOYEES</small><strong>{formatNumber(model.company.employeesHired ?? model.employees.length)} / {formatNumber(model.company.employeeCapacity)}</strong></div><div><small>STAR RATING</small><strong>{currentStar === null ? "—" : `${currentStar} ★`}</strong></div><div><small>DIRECTOR</small><strong>{model.company.directorName ?? "Restricted"}</strong></div></div>
                  {highRiskEmployeeAlerts.length > 0 && <section className="employee-risk-overview" aria-label="Employee addiction and inactivity alerts"><div className="employee-risk-overview-heading"><div><h3>Employee effectiveness alerts</h3><p>Flags apply independently when either addiction or inactivity effectiveness reaches the warning thresholds.</p></div><span className="count-chip">{highRiskEmployeeAlerts.length} high risk</span></div><div className="employee-risk-overview-list">{highRiskEmployeeAlerts.map((employee) => <article key={employee.id} className={`employee-risk-overview-item employee-risk-${employee.riskSeverity}`}><div className="employee-risk-name"><strong>{employee.name}</strong><span>{employee.riskSeverity === "red" ? "HIGH RISK" : "WATCH"}</span></div><div className="employee-risk-last-seen" title={employee.lastAction || undefined}><span className="employee-risk-last-seen-dot" aria-hidden="true" />{formatLastSeenElapsed(employee.lastActionTimestamp)}</div><div className="employee-risk-values"><span>Addiction <strong>{formatNumber(employee.addictionEffectiveness)}</strong></span><span>Inactivity <strong>{formatNumber(employee.inactivityEffectiveness)}</strong></span></div><div className="employee-risk-trigger">Triggered by: {employee.flaggedMetrics.map((metric) => `${metric.label} ${metric.value} (${metric.severity === "red" ? "red alert" : "yellow alert"})`).join(" · ")}</div></article>)}</div><button type="button" className="text-button" onClick={() => setActiveView("employees")}>View employee details →</button></section>}<div className="income-grid"><article><small>DAILY INCOME</small><strong>{formatMoney(model.company.dailyIncome)}</strong><span className="profit-line">Profit {formatMoney(dailyProfit)}</span></article><article><small>WEEKLY INCOME</small><strong>{formatMoney(weeklyIncome)}</strong><span className="profit-line">Profit {formatMoney(weeklyProfit)}</span><span>Sunday 18:00 UTC to Sunday 18:00 UTC</span></article><article><small>MONTH-TO-DATE INCOME</small><strong>{formatMoney(monthlyIncome)}</strong><span className="profit-line">Profit {formatMoney(monthlyProfit)}</span><span>Since the 1st at 18:00 UTC</span></article></div><div className="overview-financial-strip"><article><small>CURRENT AD BUDGET</small><strong>{formatMoney(costs?.adBudget)}</strong><span>Daily advertising spend configured in Torn</span></article><article className="overview-stock-prices"><small>STOCK</small>{currentStockRows.length ? <><div className="stock-price-list stock-inventory-table"><div className="stock-inventory-header"><span>STOCK NAME</span><span>CURRENT QTY</span><span>SET PRICE</span><span>CURRENT VALUE</span></div>{currentStockRows.map((item, index) => <div className="stock-inventory-row" key={`${item.name}-${index}`}><span>{item.name}</span><strong>{item.quantity === null ? "—" : formatNumber(item.quantity)}</strong><strong>{item.price === null ? "—" : formatMoney(item.price)}</strong><strong>{item.quantity === null || item.price === null ? "—" : formatMoney(Math.max(0, item.quantity) * Math.max(0, item.price))}</strong></div>)}<div className="stock-value-total"><span>TOTAL STOCK VALUE</span><strong>{hasTotalStockValue ? formatMoney(totalStockValue) : "—"}</strong></div><div className="stock-difference-row"><span>STOCK DIFFERENCE</span><strong className={stockDifference === null ? "" : stockDifference > 0 ? "stock-difference-positive" : stockDifference < 0 ? "stock-difference-negative" : ""}>{stockDifference === null ? "—" : `${stockDifference > 0 ? "+" : ""}${formatNumber(stockDifference)}`}</strong></div></div></> : <span>Current stock details were not returned by Torn for this company key.</span>}</article></div>{costs && <p className="profit-footnote">Estimated daily operating costs: {formatMoney(costs.adBudget)} ad budget + {formatMoney(costs.wages)} employee wages{costs.hasStockCosts ? <> + {formatMoney(costs.stockCosts)} stock costs</> : null} = <strong className="numeric-value">{formatMoney(costs.dailyCosts)}</strong> total. Stock costs are included when the company has stock with recorded cost data. Recorded coverage: {weekCoverage}/{expectedReportingDays(weekStart)} reporting days this week and {monthCoverage}/{expectedReportingDays(monthStart)} month-to-date. Weekly profit uses the latest imported reported total when available; month-to-date profit sums captured daily-profit snapshots, so incomplete coverage is shown as partial.</p>}
                  <div className="ratings-section"><div className="section-heading"><div><h3>Operating ratings</h3><p>Current company performance indicators from Torn.</p></div></div><div className="ratings-grid"><div><span>POPULARITY</span><strong>{formatNumber(popularity)}</strong></div><div><span>EFFICIENCY</span><strong>{formatNumber(efficiency)}</strong></div><div><span>ENVIRONMENT</span><strong>{formatNumber(environment)}</strong></div></div></div>
                  <div className="employee-heading overview-actions"><div><h3>Company health scorecard</h3><p>Benchmarked against companies of the same type.</p></div><button className="text-button" onClick={() => setActiveView("type-rankings")}>View rankings ↗</button></div>
                  <div className="health-grid"><div><small>COMPANY RANK</small><strong>{currentRankingCompany ? placement(currentRankingCompany, "type", globalRankingCompanies) : "—"}</strong><span>Rank among all companies of this type</span></div><div><small>STAR RANK</small><strong>{currentRankingCompany ? placement(currentRankingCompany, "stars", globalRankingCompanies) : "—"}</strong><span>Rank among companies of the same type and star level</span></div><div><small>WEEKLY INCOME VS TYPE</small><strong>{currentRankingCompany && currentRankingCompany.weeklyIncome !== null ? formatMoney(currentRankingCompany.weeklyIncome) : formatMoney(currentWeeklyIncome)}</strong><span>{companyPeerRows.length ? `${companyPeerRows.length} same-type companies in snapshot` : "Comparison snapshot unavailable"}</span></div><div><small>GAP TO NEXT STAR</small><strong>{nextStarGap === null ? "—" : formatMoney(nextStarGap)}</strong><span>{nextStarIncome === null ? "No higher-star benchmark available" : `Observed next-level benchmark: ${formatMoney(nextStarIncome)}/week`}</span></div><div><small>GAP TO PREVIOUS STAR</small><strong>{previousStarGap === null ? "—" : formatMoney(previousStarGap)}</strong><span>{previousStarIncome === null ? "No lower-star benchmark available" : `Observed previous-level benchmark: ${formatMoney(previousStarIncome)}/week`}</span></div></div>
                  <div className="overview-bottom-actions"><button className="secondary-button" onClick={() => setActiveView("employees")}>Open employee details <span>→</span></button><button className="text-button" onClick={() => setShowRaw((current) => !current)}>{showRaw ? "Hide raw API data" : "Inspect API data"}</button></div>{showRaw && <div className="raw-data"><h3>Profile response</h3><pre>{pretty(result?.profile)}</pre></div>}
                </section>
              </> : <section className="panel company-panel"><div className="empty-company"><div className="empty-illustration"><div className="empty-ring ring-one" /><div className="empty-ring ring-two" /><div className="empty-center">NC</div><span className="float-star star-one">✓</span><span className="float-star star-two">✦</span></div><h3>Your company workspace is ready.</h3><p>Connect your Torn company to see its details, income, operating ratings, and competitive health scorecard.</p><p className="empty-company-connect-hint">Use the ＋ button in the company selector above to connect a company.</p></div></section>}
              <section className="content-grid overview-quick-grid"><article className="panel quick-panel"><div className="panel-heading"><div><h2>Company tools</h2><p>Open a focused workspace when you need more detail.</p></div></div><button className="quick-link" onClick={() => setActiveView("employees")}><span className="quick-icon violet">♙</span><span><strong>Employee operations</strong><small>Role fit, work stats, wages, and requirement gaps</small></span><b>→</b></button><button className="quick-link" onClick={() => setActiveView("catalog")}><span className="quick-icon blue">▦</span><span><strong>Position catalog</strong><small>Reference role requirements by company type</small></span><b>→</b></button></article></section>
            </>
          )}
          <footer className="page-footer"><span>NAUGHTY COMPANY DASHBOARD <b>•</b> DEVELOPMENT BUILD</span><span>POWERED BY TORN API & CLOUDFLARE</span></footer>
        </div>
      </main>
    </div>
  )
}
