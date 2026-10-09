import { useMemo, useState } from "react"
import positionsData from "../../lib/company/positions.json"
import { runEngine } from "../../lib/company/engine"
import type { CompanyDashboardModel, CompanyPositionCatalog } from "../../lib/company/types"

const catalog = positionsData as CompanyPositionCatalog
const companyNames = Object.keys(catalog.companies).sort()
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "")
  || "https://naughty-company-api.kboone801.workers.dev"

type ApiResult = { model: CompanyDashboardModel; profile: unknown; employees: unknown }

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
  const [companyId, setCompanyId] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [result, setResult] = useState<ApiResult | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const filteredCompanies = useMemo(
    () => companyNames.filter((name) => name.toLowerCase().includes(search.toLowerCase())),
    [search],
  )
  const positions = catalog.companies[selectedCompany] ?? []
  const model = result?.model

  async function connectCompany(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setResult(null)
    const id = Number(companyId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError("Enter a valid positive Torn company ID.")
      return
    }
    if (!apiKey.trim()) {
      setError("Enter your Torn API key. It stays in this page's memory and is not saved.")
      return
    }

    setLoading(true)
    try {
      const headers = { Authorization: `ApiKey ${apiKey.trim()}`, Accept: "application/json" }
      const [profileResponse, employeesResponse] = await Promise.all([
        fetch(`${API_BASE}/api/company/${id}/profile`, { headers }),
        fetch(`${API_BASE}/api/company/${id}/employees`, { headers }),
      ])
      const [profile, employees] = await Promise.all([
        profileResponse.json() as Promise<unknown>,
        employeesResponse.json() as Promise<unknown>,
      ])
      if (!profileResponse.ok || !employeesResponse.ok) {
        const payload = getObject(!profileResponse.ok ? profile : employees)
        throw new Error(typeof payload?.error === "string" ? payload.error : "The API request failed. Check the key, company ID, and access permissions.")
      }
      const normalized = runEngine(profile, employees, catalog)
      if (!normalized) throw new Error("Torn returned an unexpected company profile. No data was saved.")
      setResult({ profile, employees, model: normalized })
      setApiKey("")
      setActiveView("overview")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not connect to the Torn API.")
    } finally {
      setLoading(false)
    }
  }

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
          <div className="connection-indicator"><span className={result ? "status-dot live" : "status-dot"} />{result ? "Torn API connected" : "Waiting for connection"}</div>
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
              <div className="panel connect-panel"><div className="panel-heading"><div><h2>Connect to Torn</h2><p>Fetch live profile and employee data</p></div><span className="big-icon">⌁</span></div><form onSubmit={connectCompany}><label htmlFor="company-id">Company ID</label><input id="company-id" inputMode="numeric" value={companyId} onChange={(event) => setCompanyId(event.target.value)} placeholder="e.g. 12345" /><label htmlFor="api-key">Torn API key</label><input id="api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste your API key" /><p className="field-hint"><span>♢</span> Your key is kept in page memory only, never saved to local storage.</p>{error && <div className="error-banner" role="alert">{error}</div>}<button className="primary-button form-submit" disabled={loading}>{loading ? <><span className="spinner" /> Connecting...</> : <>Fetch company data <span>↗</span></>}</button></form></div>
              <div className="panel guide-panel"><span className="guide-icon">✳</span><h2>Before you connect</h2><ul><li>Use a Torn API key with the access needed for your company.</li><li>Private employee stats may only be available to authorized company directors.</li><li>Requests pass through the Cloudflare Worker to Torn's API.</li></ul><div className="guide-note"><strong>Privacy by design</strong><p>Database storage and user accounts are not enabled yet. Avoid using a shared device with your API key.</p></div></div>
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
