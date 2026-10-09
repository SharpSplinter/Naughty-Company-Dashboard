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
  const [activeView, setActiveView] = useState<"overview" | "catalog" | "connect">("overview")
  const [search, setSearch] = useState("")
  const [selectedCompany, setSelectedCompany] = useState(companyNames[0] ?? "")
  const [apiKey, setApiKey] = useState("")
  const [result, setResult] = useState<ApiResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [sessionToken, setSessionToken] = useState("")
  const [authChecking, setAuthChecking] = useState(true)
  const [playerName, setPlayerName] = useState("")
  const [keySaved, setKeySaved] = useState(false)
  const [savedCompanies, setSavedCompanies] = useState<SavedCompany[]>([])

  useEffect(() => {
    const token = sessionStorage.getItem("ncd_session") || ""
    if (!token) { setAuthChecking(false); return }
    let cancelled = false
    async function restoreSession() {
      try {
        const response = await fetch(`${API_BASE}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } })
        if (!response.ok) throw new Error("Session expired")
        const session = await response.json() as { player: { id: string; name: string }; key: { saved: boolean } }
        if (cancelled) return
        setSessionToken(token)
        setPlayerName(session.player.name)
        setKeySaved(session.key.saved)
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

  const filteredCompanies = useMemo(
    () => companyNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())),
    [search],
  )
  const positions = catalog.companies[selectedCompany] ?? []
  const model = result?.model

  async function deleteSavedKey() {
    if (!sessionToken || !window.confirm("Permanently delete the saved Torn API key? Your player profile and saved company data will remain.")) return
    setError("")
    try {
      const response = await fetch(`${API_BASE}/api/auth/key`, { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}` } })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not delete the saved key.")
      setKeySaved(false)
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
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      })
      const payload = await response.json() as { error?: string; token?: string; player?: { id: string; name: string }; key?: { saved: boolean } }
      if (!response.ok) throw new Error(payload.error || "Sign-in failed. Check that your Torn key is valid and has limited permissions.")
      if (!payload.token) throw new Error("The sign-in service did not return a session. Please try again.")
      sessionStorage.setItem("ncd_session", payload.token)
      setSessionToken(payload.token)
      setPlayerName(payload.player?.name || "Torn member")
      setKeySaved(payload.key?.saved ?? true)
      setApiKey("")
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
      if (apiKey.trim()) {
        const path = token ? "/api/auth/key" : "/api/auth/sign-in"
        const authResponse = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ apiKey: apiKey.trim() }) })
        const authPayload = await authResponse.json() as { error?: string; token?: string; player?: { id: string; name: string }; key?: { saved: boolean } }
        if (!authResponse.ok) throw new Error(authPayload.error || "Torn-key sign-in failed.")
        if (authPayload.token) {
          token = authPayload.token
          sessionStorage.setItem("ncd_session", token)
          setSessionToken(token)
        }
        if (authPayload.player) setPlayerName(authPayload.player.name)
        setKeySaved(true)
        setApiKey("")
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
          <button className={activeView === "connect" ? "nav-item active" : "nav-item"} onClick={() => setActiveView("connect")}><span>⌁</span> Connect Torn API</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-indicator"><span className={result ? "status-dot live" : "status-dot"} />{keySaved ? `Signed in${playerName ? ` as ${playerName}` : ""}` : "Player signed in · key deleted"}</div><button className="signout-button" onClick={signOut}>Sign out</button>
          <div className="sidebar-foot">EARLY ACCESS <span>•</span> BUILD 0.2</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs">Workspace <span>/</span> <strong>{activeView === "overview" ? "Overview" : activeView === "catalog" ? "Position catalog" : "Connect Torn API"}</strong></div>
          <div className="topbar-right"><span className="environment-pill"><i /> CLOUDFLARE WORKER</span><div className="avatar">NC</div></div>
        </header>

        <div className="page-content">
          <section className="welcome-row">
            <div><div className="eyebrow"><span className="eyebrow-line" /> COMPANY INTELLIGENCE</div><h1>{activeView === "overview" ? "Operations overview" : activeView === "catalog" ? "Position catalog" : "Connect your company"}</h1><p className="subtitle">{activeView === "overview" ? "Your company, your people, one clear picture." : activeView === "catalog" ? "Explore role requirements across the Torn company ecosystem." : "Pull live company data through your secure API connection."}</p></div>
            <button className="primary-button" onClick={() => setActiveView("connect")}><span>＋</span> Connect company</button>
          </section>

          {activeView === "catalog" ? (
            <section className="panel catalog-panel">
              <div className="panel-heading"><div><h2>Company role library</h2><p>{companyNames.length} company types · position requirements reference</p></div><div className="search-wrap"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search company types..." /></div></div>
              <div className="company-grid">{filteredCompanies.map((name) => <button key={name} className={selectedCompany === name ? "company-card selected" : "company-card"} onClick={() => setSelectedCompany(name)}><span className="company-glyph">{name.slice(0, 1)}</span><span className="company-card-copy"><strong>{name}</strong><small>{catalog.companies[name].length} defined roles</small></span><span className="card-arrow">↗</span></button>)}</div>
              {filteredCompanies.length === 0 && <div className="empty-state">No company types match that search.</div>}
              <div className="role-detail"><div className="role-title"><div><span className="eyebrow">SELECTED COMPANY</span><h3>{selectedCompany}</h3></div><span className="count-chip">{positions.length} positions</span></div><div className="table-scroll"><table><thead><tr><th>ROLE</th><th>PRIMARY STAT</th><th>PRIMARY MIN.</th><th>SECONDARY STAT</th><th>SECONDARY MIN.</th><th>SPECIALTY</th></tr></thead><tbody>{positions.map((position, index) => <tr key={position.rank + index}><td><strong>{position.rank}</strong></td><td><span className="stat-chip">{position.primary}</span></td><td>{position.primaryMin.toLocaleString()}</td><td><span className="stat-chip">{position.secondary}</span></td><td>{position.secondaryMin.toLocaleString()}</td><td>{position.special ? <span className="special-chip">{position.special}</span> : <span className="muted">None</span>}</td></tr>)}</tbody></table></div></div>
            </section>
          ) : activeView === "connect" ? (
            <section className="connect-layout">
              <div className="panel connect-panel"><div className="panel-heading"><div><h2>Connect to Torn</h2><p>Fetch profile and employee data for the company linked to your key</p></div><span className="big-icon">⌁</span></div><form onSubmit={connectCompany}><label htmlFor="api-key">Torn API key</label><input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={keySaved ? "Paste a replacement key (optional)" : "Paste your Torn API key to sign in"} /><p className="field-hint"><span>♢</span> Your key is encrypted in the server-side key store. Company records are stored separately.</p>{error && <div className={`error-banner${error.startsWith("ACCESS DENIED:") ? " access-denied-banner" : ""}`} role="alert">{error.startsWith("ACCESS DENIED:") && <strong>ACCESS DENIED · NAUGHTY SOULS MEMBERSHIP REQUIRED</strong>}{error.startsWith("ACCESS DENIED:") && <br />}{error}</div>}<button className="primary-button form-submit" disabled={loading}>{loading ? <><span className="spinner" /> Connecting...</> : <>Fetch company data <span>↗</span></>}</button></form>{sessionToken && <div className="key-store-panel"><div><strong>{keySaved ? "Torn API key saved" : "No Torn API key saved"}</strong><p>{keySaved ? "Encrypted at rest. Only the last four characters are shown by the key store." : "Your saved company records remain available. Add a key again to refresh live data."}</p></div>{keySaved && <button className="text-button danger-text" type="button" onClick={deleteSavedKey}>Permanently delete key</button>}{savedCompanies.length > 0 && <div className="saved-company-list"><strong>Saved company records</strong>{savedCompanies.map((company) => <button key={company.company_id} type="button" className="saved-company-link" onClick={() => void loadSavedCompany(company.company_id)}>{company.company_name || `Company #${company.company_id}`} <span>#{company.company_id}</span></button>)}</div>}</div>}</div>
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
