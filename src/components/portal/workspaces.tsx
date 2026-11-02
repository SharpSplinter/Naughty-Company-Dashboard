import { useEffect, useState } from "react"

type SavedCompanySummary = {
  company_id: string
  company_name: string | null
  company_type: string | null
  key_last_four?: string | null
  key_updated_at?: string | null
}

type WorkspaceProps = {
  playerName: string
  playerId: string
  isAdmin: boolean
  loginKeySaved: boolean
  companyKeySaved: boolean
  companies: SavedCompanySummary[]
  onNavigate: (path: string) => void
  onSignOut: () => void
}

const workspaces = [
  {
    path: "/company",
    icon: "▦",
    title: "Company Dashboard",
    description: "Company performance, employees, income, rankings, and operational intelligence.",
    label: "COMPANY OPERATIONS",
  },
  {
    path: "/halloween",
    icon: "♧",
    title: "Halloween Dashboard",
    description: "Current event standings alongside the faction's growing historical event archive.",
    label: "EVENT INTELLIGENCE",
  },
  {
    path: "/faction",
    icon: "♜",
    title: "Faction Dashboard",
    description: "A shared view of faction activity and member intelligence.",
    label: "FACTION WORKSPACE",
  },
  {
    path: "/settings",
    icon: "⚙",
    title: "Account Settings",
    description: "Your API connections, permissions, account security, and preferences.",
    label: "YOUR ACCOUNT",
  },
]

export function PortalHome(props: WorkspaceProps) {
  return (
    <main className="portal-page">
      <header className="portal-topbar">
        <a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); props.onNavigate("/") }}>
          <span className="portal-brand-mark">NF</span>
          <span><strong>NAUGHTY FAMILY</strong><small>FACTION PORTAL</small></span>
        </a>
        <div className="portal-user">
          <span className="portal-user-avatar">{props.playerName.slice(0, 2).toUpperCase() || "NS"}</span>
          <span><strong>{props.playerName || "Faction member"}</strong><small>TORN ID {props.playerId || "—"}</small></span>
          <button type="button" onClick={props.onSignOut}>Sign out</button>
        </div>
      </header>

      <section className="portal-hero">
        <div className="portal-eyebrow"><span /> NAUGHTY SOULS · MEMBER PORTAL</div>
        <h1>One faction.<br /><em>Every workspace.</em></h1>
        <p>Your shared home for company operations, Halloween intelligence, and the tools that keep Naughty Souls connected.</p>
        <div className="portal-session"><i /> Authenticated faction member <span>·</span> Your session is shared across workspaces</div>
      </section>

      <section className="portal-workspaces" aria-label="Available workspaces">
        <div className="portal-section-heading"><div><span>YOUR WORKSPACES</span><h2>Choose where to go</h2></div><small>04 MODULES</small></div>
        <div className="portal-card-grid">
          {workspaces.map((workspace, index) => (
            <button type="button" key={workspace.path} className={`portal-card portal-card-${index + 1}`} onClick={() => props.onNavigate(workspace.path)}>
              <div className="portal-card-top"><span className="portal-card-icon">{workspace.icon}</span><span className="portal-card-arrow">↗</span></div>
              <span className="portal-card-label">{workspace.label}</span>
              <strong>{workspace.title}</strong>
              <p>{workspace.description}</p>
              <span className="portal-card-open">Open workspace <b>→</b></span>
            </button>
          ))}
          {props.isAdmin && (
            <button type="button" className="portal-card portal-card-admin" onClick={() => props.onNavigate("/admin")}>
              <div className="portal-card-top"><span className="portal-card-icon">♛</span><span className="portal-card-arrow">↗</span></div>
              <span className="portal-card-label">RESTRICTED ACCESS</span>
              <strong>Admin Panel</strong>
              <p>Member access, administrator roles, system health, and platform controls.</p>
              <span className="portal-card-open">Open administration <b>→</b></span>
            </button>
          )}
        </div>
      </section>

      <section className="portal-account-strip">
        <div><span className="portal-account-icon">◉</span><span><strong>Connected member account</strong><small>Your personal Torn credentials stay attached to your own account.</small></span></div>
        <div className="portal-connection-status"><i className={props.loginKeySaved ? "is-connected" : ""} /> Login key {props.loginKeySaved ? "connected" : "not saved"} <span>·</span> Company keys {props.companies.length || (props.companyKeySaved ? 1 : 0)}</div>
        <button type="button" onClick={() => props.onNavigate("/settings")}>Manage account <b>→</b></button>
      </section>

      <footer className="portal-footer"><span>NAUGHTY FAMILY PORTAL</span><span>NAUGHTY SOULS · PRIVATE MEMBER ACCESS</span></footer>
    </main>
  )
}

export function FactionWorkspacePlaceholder({ playerName, onNavigate }: Pick<WorkspaceProps, "playerName" | "onNavigate">) {
  return (
    <main className="module-page">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>FACTION PORTAL</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-placeholder"><span className="module-placeholder-icon">♜</span><div className="portal-eyebrow"><span /> FACTION WORKSPACE</div><h1>Under construction</h1><p>The Faction Dashboard is reserved for the next stage of the portal. Your member session is active, and the other workspaces remain available.</p><button type="button" className="portal-primary-button" onClick={() => onNavigate("/")}>Back to portal <b>→</b></button><small>Signed in as {playerName}</small></section>
    </main>
  )
}

export function HalloweenWorkspace({ playerName, onNavigate, apiBase, sessionToken }: Pick<WorkspaceProps, "playerName" | "onNavigate"> & { apiBase: string; sessionToken: string }) {
  const [tab, setTab] = useState<"live" | "historical">("live")
  const [historicalKey, setHistoricalKey] = useState("")
  const [historicalConsent, setHistoricalConsent] = useState(false)
  const [historicalKeyStatus, setHistoricalKeyStatus] = useState<{ connected: boolean; key: { lastFour: string; accessLevel: string; consentedAt: string; lastValidatedAt: string } | null } | null>(null)
  const [historicalKeyBusy, setHistoricalKeyBusy] = useState(false)
  const [historicalKeyMessage, setHistoricalKeyMessage] = useState("")
  const [historicalKeyError, setHistoricalKeyError] = useState("")

  const loadHistoricalKeyStatus = async () => {
    try {
      const response = await fetch(apiBase + "/api/me/halloween/key", { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string; connected?: boolean; key?: { lastFour: string; accessLevel: string; consentedAt: string; lastValidatedAt: string } | null }
      if (!response.ok) throw new Error(payload.error || "Could not load your Halloween key status.")
      setHistoricalKeyStatus({ connected: payload.connected === true, key: payload.key ?? null })
    } catch (caught) { setHistoricalKeyError(caught instanceof Error ? caught.message : "Could not load your Halloween key status.") }
  }

  useEffect(() => { void loadHistoricalKeyStatus() }, [apiBase, sessionToken])

  const saveHistoricalKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!historicalConsent || !historicalKey.trim() || historicalKeyBusy) return
    setHistoricalKeyBusy(true); setHistoricalKeyError(""); setHistoricalKeyMessage("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/key", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: historicalKey.trim(), consent: true, consentVersion: "halloween-history-v1" }),
      })
      const payload = await response.json() as { error?: string; saved?: boolean }
      if (!response.ok) throw new Error(payload.error || "Could not save your Full Access key.")
      setHistoricalKey(""); setHistoricalConsent(false)
      setHistoricalKeyMessage("Your Full Access key is validated and stored encrypted on your account.")
      await loadHistoricalKeyStatus()
    } catch (caught) { setHistoricalKeyError(caught instanceof Error ? caught.message : "Could not save your Full Access key.") }
    finally { setHistoricalKeyBusy(false) }
  }

  const removeHistoricalKey = async () => {
    if (historicalKeyBusy || !window.confirm("Disconnect your Full Access key? Previously collected Halloween records remain in the shared faction archive.")) return
    setHistoricalKeyBusy(true); setHistoricalKeyError(""); setHistoricalKeyMessage("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/key", { method: "DELETE", headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not disconnect your Full Access key.")
      setHistoricalKeyMessage("Your key has been disconnected. Previously collected faction records were retained.")
      await loadHistoricalKeyStatus()
    } catch (caught) { setHistoricalKeyError(caught instanceof Error ? caught.message : "Could not disconnect your Full Access key.") }
    finally { setHistoricalKeyBusy(false) }
  }
  return (
    <main className="module-page halloween-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>HALLOWEEN INTELLIGENCE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> SHARED FACTION EVENT DATA</div><h1>Halloween <em>Dashboard</em></h1><p>One faction leaderboard and event archive, built from members' own authorized Torn data.</p></section>
      <nav className="halloween-tabs" aria-label="Halloween dashboard sections">
        <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}><span>◉</span> Live / Current Year</button>
        <button type="button" className={tab === "historical" ? "active" : ""} onClick={() => setTab("historical")}><span>◷</span> Historical</button>
      </nav>
      {tab === "live" ? (
        <section className="halloween-panel">
          <div className="halloween-status"><i /> CURRENT YEAR</div>
          <h2>Live event intelligence</h2>
          <p>The current-year view will use each member's saved limited-access login credential for the Torn Halloween summary. Detailed log coverage will be shown separately where the endpoint requires Full Access.</p>
          <div className="coverage-grid"><div><small>FACTION LEADERBOARD</small><strong>Shared view</strong><span>Same rankings for every authenticated Naughty Souls member</span></div><div><small>DATA COLLECTION</small><strong>Scheduled & cached</strong><span>Opening, periodic, and closing event snapshots</span></div><div><small>DATA COVERAGE</small><strong>Being connected</strong><span>Uncollected details will not be treated as zero</span></div></div>
        </section>
      ) : (
        <section className="halloween-panel">
          <div className="halloween-status historical"><i /> FACTION ARCHIVE</div>
          <h2>Historical event records</h2>
          <p>Historical log collection uses each member's own Full Access API key. Custom Access keys are not supported for this log collector.</p>
          <div className="historical-key-notice"><strong>Your own key. Your own records. Shared faction history.</strong><span>Connect your own Full Access key once. It is encrypted at rest, associated with your Torn player ID, and used only for your historical event-log collection. Members can browse the shared faction archive without connecting a key.</span></div>
          <section className="historical-key-card">
            <div className="historical-key-heading"><div><small>YOUR HISTORICAL COLLECTION KEY</small><strong>{historicalKeyStatus?.connected ? "Connected · •••• " + (historicalKeyStatus.key?.lastFour || "••••") : "Not connected"}</strong></div><span className={historicalKeyStatus?.connected ? "key-status connected" : "key-status"}><i /> {historicalKeyStatus?.connected ? "FULL ACCESS VERIFIED" : "KEY REQUIRED TO CONTRIBUTE"}</span></div>
            {historicalKeyStatus?.connected ? <div className="historical-key-connected"><p>Your Full Access key is saved securely and will be reused for your collection. Last validation: {historicalKeyStatus.key?.lastValidatedAt ? new Date(historicalKeyStatus.key.lastValidatedAt).toLocaleString() : "Not available"}.</p><button type="button" disabled={historicalKeyBusy} onClick={removeHistoricalKey}>Disconnect key</button></div> : <form className="historical-key-form" onSubmit={saveHistoricalKey}>
              <label htmlFor="halloween-full-access-key">Your Full Access API key</label>
              <input id="halloween-full-access-key" type="password" autoComplete="off" value={historicalKey} onChange={event => setHistoricalKey(event.target.value)} placeholder="Paste your own Full Access Torn API key" disabled={historicalKeyBusy} />
              <div className="historical-tos"><strong>Historical Halloween data use</strong><table><tbody>
                <tr><th>Data Storage</th><td>Persistent, until account deletion or faction change. Disconnecting the key does not erase records already contributed.</td></tr>
                <tr><th>Data Sharing</th><td>All authenticated Naughty Souls faction members.</td></tr>
                <tr><th>Purpose of Use</th><td>Halloween event analytics, personal event history, and faction-wide leaderboard/archive.</td></tr>
                <tr><th>Key Storage & Sharing</th><td>Stored remotely encrypted; used only by this service's historical collection workflows. The raw key is not shared with faction members.</td></tr>
                <tr><th>Key Access Level</th><td>Full Access only, with user log access. Custom Access keys are not accepted.</td></tr>
              </tbody></table></div>
              <label className="historical-consent"><input type="checkbox" checked={historicalConsent} onChange={event => setHistoricalConsent(event.target.checked)} disabled={historicalKeyBusy} /><span>I have reviewed the data-use terms and agree to encrypted storage of my Full Access key and sharing my collected Halloween event records with authenticated Naughty Souls faction members.</span></label>
              <button className="historical-connect-button" type="submit" disabled={historicalKeyBusy || !historicalConsent || !historicalKey.trim()}>{historicalKeyBusy ? "Validating key…" : "Validate & save Full Access key"}</button>
            </form>}
            {historicalKeyError && <p className="historical-key-error" role="alert">{historicalKeyError}</p>}
            {historicalKeyMessage && <p className="historical-key-message" role="status">{historicalKeyMessage}</p>}
            {!historicalKeyStatus && <p className="historical-key-muted">Checking your saved key status…</p>}
          </section>
          <div className="coverage-grid"><div><small>LEADERBOARD</small><strong>Faction-wide</strong><span>Shared historical totals and member profiles</span></div><div><small>LOG DETAIL</small><strong>By coverage</strong><span>Player, year, source, and collection timestamp retained</span></div><div><small>KEY REQUIREMENT</small><strong>Full Access only</strong><span>Personal key supplied and controlled by each member</span></div></div>
        </section>
      )}
      <footer className="module-footer"><span>HALLOWEEN EVENT ARCHIVE</span><span>Signed in as {playerName}</span></footer>
    </main>
  )
}

export function AccountSettingsWorkspace(props: WorkspaceProps) {
  return (
    <main className="module-page">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); props.onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>ACCOUNT SETTINGS</small></span></a><button type="button" onClick={() => props.onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> PERSONAL ACCOUNT</div><h1>Account <em>Settings</em></h1><p>Manage the connections and security settings attached to your own Torn account.</p></section>
      <section className="settings-member-card"><span className="portal-user-avatar">{props.playerName.slice(0, 2).toUpperCase() || "NS"}</span><div><strong>{props.playerName}</strong><small>Torn ID {props.playerId} · Naughty Souls member</small></div><span className="settings-badge">AUTHENTICATED</span></section>
      <section className="settings-grid">
        <article className="settings-card"><div className="settings-card-icon">⌘</div><small>IDENTITY & MEMBERSHIP</small><h2>Faction login key</h2><p>Your own limited-access key verifies your Torn identity and Naughty Souls membership.</p><span className={props.loginKeySaved ? "settings-connection good" : "settings-connection"}><i /> {props.loginKeySaved ? "Saved securely" : "Not saved"}</span></article>
        <article className="settings-card"><div className="settings-card-icon">▦</div><small>COMPANY WORKSPACE</small><h2>Company API connections</h2><p>Director and secondary company keys belong to you and are never collected or managed by administrators.</p><span className={props.companies.length || props.companyKeySaved ? "settings-connection good" : "settings-connection"}><i /> {props.companies.length || (props.companyKeySaved ? 1 : 0)} saved company connection(s)</span><button type="button" onClick={() => props.onNavigate("/company")}>Manage company keys →</button></article>
        <article className="settings-card"><div className="settings-card-icon">♧</div><small>HALLOWEEN ARCHIVE</small><h2>Historical collection key</h2><p>Historical log collection requires your own Full Access key. It is separate from your faction login key unless one key satisfies both needs.</p><span className="settings-connection"><i /> Not connected in this setup phase</span><button type="button" onClick={() => props.onNavigate("/halloween")}>Open Halloween settings →</button></article>
        <article className="settings-card"><div className="settings-card-icon">◈</div><small>ACCOUNT SECURITY</small><h2>Sessions & access</h2><p>Credentials are associated with your verified Torn player ID. Disconnecting a key does not erase already-collected faction history.</p><span className="settings-connection good"><i /> Member session active</span></article>
      </section>
      <footer className="module-footer"><span>ACCOUNT SETTINGS</span><button type="button" onClick={props.onSignOut}>Sign out</button></footer>
    </main>
  )
}
