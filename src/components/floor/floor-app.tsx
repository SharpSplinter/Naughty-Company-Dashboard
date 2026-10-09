import { useEffect, useMemo, useState } from "react"
import positionsData from "../../lib/company/positions.json"
import { runEngine } from "../../lib/company/engine"
import type { CompanyDashboardModel, CompanyPositionCatalog } from "../../lib/company/types"

const catalog = positionsData as CompanyPositionCatalog
const companyNames = Object.keys(catalog.companies).sort()
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
  || "https://naughty-company-api.kboone801.workers.dev"

type ApiResult = { model: CompanyDashboardModel; profile: unknown; employees: unknown }
type SavedCompany = { company_id: string; company_name: string | null; company_type: string | null; fetched_at: string }
type RankingCompany = { companyId: string; companyName: string; companyType: string; companyTypeId: number | string | null; starRating: number | null; weeklyIncome: number | null; dailyIncome: number | null; averageDailyIncome: number | null; directorName: string; playerId: string; fetchedAt: string }

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

export function FloorApp() {
  const [activeView, setActiveView] = useState<"overview" | "catalog" | "connect" | "type-rankings" | "faction-rankings">("overview")
  const [search, setSearch] = useState("")
  const [selectedCompany, setSelectedCompany] = useState(companyNames[0] ?? "")
  const [apiKey, setApiKey] = useState("")
  const [secondaryCompanyKey, setSecondaryCompanyKey] = useState("")
  const [companyKeySaved, setCompanyKeySaved] = useState(false)
  const [isDirector, setIsDirector] = useState(false)
  const [result, setResult] = useState<ApiResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [sessionToken, setSessionToken] = useState("")
  const [authChecking, setAuthChecking] = useState(true)
  const [playerName, setPlayerName] = useState("")
  const [keySaved, setKeySaved] = useState(false)
  const [savedCompanies, setSavedCompanies] = useState<SavedCompany[]>([])
  const [rankingCompanies, setRankingCompanies] = useState<RankingCompany[]>([])
  const [globalRankingCompanies, setGlobalRankingCompanies] = useState<RankingCompany[]>([])
  const [rankingsUpdatedAt, setRankingsUpdatedAt] = useState("")
  const [rankingError, setRankingError] = useState("")
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
        setKeySaved(session.key.saved)
        setIsDirector(session.company?.isDirector ?? false)
        setCompanyKeySaved(session.company?.key?.saved ?? false)
        const listResponse = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${token}` } })
        if (!listResponse.ok) return
        const list = await listResponse.json() as { companies: SavedCompany[] }
        if (cancelled) return
        setSavedCompanies(list.companies || [])
        if (list.companies?.length) {
          const dataResponse = await fetch(`${API_BASE}/api/me/companies/${list.companies[0].company_id}`, { headers: { Authorization: `Bearer ${token}` } })
          if (!dataResponse.ok || cancelled) return
          const data = await dataResponse.json() as { profile: unknown; employees: unknown }
          const normalized = runEngine(data.profile, data.employees, catalog)
          if (normalized && !cancelled) setResult({ profile: data.profile, employees: data.employees, model: normalized })
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
    if (!sessionToken || (activeView !== "type-rankings" && activeView !== "faction-rankings")) return
    let cancelled = false
    async function loadRankings() {
      setRankingError("")
      try {
        const scope = activeView === "type-rankings" ? "global" : "faction"
        const response = await fetch(`${API_BASE}/api/rankings?scope=${scope}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
        const payload = await response.json() as { error?: string; companies?: RankingCompany[]; generatedAt?: string }
        if (!response.ok) throw new Error(payload.error || "Could not load company rankings.")
        if (cancelled) return
        const sorted = (payload.companies || []).slice().sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1))
        setRankingCompanies(sorted)
        let globalRows = sorted
        if (scope === "global") setGlobalRankingCompanies(sorted)
        else {
          try {
            const globalResponse = await fetch(`${API_BASE}/api/rankings?scope=global`, { headers: { Authorization: `Bearer ${sessionToken}` } })
            const globalPayload = await globalResponse.json() as { companies?: RankingCompany[] }
            if (globalResponse.ok && Array.isArray(globalPayload.companies)) {
              globalRows = globalPayload.companies.slice().sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1))
              setGlobalRankingCompanies(globalRows)
            }
          } catch { /* Keep faction rankings usable if the all-Torn reference cannot load. */ }
        }
        setRankingsUpdatedAt(payload.generatedAt || "")
        setSelectedRankingType((current) => current || sorted[0]?.companyType || "")
      } catch (caught) {
        if (!cancelled) setRankingError(caught instanceof Error ? caught.message : "Could not load company rankings.")
      }
    }
    void loadRankings()
    return () => { cancelled = true }
  }, [activeView, sessionToken])

  const filteredCompanies = useMemo(
    () => companyNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())),
    [search],
  )
  const positions = catalog.companies[selectedCompany] ?? []
  const model = result?.model
  const rankingRows = useMemo(() => rankingCompanies
    .filter((company) => activeView !== "type-rankings" || !selectedRankingType || company.companyType === selectedRankingType)
    .slice()
    .sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1)), [rankingCompanies, activeView, selectedRankingType])
  const allTornRows = globalRankingCompanies.length ? globalRankingCompanies : activeView === "type-rankings" ? rankingCompanies : []
  const companyTypeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const company of allTornRows) counts.set(company.companyType, (counts.get(company.companyType) || 0) + 1)
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [allTornRows])
  function placement(company: RankingCompany, dimension: "type" | "stars"): string {
    const target = allTornRows.find((row) => row.companyId === company.companyId)
    if (!target) return "—"
    const reference = dimension === "type"
      ? allTornRows.filter((row) => row.companyType === target.companyType)
      : allTornRows.filter((row) => row.starRating !== null && row.starRating === target.starRating)
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
      setIsDirector(false)
      setApiKey("")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not delete the saved key.") }
  }

  async function loadSavedCompany(id: string) {
    if (!sessionToken) return
    setError("")
    setLoading(true)
    try {
      const response = await fetch(`${API_BASE}/api/me/companies/${id}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string; profile?: unknown; employees?: unknown }
      if (!response.ok) throw new Error(payload.error || "Could not load saved company data.")
      const normalized = runEngine(payload.profile, payload.employees, catalog)
      if (!normalized) throw new Error("The saved company profile could not be normalized.")
      setResult({ profile: payload.profile, employees: payload.employees, model: normalized })
      setActiveView("overview")
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load saved company data.") }
    finally { setLoading(false) }
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
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
      setKeySaved(payload.key?.saved ?? true)
      setIsDirector(payload.company?.isDirector ?? false)
      setCompanyKeySaved(payload.company?.key?.saved ?? false)
      setApiKey("")
      setSecondaryCompanyKey("")
      const listResponse = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${payload.token}` } })
      if (listResponse.ok) {
        const list = await listResponse.json() as { companies: SavedCompany[] }
        setSavedCompanies(list.companies || [])
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.")
    } finally { setLoading(false) }
  }

  function signOut() {
    sessionStorage.removeItem("ncd_session")
    setSessionToken("")
    setPlayerName("")
    setKeySaved(false)
    setCompanyKeySaved(false)
    setIsDirector(false)
    setSecondaryCompanyKey("")
    setSavedCompanies([])
    setResult(null)
    setApiKey("")
    setActiveView("overview")
  }

  async function connectCompany(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    if (!sessionToken && !apiKey.trim()) { setError("Sign in with your Torn API key to create your player workspace."); return }
    setLoading(true)
    try {
      let token = sessionToken
      if (secondaryCompanyKey.trim()) {
        if (!token) throw new Error("Sign in with your primary Torn API key first.")
        const keyResponse = await fetch(`${API_BASE}/api/auth/company-key`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ apiKey: secondaryCompanyKey.trim() }) })
        const keyPayload = await keyResponse.json() as { error?: string; saved?: boolean }
        if (!keyResponse.ok) throw new Error(keyPayload.error || "Could not save the secondary company key.")
        setCompanyKeySaved(true)
        setSecondaryCompanyKey("")
      }
      if (!token) throw new Error("Sign in with a Torn API key first.")
      const response = await fetch(`${API_BASE}/api/company/refresh`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })
      const payload = await response.json() as { error?: string; profile?: unknown; employees?: unknown }
      if (!response.ok) throw new Error(payload.error || "The API request failed. Check the key and its company-data permissions.")
      const normalized = runEngine(payload.profile, payload.employees, catalog)
      if (!normalized) throw new Error("Torn returned an unexpected company profile. The response was not added to your saved workspace.")
      setResult({ profile: payload.profile, employees: payload.employees, model: normalized })
      setActiveView("overview")
      const listResponse = await fetch(`${API_BASE}/api/me/companies`, { headers: { Authorization: `Bearer ${token}` } })
      if (listResponse.ok) { const list = await listResponse.json() as { companies: SavedCompany[] }; setSavedCompanies(list.companies || []) }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not connect to the Torn API.") }
    finally { setLoading(false) }
  }

  if (authChecking) return <div className="login-screen"><div className="login-card login-loading"><span className="brand-mark">NC</span><p>Checking your member session…</p></div></div>

  if (!sessionToken) return (
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
          <label htmlFor="login-company-key">Secondary company key <span className="muted">(only if you are not a company director)</span></label>
          <input id="login-company-key" type="password" autoComplete="off" spellCheck={false} value={secondaryCompanyKey} onChange={(event) => setSecondaryCompanyKey(event.target.value)} placeholder="Optional: company director key" />
          <p className="login-hint">If your login key is not a director key, a saved secondary key is reused automatically. You can also enter or replace it here.</p>
          {error && <div className={`error-banner${error.startsWith("ACCESS DENIED:") ? " access-denied-banner" : ""}`} role="alert">{error.startsWith("ACCESS DENIED:") && <strong>ACCESS DENIED · NAUGHTY SOULS MEMBERSHIP REQUIRED</strong>}{error.startsWith("ACCESS DENIED:") && <br />}{error}</div>}
          <button className="primary-button form-submit" disabled={loading}>{loading ? <><span className="spinner" /> Verifying key…</> : <>Sign in securely <span>→</span></>}</button>
        </form>
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
          <button className={activeView === "catalog" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("catalog")}><span>▦</span> Position catalog <em>{companyNames.length}</em></button>
          <button className={activeView === "type-rankings" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("type-rankings")}><span>↗</span> Company rankings</button>
          <button className={activeView === "faction-rankings" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("faction-rankings")}><span>♜</span> Faction rankings</button>
          <button className={activeView === "connect" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("connect")}><span>⌁</span> Connect Torn API</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-indicator"><span className={result ? "status-dot live" : "status-dot"} />{keySaved ? `Signed in${playerName ? ` as ${playerName}` : ""}` : "Player signed in · key deleted"}</div><button className="signout-button" onClick={signOut}>Sign out</button>
          <div className="sidebar-foot">EARLY ACCESS <span>•</span> BUILD 0.2</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">Workspace <span>/</span> <strong>{activeView === "overview" ? "Overview" : activeView === "catalog" ? "Position catalog" : activeView === "type-rankings" ? "Company rankings" : activeView === "faction-rankings" ? "Faction rankings" : "Connect Torn API"}</strong></div>
          <div className="topbar-right"><span className="environment-pill"><i /> CLOUDFLARE WORKER</span><div className="avatar">NC</div></div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div><div className="eyebrow"><span className="eyebrow-line" /> COMPANY INTELLIGENCE</div><h1>{activeView === "overview" ? "Operations overview" : activeView === "catalog" ? "Position catalog" : activeView === "type-rankings" ? "Company type rankings" : activeView === "faction-rankings" ? "Faction company rankings" : "Connect your company"}</h1><p className="subtitle">{activeView === "overview" ? "Your company, your people, one clear picture." : activeView === "catalog" ? "Explore role requirements across the Torn company ecosystem." : activeView === "type-rankings" ? "Compare companies within the same Torn company type, ranked by weekly income." : activeView === "faction-rankings" ? "See how dashboard-connected Naughty Souls companies stack up across the faction." : "Pull live company data through your secure API connection."}</p></div>
            <button className="primary-button" onClick={() => setActiveView("connect")}><span>＋</span> Connect company</button>
          </section>

          {activeView === "type-rankings" || activeView === "faction-rankings" ? (
            <section className="panel ranking-panel">
              <div className="panel-heading ranking-heading"><div><h2>{activeView === "type-rankings" ? "Rank within company type" : "Naughty Souls dashboard leaderboard"}</h2><p>{activeView === "type-rankings" ? "All companies in Torn, grouped by company type. Weekly income alone determines rank." : "Only companies connected by Naughty Souls dashboard users, ordered by weekly income."}</p></div>{activeView === "type-rankings" && <label className="ranking-filter">Company type<select value={selectedRankingType} onChange={(event) => setSelectedRankingType(event.target.value)}><option value="">All types</option>{Array.from(new Set(rankingCompanies.map((company) => company.companyType))).sort().map((type) => <option key={type} value={type}>{type}</option>)}</select></label>}</div>
              <div className="ranking-meta"><span><i className="status-dot live" /> {rankingCompanies.length.toLocaleString()} {activeView === "type-rankings" ? "companies in Torn snapshot" : "companies from dashboard users"}</span><span>Data refresh: daily at 18:05 UTC · Star ratings update Sundays after 18:00 UTC</span></div>
              <div className="type-counts"><strong>COMPANIES BY TYPE</strong><div className="type-count-list">{companyTypeCounts.map(([type, count]) => <span key={type} className="type-count-chip">{type}<b>{count.toLocaleString()}</b></span>)}{companyTypeCounts.length === 0 && <span className="muted">Type counts load with the all-Torn snapshot.</span>}</div></div>{rankingError && <div className="error-banner" role="alert">{rankingError}</div>}
              <div className="table-scroll"><table className="ranking-table"><thead><tr><th>RANK</th><th>COMPANY</th>{activeView === "faction-rankings" && <th>DIRECTOR</th>}<th>TYPE</th><th>STARS</th><th>STAR-LEVEL PLACE</th><th>TYPE PLACE</th><th>WEEKLY INCOME</th><th>DAILY INCOME</th><th>AVG / DAY</th><th>DATA AS OF (UTC)</th></tr></thead><tbody>{rankingRows.map((company, index) => <tr key={`${company.playerId}-${company.companyId}`}><td><span className={`rank-number $(company.weeklyIncome !== null && rankingRows.findIndex((row) => row.weeklyIncome === company.weeklyIncome) < 3) ? "top-rank" : ""}`}>{company.weeklyIncome === null ? "—" : rankingRows.findIndex((row) => row.weeklyIncome === company.weeklyIncome) + 1}</span></td><td><strong>{company.companyName}</strong><div className="muted">Company #{company.companyId}</div></td>{activeView === "faction-rankings" && <td>{company.directorName}</td>}<td>{company.companyType}</td><td><span className="star-rating">{company.starRating === null ? "—" : `${company.starRating} ★`}</span></td><td>{placement(company, "stars")}</td><td>{placement(company, "type")}</td><td className="income-primary">{formatMoney(company.weeklyIncome)}</td><td>{formatMoney(company.dailyIncome)}</td><td>{formatMoney(company.averageDailyIncome)}</td><td className="muted">{company.fetchedAt ? new Date(company.fetchedAt).toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) : "—"}</td></tr>)}</tbody></table></div>
              {rankingRows.length === 0 && <div className="empty-state">{activeView === "type-rankings" ? "The all-company Torn snapshot is empty or unavailable." : "No Naughty Souls companies have been added by dashboard users yet. A director can connect a company key to add a company."}</div>}
              <div className="ranking-footnote"><strong>How ranking works</strong><p>Rank is determined exclusively by weekly income, highest first. Average daily income is weekly income divided by seven. Company Rankings uses Torn’s all-company snapshot. Faction Rankings only includes companies connected by dashboard users.</p><p>{rankingsUpdatedAt ? `${activeView === "type-rankings" ? "Torn snapshot retrieved" : "Faction leaderboard checked"} ${new Date(rankingsUpdatedAt).toLocaleString("en-GB", { timeZone: "UTC", timeZoneName: "short" })}.` : "Leaderboard refreshes from saved company profiles."} Daily company income data locks at 18:00 UTC; star-rating changes lock on Sundays at 18:00 UTC.</p></div>
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
              <div className="panel connect-panel"><div className="panel-heading"><div><h2>Connect to Torn</h2><p>Fetch profile and employee data for the company linked to your key</p></div><span className="big-icon">⌁</span></div><form onSubmit={connectCompany}><label htmlFor="company-key">{isDirector ? "Company key" : "Secondary company key"}</label><input id="company-key" type="password" autoComplete="off" value={secondaryCompanyKey} onChange={(event) => setSecondaryCompanyKey(event.target.value)} placeholder={isDirector ? "Director login key is used automatically" : companyKeySaved ? "Saved secondary key is active; enter to replace" : "Enter a company director key"} /><p className="field-hint"><span>♢</span> {isDirector ? "Your login key is also your primary company key." : companyKeySaved ? "Your encrypted secondary company key is saved and used by default on future logins." : "Your login key is for identity only. If you are not a company director, add a secondary key with company profile and employee access."}</p>{error && <div className={`error-banner${error.startsWith("ACCESS DENIED:") ? " access-denied-banner" : ""}`} role="alert">{error.startsWith("ACCESS DENIED:") && <strong>ACCESS DENIED · NAUGHTY SOULS MEMBERSHIP REQUIRED</strong>}{error.startsWith("ACCESS DENIED:") && <br />}{error}</div>}<button className="primary-button form-submit" disabled={loading}>{loading ? <><span className="spinner" /> Connecting...</> : <>Fetch company data <span>↗</span></>}</button></form>{sessionToken && <div className="key-store-panel"><div><strong>{keySaved ? "Torn API key saved" : "No Torn API key saved"}</strong><p>{isDirector ? "Your primary login key is also the company key." : companyKeySaved ? "Your secondary company key is encrypted at rest and used automatically for company refreshes." : "You are signed in, but a secondary company key is needed to refresh company data."}</p></div>{(keySaved || companyKeySaved) && <button className="text-button danger-text" type="button" onClick={deleteSavedKey}>Permanently delete saved keys</button>}{savedCompanies.length > 0 && <div className="saved-company-list"><strong>Saved company records</strong>{savedCompanies.map((company) => <button key={company.company_id} type="button" className="saved-company-link" onClick={() => void loadSavedCompany(company.company_id)}>{company.company_name || `Company #${company.company_id}`} <span>#{company.company_id}</span></button>)}</div>}</div>}</div>
              <div className="panel guide-panel"><span className="guide-icon">✳</span><h2>Before you connect</h2><ul><li>Use a Torn API key with the access needed for your company.</li><li>Private employee stats may only be available to authorized company directors.</li><li>Requests pass through the Cloudflare Worker to Torn's API.</li></ul><div className="guide-note"><strong>Privacy by design</strong><p>Your player account is identified by Torn. Deleting the saved key does not delete recorded company data.</p></div></div>
            </section>
          ) : (
            <>
              <section className="metrics-grid">
                <article className="metric-card"><div className="metric-top"><span>COMPANY TYPES</span><span className="metric-icon violet">▦</span></div><div className="metric-value">{companyNames.length}</div><div className="metric-foot"><span className="metric-dot violet-dot" /> In the position catalog</div><div className="metric-spark spark-violet"><i /><i /><i /><i /><i /><i /><i /></div></article>
                <article className="metric-card"><div className="metric-top"><span>DEFINED POSITIONS</span><span className="metric-icon blue">♙</span></div><div className="metric-value">{Object.values(catalog.companies).reduce((sum, roles) => sum + roles.length, 0)}</div><div className="metric-foot"><span className="metric-dot blue-dot" /> Across all company types</div><div className="metric-spark spark-blue"><i /><i /><i /><i /><i /><i /><i /></div></article>
                <article className="metric-card"><div className="metric-top"><span>LIVE EMPLOYEES</span><span className="metric-icon green">♧</span></div><div className="metric-value">{model ? model.employees.length : "—"}</div><div className="metric-foot"><span className={model ? "metric-dot green-dot" : "metric-dot"} /> {model ? "Normalized from Torn API" : "Connect a company to load"}</div><div className="metric-spark spark-green"><i /><i /><i /><i /><i /><i /><i /></div></article>
                <article className="metric-card"><div className="metric-top"><span>ROLE REQUIREMENTS</span><span className="metric-icon amber">⌁</span></div><div className="metric-value metric-status">{model ? `${model.employeesMeetingRequirements}/${model.matchedPositionCount}` : "—"}</div><div className="metric-foot"><span className={model ? "metric-dot green-dot" : "metric-dot amber-dot"} /> {model ? "Employees meeting listed minimums" : "Awaiting company data"}</div><div className="metric-orbit">◎</div></article>
              </section>
              <section className="content-grid">
                <article className="panel company-panel"><div className="panel-heading"><div><h2>{model ? model.company.name : "Your company workspace"}</h2><p>{model ? `${model.company.typeName} · Company #${model.company.id}` : "Live company data appears here after connection"}</p></div><span className={model ? "status-badge success" : "status-badge pending"}><i /> {model ? "LIVE DATA" : "NOT CONNECTED"}</span></div>
                  {model ? <><div className="company-facts"><div><small>COMPANY RATING</small><strong>{formatNumber(model.company.rating)}</strong></div><div><small>EMPLOYEES / CAPACITY</small><strong>{formatNumber(model.company.employeesHired ?? model.employees.length)} / {formatNumber(model.company.employeeCapacity)}</strong></div><div><small>DAILY INCOME</small><strong>{formatMoney(model.company.dailyIncome)}</strong></div><div><small>DIRECTOR</small><strong>{model.company.directorName ?? "Restricted"}</strong></div></div><div className="employee-heading"><div><h3>Employees</h3><p>{model.matchedPositionCount} mapped to catalog roles · {model.employeesWithUnknownFit} with restricted stats</p></div><button className="text-button" onClick={() => setShowRaw((current) => !current)}>{showRaw ? "Hide raw data" : "Inspect API"} ↗</button></div><div className="table-scroll"><table><thead><tr><th>EMPLOYEE</th><th>POSITION</th><th>WORK STATS</th><th>ROLE FIT</th><th>DAYS</th></tr></thead><tbody>{model.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name}</strong><div className="muted">#{employee.id}</div></td><td>{employee.positionName}</td><td>{employee.stats ? `MAN ${formatNumber(employee.stats.MAN)} · INT ${formatNumber(employee.stats.INT)} · END ${formatNumber(employee.stats.END)}` : <span className="muted">Restricted</span>}</td><td><span className={`fit-chip ${employee.fit}`}>{employee.fit === "meets" ? "Meets" : employee.fit === "below" ? "Below minimum" : employee.fit === "unknown" ? "Stats hidden" : "Unmapped"}</span></td><td>{formatNumber(employee.daysInCompany)}</td></tr>)}</tbody></table></div>{model.employees.length === 0 && <div className="empty-state">The API returned no employees for this company.</div>}{showRaw && <div className="raw-data"><h3>Profile response</h3><pre>{pretty(result?.profile)}</pre><h3>Employee response</h3><pre>{pretty(result?.employees)}</pre></div>}</> : <div className="empty-company"><div className="empty-illustration"><div className="empty-ring ring-one" /><div className="empty-ring ring-two" /><div className="empty-center">NC</div><span className="float-star star-one">✳</span><span className="float-star star-two">✦</span></div><h3>Your next move starts here.</h3><p>Connect your Torn company to turn employee and company data into a useful operations view.</p><button className="secondary-button" onClick={() => setActiveView("connect")}>Set up connection <span>→</span></button></div>}
                </article>
                <article className="panel quick-panel"><div className="panel-heading"><div><h2>Quick access</h2><p>Jump back into your workflow</p></div></div><button className="quick-link" onClick={() => setActiveView("catalog")}><span className="quick-icon violet">▦</span><span><strong>Position catalog</strong><small>Review role and stat requirements</small></span><b>→</b></button><button className="quick-link" onClick={() => setActiveView("connect")}><span className="quick-icon blue">⌁</span><span><strong>Connect Torn API</strong><small>Load company and employee data</small></span><b>→</b></button><div className="api-note"><span>✳</span><div><strong>Role fit is permission-aware</strong><p>When Torn hides work stats, the dashboard shows “Stats hidden” instead of treating missing values as zero.</p></div></div></article>
              </section>
            </>
          )}
          <footer className="page-footer"><span>NAUGHTY COMPANY DASHBOARD <b>•</b> DEVELOPMENT BUILD</span><span>POWERED BY TORN API & CLOUDFLARE</span></footer>
        </div>
      </main>
    </div>
  )
}
