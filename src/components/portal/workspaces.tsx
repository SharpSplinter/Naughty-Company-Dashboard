import { useEffect, useState } from "react"

type SavedCompanySummary = {
  company_id: string
  company_name: string | null
  company_type: string | null
  key_last_four?: string | null
  key_updated_at?: string | null
}

type HalloweenLiveMember = {
  playerId: string
  playerName: string
  currentTreats: number | null
  totalTreats: number | null
  upgradesUnlocked: number | null
  upgrades: unknown[] | null
  capturedAt: string | null
  coverage: string
}

type HalloweenLivePayload = {
  event: { eventYear: number; startAt: string; endAt: string; liveCollectionEnabled: number }
  leaderboard: HalloweenLiveMember[]
  mySnapshot: HalloweenLiveMember | null
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
  const eventYear = new Date().getUTCFullYear()
  const [tab, setTab] = useState<"live" | "historical">("live")
  const [historicalKey, setHistoricalKey] = useState("")
  const [historicalConsent, setHistoricalConsent] = useState(false)
  const [historicalKeyStatus, setHistoricalKeyStatus] = useState<{ connected: boolean; key: { lastFour: string; accessLevel: string; consentedAt: string; lastValidatedAt: string } | null } | null>(null)
  const [historicalKeyBusy, setHistoricalKeyBusy] = useState(false)
  const [historicalKeyMessage, setHistoricalKeyMessage] = useState("")
  const [historicalKeyError, setHistoricalKeyError] = useState("")
  const [live, setLive] = useState<HalloweenLivePayload | null>(null)
  const [liveBusy, setLiveBusy] = useState(false)
  const [liveCaptureBusy, setLiveCaptureBusy] = useState(false)
  const [liveError, setLiveError] = useState("")
  const [archive, setArchive] = useState<{ event: { eventYear: number; startAt: string; endAt: string }; leaderboard: Array<{ playerId: string; playerName: string; keyConnected: boolean; collectionStatus: string; pagesCollected: number; logsCollected: number; totalHits: number | null; lastCollectedAt: string | null; coverage: string }>; myCollection: { playerId: string; collectionStatus: string; coverage: string; totalHits: number | null } | null } | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState("")
  const [collectBusy, setCollectBusy] = useState(false)
  const [collectMessage, setCollectMessage] = useState("")
  const [selectedMember, setSelectedMember] = useState<{ playerId: string; playerName: string } | null>(null)
  const [memberDetail, setMemberDetail] = useState<{ collection: { status: string; coverage: string; logsCollected?: number }; dailyActivity: Array<{ eventDay: string; totalHits: number; relevantLogs: number }>; logs: Array<{ logId: string; timestamp: number; title: string; category: string; labels: string[]; isHit: boolean; details: Record<string, unknown> | null }> } | null>(null)
  const [memberDetailBusy, setMemberDetailBusy] = useState(false)

  const loadHistoricalKeyStatus = async () => {
    try {
      const response = await fetch(apiBase + "/api/me/halloween/key", { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string; connected?: boolean; key?: { lastFour: string; accessLevel: string; consentedAt: string; lastValidatedAt: string } | null }
      if (!response.ok) throw new Error(payload.error || "Could not load your Halloween key status.")
      setHistoricalKeyStatus({ connected: payload.connected === true, key: payload.key ?? null })
    } catch (caught) { setHistoricalKeyError(caught instanceof Error ? caught.message : "Could not load your Halloween key status.") }
  }

  const loadArchive = async () => {
    setArchiveBusy(true); setArchiveError("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/archive?year=" + eventYear, { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string; event?: { eventYear: number; startAt: string; endAt: string }; leaderboard?: typeof archive extends infer T ? T extends { leaderboard: infer L } ? L : never : never; myCollection?: { playerId: string; collectionStatus: string; coverage: string; totalHits: number | null } | null }
      if (!response.ok) throw new Error(payload.error || "Could not load the faction Halloween archive.")
      if (!payload.event) throw new Error("This Halloween event year is not configured yet.")
      setArchive({ event: payload.event, leaderboard: (payload.leaderboard || []) as NonNullable<typeof archive>["leaderboard"], myCollection: payload.myCollection ?? null })
    } catch (caught) { setArchiveError(caught instanceof Error ? caught.message : "Could not load the faction Halloween archive.") }
    finally { setArchiveBusy(false) }
  }

  const loadLive = async () => {
    setLiveBusy(true); setLiveError("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/live?year=" + eventYear, { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string } & Partial<HalloweenLivePayload>
      if (!response.ok) throw new Error(payload.error || "Could not load the live Halloween leaderboard.")
      if (!payload.event) throw new Error("This Halloween event year is not configured yet.")
      setLive({
        event: payload.event,
        leaderboard: Array.isArray(payload.leaderboard) ? payload.leaderboard : [],
        mySnapshot: payload.mySnapshot ?? null,
      })
    } catch (caught) { setLiveError(caught instanceof Error ? caught.message : "Could not load the live Halloween leaderboard.") }
    finally { setLiveBusy(false) }
  }

  const loadMemberDetail = async (member: { playerId: string; playerName: string }) => {
    setSelectedMember(member); setMemberDetail(null); setMemberDetailBusy(true); setArchiveError("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/members/" + encodeURIComponent(member.playerId) + "?year=" + eventYear, { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string; collection?: { status: string; coverage: string; logsCollected?: number }; dailyActivity?: Array<{ eventDay: string; totalHits: number; relevantLogs: number }>; logs?: Array<{ logId: string; timestamp: number; title: string; category: string; labels: string[]; isHit: boolean; details: Record<string, unknown> | null }> }
      if (!response.ok) throw new Error(payload.error || "Could not load this member's event history.")
      setMemberDetail({ collection: payload.collection || { status: "not_collected", coverage: "not_collected" }, dailyActivity: payload.dailyActivity || [], logs: payload.logs || [] })
    } catch (caught) { setArchiveError(caught instanceof Error ? caught.message : "Could not load this member's event history.") }
    finally { setMemberDetailBusy(false) }
  }

  useEffect(() => { if (tab === "live") void loadLive() }, [tab, eventYear, apiBase, sessionToken])
  useEffect(() => { void loadHistoricalKeyStatus() }, [apiBase, sessionToken])
  useEffect(() => { if (tab === "historical") void loadArchive() }, [tab, eventYear, apiBase, sessionToken])

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
      await Promise.all([loadHistoricalKeyStatus(), loadArchive()])
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
      await Promise.all([loadHistoricalKeyStatus(), loadArchive()])
    } catch (caught) { setHistoricalKeyError(caught instanceof Error ? caught.message : "Could not disconnect your Full Access key.") }
    finally { setHistoricalKeyBusy(false) }
  }

  const startHistoricalCollection = async () => {
    if (collectBusy) return
    setCollectBusy(true); setArchiveError(""); setCollectMessage("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/collect", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ year: eventYear }),
      })
      const payload = await response.json() as { error?: string; queued?: boolean; alreadyComplete?: boolean; status?: string }
      if (!response.ok) throw new Error(payload.error || "Could not start historical collection.")
      setCollectMessage(payload.alreadyComplete ? "Your historical collection is already complete." : "Your historical log collection is queued. It will continue in the background.")
      await loadArchive()
    } catch (caught) { setArchiveError(caught instanceof Error ? caught.message : "Could not start historical collection.") }
    finally { setCollectBusy(false) }
  }

  const captureLiveSnapshot = async () => {
    if (liveCaptureBusy) return
    setLiveCaptureBusy(true); setLiveError("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/live-snapshot", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ year: eventYear }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not capture your live Halloween summary.")
      await loadLive()
    } catch (caught) { setLiveError(caught instanceof Error ? caught.message : "Could not capture your live Halloween summary.") }
    finally { setLiveCaptureBusy(false) }
  }

  const coverageLabel = (coverage: string) => coverage === "complete" ? "Complete" : coverage === "collecting" ? "Collecting" : coverage === "partial" ? "Partial" : "Not collected"
  const maxDailyHits = Math.max(1, ...(memberDetail?.dailyActivity || []).map(day => Number(day.totalHits || 0)))
  const formatWhen = (timestamp: number) => new Date(timestamp * 1000).toLocaleString()

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
          <div className="halloween-status"><i /> CURRENT YEAR · {eventYear}</div>
          <h2>Live event intelligence</h2>
          <p>The current-year leaderboard uses each member's own saved limited-access login key. Detailed logs and hit history are collected separately through each member's Full Access historical key.</p>
          <div className="historical-collection-toolbar">
            <div><small>FACTION LIVE LEADERBOARD</small><strong>{live?.leaderboard.length ?? 0} member accounts</strong></div>
            <div className="live-toolbar-actions">
              {live && Date.now() >= Date.parse(live.event.startAt) && Date.now() <= Date.parse(live.event.endAt) && <button type="button" onClick={() => void captureLiveSnapshot()} disabled={liveCaptureBusy}>{liveCaptureBusy ? "Capturing…" : "Capture my snapshot"}</button>}
              <button type="button" onClick={() => void loadLive()} disabled={liveBusy}>{liveBusy ? "Refreshing…" : "Refresh live board ↻"}</button>
            </div>
          </div>
          {liveError && <p className="historical-key-error" role="alert">{liveError}</p>}
          {liveBusy && !live ? <p className="historical-key-muted">Loading live faction snapshots…</p> : live ? <>
            {live.mySnapshot ? <div className="coverage-grid">
              <div><small>MY CURRENT TREATS</small><strong>{live.mySnapshot.currentTreats?.toLocaleString() ?? "—"}</strong><span>Latest saved current count</span></div>
              <div><small>MY TOTAL TREATS</small><strong>{live.mySnapshot.totalTreats?.toLocaleString() ?? "—"}</strong><span>Latest saved event total</span></div>
              <div><small>UPGRADES UNLOCKED</small><strong>{live.mySnapshot.upgradesUnlocked ?? "—"}</strong><span>{live.mySnapshot.capturedAt ? "Captured " + new Date(live.mySnapshot.capturedAt).toLocaleString() : "No snapshot timestamp"}</span></div>
            </div> : <div className="historical-empty"><strong>Your live snapshot has not been collected.</strong><span>Live snapshots use your own saved faction login key. Missing data remains unavailable, not zero.</span></div>}
            <div className="historical-leaderboard">
              {live.leaderboard.length ? <table><thead><tr><th>RANK</th><th>MEMBER</th><th>CURRENT TREATS</th><th>TOTAL TREATS</th><th>UPGRADES</th><th>COVERAGE</th></tr></thead><tbody>
                {live.leaderboard.map((member, index) => <tr key={member.playerId}>
                  <td>{member.totalTreats === null ? "—" : index + 1}</td>
                  <td>{member.playerName}<small>#{member.playerId}</small></td>
                  <td>{member.currentTreats === null ? "—" : member.currentTreats.toLocaleString()}</td>
                  <td>{member.totalTreats === null ? "—" : member.totalTreats.toLocaleString()}</td>
                  <td>{member.upgradesUnlocked === null ? "—" : member.upgradesUnlocked}</td>
                  <td><span className={"coverage-pill " + (member.coverage === "captured" ? "complete" : "not_collected")}>{member.coverage === "captured" ? "Captured" : "Not collected"}</span></td>
                </tr>)}
              </tbody></table> : <div className="historical-empty"><strong>No live snapshots have been collected yet.</strong><span>Opening, periodic and closing collection is controlled by the event's live-collection setting.</span></div>}
            </div>
            <p className="historical-key-muted">{live.event.liveCollectionEnabled ? "Scheduled live collection is enabled for this event." : "Scheduled live collection is currently disabled for this event."} Event window: {new Date(live.event.startAt).toLocaleString()} to {new Date(live.event.endAt).toLocaleString()}.</p>
          </> : !liveBusy ? <div className="historical-empty"><strong>Live snapshots are unavailable.</strong><span>Refresh to check the current faction leaderboard.</span></div> : null}
        </section>
      ) : (
        <section className="halloween-panel">
          <div className="halloween-status historical"><i /> FACTION ARCHIVE · {eventYear}</div>
          <h2>Historical event records</h2>
          <p>Historical log collection uses each member's own Full Access API key. Custom Access keys are not supported for this collector. Collected event history is shared with all authenticated Naughty Souls members.</p>
          <div className="historical-key-notice"><strong>Your own key. Your own records. Shared faction history.</strong><span>Connect your own Full Access key once. It is encrypted at rest, associated with your Torn player ID, and used only for your historical event-log collection. Members can browse the shared faction archive without connecting a key. If you leave Naughty Souls, your saved historical key and contributed Halloween records are purged.</span></div>
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
          <div className="historical-collection-toolbar"><div><small>FACTION HISTORICAL LEADERBOARD</small><strong>{archive?.leaderboard.length ?? 0} member accounts in the archive</strong></div><button type="button" onClick={() => { void loadArchive(); void loadHistoricalKeyStatus() }} disabled={archiveBusy}>{archiveBusy ? "Refreshing…" : "Refresh archive ↻"}</button></div>
          {archiveError && <p className="historical-key-error" role="alert">{archiveError}</p>}
          {collectMessage && <p className="historical-key-message" role="status">{collectMessage}</p>}
          {archive?.myCollection?.coverage !== "complete" && historicalKeyStatus?.connected && <div className="historical-collect-banner"><div><strong>Contribute your historical event logs</strong><span>Collection runs in the background, one date/page at a time, and can be resumed without re-entering your key.</span></div><button type="button" onClick={startHistoricalCollection} disabled={collectBusy || archive?.myCollection?.coverage === "collecting"}>{collectBusy ? "Queueing…" : archive?.myCollection?.coverage === "collecting" ? "Collection running…" : "Collect my history"}</button></div>}
          <div className="historical-leaderboard">
            {!archive && archiveBusy ? <p className="historical-key-muted">Loading faction archive…</p> : archive?.leaderboard.length ? <table><thead><tr><th>RANK</th><th>MEMBER</th><th>TOTAL HITS</th><th>LOGS</th><th>COVERAGE</th></tr></thead><tbody>
              {archive.leaderboard.map((member, index) => <tr key={member.playerId} className={selectedMember?.playerId === member.playerId ? "selected" : ""}>
                <td>{member.totalHits === null ? "—" : index + 1}</td>
                <td><button type="button" className="historical-member-link" onClick={() => void loadMemberDetail({ playerId: member.playerId, playerName: member.playerName })}>{member.playerName}<small>#{member.playerId}</small></button></td>
                <td>{member.totalHits === null ? "—" : member.totalHits.toLocaleString()}</td>
                <td>{member.coverage === "complete" || member.coverage === "collecting" || member.coverage === "partial" ? member.logsCollected.toLocaleString() : "—"}</td>
                <td><span className={"coverage-pill " + member.coverage}>{coverageLabel(member.coverage)}</span></td>
              </tr>)}
            </tbody></table> : <div className="historical-empty"><strong>No member event logs have been contributed yet.</strong><span>Members can connect their own Full Access key and start collecting. Until then, the leaderboard reports coverage as unavailable rather than assigning zero hits.</span></div>}
          </div>
          {selectedMember && <section className="historical-member-detail">
            <div className="historical-detail-heading"><div><small>MEMBER EVENT PROFILE</small><strong>{selectedMember.playerName} <span>#{selectedMember.playerId}</span></strong></div><button type="button" onClick={() => { setSelectedMember(null); setMemberDetail(null) }}>Close</button></div>
            {memberDetailBusy ? <p className="historical-key-muted">Loading member history…</p> : memberDetail ? <>
              <div className="historical-detail-metrics"><div><small>COLLECTION STATUS</small><strong>{coverageLabel(memberDetail.collection.coverage)}</strong></div><div><small>DAILY HIT DAYS</small><strong>{memberDetail.dailyActivity.filter(day => Number(day.totalHits) > 0).length}</strong></div><div><small>EVENT LOGS</small><strong>{memberDetail.logs.length.toLocaleString()}</strong></div></div>
              <div className="historical-daily-activity"><h3>Daily hit history</h3>{memberDetail.dailyActivity.length ? memberDetail.dailyActivity.map(day => <div className="historical-day-row" key={day.eventDay}><span>{day.eventDay}</span><div><i style={{ width: ((Number(day.totalHits || 0) / maxDailyHits) * 100) + "%" }} /></div><strong>{Number(day.totalHits || 0).toLocaleString()}</strong></div>) : <p className="historical-key-muted">Daily activity is not available for this member yet.</p>}</div>
              <div className="historical-event-feed"><h3>Event log feed</h3>{memberDetail.logs.length ? memberDetail.logs.slice(0, 80).map(log => <article key={log.logId}><div><strong>{log.title || "Halloween-related activity"}</strong><small>{formatWhen(log.timestamp)} · Log #{log.logId}</small></div><div>{log.isHit && <span className="event-hit-pill">HIT</span>}{(log.labels || []).map(label => <span className="event-label-pill" key={label}>{label.replaceAll("_", " ")}</span>)}</div></article>) : <p className="historical-key-muted">No event logs are available for this member yet.</p>}</div>
            </> : <p className="historical-key-muted">No member details loaded.</p>}
          </section>}
          <div className="coverage-grid"><div><small>LEADERBOARD</small><strong>Faction-wide</strong><span>Shared historical totals and member profiles</span></div><div><small>LOG DETAIL</small><strong>By coverage</strong><span>Player, year, source, and collection timestamp retained</span></div><div><small>KEY REQUIREMENT</small><strong>Full Access only</strong><span>Each member controls their own collection key</span></div></div>
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
