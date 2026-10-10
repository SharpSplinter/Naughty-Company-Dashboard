import { useCallback, useEffect, useMemo, useState } from "react"

type AdminTab = "overview" | "members" | "operations" | "history" | "settings" | "audit"
type AdminSettings = { maintenanceMode: boolean; manualRefreshEnabled: boolean; historyImportEnabled: boolean }
type AdminMember = { playerId: string; playerName: string; createdAt?: string | null; updatedAt?: string | null; companyId: string | null; companyName: string | null; companyType: string | null; companyTypeId?: number | string | null; disabled: boolean; disabledAt?: string | null; disableReason?: string | null; loginKeySaved: boolean; companyKeyCount: number; snapshotCount: number }
type AdminJob = { jobId: string; jobType: string; targetPlayerId?: string | null; targetCompanyId?: string | null; status: string; createdAt: string; startedAt?: string | null; finishedAt?: string | null; errorMessage?: string | null; result?: unknown }
type AutomationRun = { runId: string; triggerName: string; status: string; startedAt: string; finishedAt?: string | null; companiesChecked: number; companiesFailed: number; alertsCreated: number; errorSummary?: string | null }
type AutomationRange = "7" | "30" | "90" | "365" | "all"
type AutomationStatusFilter = "all" | "succeeded" | "partial" | "failed" | "running"
type AutomationInsights = { totalRuns: number; succeededRuns: number; failedRuns: number; partialRuns: number; runningRuns: number; completedRuns: number; successRate: number | null; avgDurationSeconds: number | null; companiesFailed: number; alertsCreated: number; latestRunAt?: string | null; recurringFailures: Array<{ errorSummary: string; occurrences: number }> }
type AuditEvent = { id: number; actorPlayerId: string; actorPlayerName: string; action: string; targetType?: string | null; targetId?: string | null; outcome: string; summary: string; createdAt: string; details?: unknown }
type MemberDetail = { member: AdminMember & { disabledAt?: string | null }; connections: { companies: Array<{ companyId: string; companyName?: string | null; companyType?: string | null; lastFour?: string; keyUpdatedAt?: string; fetchedAt?: string | null }>; loginKeySaved: boolean; legacyCompanyKeySaved: boolean }; history: { companySnapshots: number; directorSnapshots: number; pageRecords: number; financialRecords: number } }

type Props = { apiBase: string; sessionToken: string; playerId: string; playerName: string }

async function adminFetch<T>(apiBase: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>
  if (!response.ok) throw new Error(payload.error || `Administration request failed (${response.status}).`)
  return payload as T
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function prettyDate(value?: string | null) {
  if (!value) return "Never"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}

function prettyStatus(value: string) { return value.replaceAll("-", " ").replaceAll(".", " · ") }

function formatDuration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—"
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function runDuration(run: AutomationRun) {
  if (!run.finishedAt) return run.status === "running" ? "In progress" : "—"
  const started = Date.parse(run.startedAt)
  const finished = Date.parse(run.finishedAt)
  return Number.isFinite(started) && Number.isFinite(finished) ? formatDuration(Math.max(0, (finished - started) / 1000)) : "—"
}

export function AdminPanel({ apiBase, sessionToken, playerId, playerName }: Props) {
  const [tab, setTab] = useState<AdminTab>("overview")
  const [actionsArmed, setActionsArmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null)
  const [members, setMembers] = useState<AdminMember[]>([])
  const [memberTotal, setMemberTotal] = useState(0)
  const [memberQuery, setMemberQuery] = useState("")
  const [memberSearch, setMemberSearch] = useState("")
  const [selectedMemberId, setSelectedMemberId] = useState("")
  const [memberDetail, setMemberDetail] = useState<MemberDetail | null>(null)
  const [jobs, setJobs] = useState<AdminJob[]>([])
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([])
  const [automationInsights, setAutomationInsights] = useState<AutomationInsights | null>(null)
  const [automationRange, setAutomationRange] = useState<AutomationRange>("30")
  const [automationStatusFilter, setAutomationStatusFilter] = useState<AutomationStatusFilter>("all")
  const [settings, setSettings] = useState<AdminSettings>({ maintenanceMode: false, manualRefreshEnabled: true, historyImportEnabled: true })
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [historySummary, setHistorySummary] = useState<Record<string, unknown> | null>(null)
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [historyTarget, setHistoryTarget] = useState("")
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const [restorePreview, setRestorePreview] = useState<{ counts?: Record<string, number>; warnings?: string[]; exportedAt?: string; targetPlayerId?: string } | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)

  const selectedMember = useMemo(() => members.find((m) => m.playerId === selectedMemberId) ?? null, [members, selectedMemberId])
  const refreshAll = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const [o, m, j, s, h, a] = await Promise.all([
        adminFetch<{ metrics: Record<string, unknown>; recentActivity?: AuditEvent[] }>(apiBase, sessionToken, "/api/admin/overview"),
        adminFetch<{ members: AdminMember[]; total: number }>(apiBase, sessionToken, "/api/admin/members?limit=50"),
        adminFetch<{ jobs: AdminJob[] }>(apiBase, sessionToken, "/api/admin/jobs?limit=30"),
        adminFetch<{ settings: AdminSettings }>(apiBase, sessionToken, "/api/admin/settings"),
        adminFetch<{ stats: Record<string, unknown>; latestCompanySnapshot?: string | null }>(apiBase, sessionToken, "/api/admin/history/summary"),
        adminFetch<{ events: AuditEvent[] }>(apiBase, sessionToken, "/api/admin/audit?limit=50"),
      ])
      setOverview(o)
      setMembers(m.members || [])
      setMemberTotal(m.total || 0)
      setJobs(j.jobs || [])
      setSettings(s.settings || { maintenanceMode: false, manualRefreshEnabled: true, historyImportEnabled: true })
      setSettingsDirty(false)
      setHistorySummary(h)
      setAudit(a.events || [])
      setSelectedMemberId((current) => current || m.members?.[0]?.playerId || "")
      setHistoryTarget((current) => current || m.members?.[0]?.playerId || "")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load administration data.")
    } finally { setLoading(false) }
  }, [apiBase, sessionToken])

  const loadMemberDetail = useCallback(async (id: string) => {
    setSelectedMemberId(id)
    setError("")
    try { setMemberDetail(await adminFetch<MemberDetail>(apiBase, sessionToken, `/api/admin/members/${encodeURIComponent(id)}`)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load member details."); setMemberDetail(null) }
  }, [apiBase, sessionToken])

  const loadJobs = useCallback(async () => {
    try {
      const payload = await adminFetch<{ jobs: AdminJob[] }>(apiBase, sessionToken, "/api/admin/jobs?limit=30")
      setJobs(payload.jobs || [])
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load job status.") }
  }, [apiBase, sessionToken])

  const loadAutomationRuns = useCallback(async () => {
    try {
      const payload = await adminFetch<{ runs: AutomationRun[]; insights: AutomationInsights }>(apiBase, sessionToken, `/api/admin/automation/runs?limit=100&days=${automationRange}`)
      setAutomationRuns(payload.runs || [])
      setAutomationInsights(payload.insights || null)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load automation insights.") }
  }, [apiBase, sessionToken, automationRange])

  const loadMembers = useCallback(async (query: string) => {
    setError("")
    try {
      const payload = await adminFetch<{ members: AdminMember[]; total: number }>(apiBase, sessionToken, `/api/admin/members?limit=50&q=${encodeURIComponent(query)}`)
      setMembers(payload.members || [])
      setMemberTotal(payload.total || 0)
      if (!payload.members?.some((member) => member.playerId === selectedMemberId)) {
        setSelectedMemberId(payload.members?.[0]?.playerId || "")
        setMemberDetail(null)
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not search members.") }
  }, [apiBase, sessionToken, selectedMemberId])

  useEffect(() => { void refreshAll() }, [refreshAll])
  useEffect(() => { if (tab === "operations") void loadAutomationRuns() }, [tab, loadAutomationRuns])
  useEffect(() => {
    if (!selectedMemberId || !members.some((m) => m.playerId === selectedMemberId)) return
    void loadMemberDetail(selectedMemberId)
  }, [selectedMemberId, members, loadMemberDetail])
  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return
    const timer = window.setInterval(() => { void loadJobs() }, 5000)
    return () => window.clearInterval(timer)
  }, [jobs, loadJobs])

  function unlockActions() {
    if (!actionsArmed && !window.confirm("Enable administrative actions for this panel session? This allows connection repairs, account access changes, refresh jobs, settings changes, data exports, and history restores.")) return
    setActionsArmed((value) => !value)
  }

  async function changeMemberStatus(member: AdminMember) {
    if (!actionsArmed) return
    const disabling = !member.disabled
    const reason = disabling ? (window.prompt(`Reason for disabling ${member.playerName}'s dashboard access?`, "Administrative access change") || "").trim() : ""
    if (disabling && !window.confirm(`Disable ${member.playerName} (#${member.playerId}) and revoke active sessions? Their saved data will be retained.`)) return
    try {
      setError(""); setNotice("")
      await adminFetch(apiBase, sessionToken, `/api/admin/members/${encodeURIComponent(member.playerId)}/status`, { method: "POST", body: JSON.stringify({ disabled: disabling, reason }) })
      setNotice(disabling ? `${member.playerName}'s access was disabled and sessions were revoked.` : `${member.playerName}'s dashboard access was restored.`)
      await refreshAll()
      await loadMemberDetail(member.playerId)
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update member access.") }
  }

  async function connectionAction(member: AdminMember, action: "test" | "repair") {
    if (!actionsArmed) return
    if (action === "repair" && !window.confirm(`Attempt to repair ${member.playerName}'s saved company connection using their already-encrypted credentials? No key will be displayed or requested.`)) return
    try {
      setError(""); setNotice("")
      const detail = memberDetail?.member.playerId === member.playerId ? memberDetail : null
      const companyId = detail?.connections.companies?.[0]?.companyId || member.companyId || undefined
      const payload = await adminFetch<{ companyName?: string; companyId?: string; employeesAvailable?: boolean; stockAvailable?: boolean; repaired?: boolean }>(apiBase, sessionToken, `/api/admin/members/${encodeURIComponent(member.playerId)}/connection-${action}`, { method: "POST", body: JSON.stringify(companyId ? { companyId } : {}) })
      setNotice(`${action === "repair" ? "Connection repaired" : "Connection test passed"}: ${payload.companyName || `Company #${payload.companyId}`} (${payload.companyId}).`)
      await refreshAll()
      await loadMemberDetail(member.playerId)
    } catch (caught) { setError(caught instanceof Error ? caught.message : `Could not ${action} this connection.`) }
  }

  async function queueJob(jobType: "global-refresh" | "company-refresh", member?: AdminMember) {
    if (!actionsArmed) return
    if (jobType === "global-refresh" && !window.confirm("Queue a global refresh of company ranking profiles, the next faction-directory batch, and global ranking cache? Torn API rate limits still apply.")) return
    const companyId = member && memberDetail?.member.playerId === member.playerId ? memberDetail?.connections.companies?.[0]?.companyId || member.companyId : member?.companyId
    if (jobType === "company-refresh" && (!member || !companyId || !window.confirm(`Refresh ${member.playerName}'s ${member.companyName || `company #${companyId}`} data now?`))) return
    try {
      setError(""); setNotice("")
      const payload = await adminFetch<{ jobId: string; status: string }>(apiBase, sessionToken, "/api/admin/jobs", { method: "POST", body: JSON.stringify({ jobType, ...(member ? { targetPlayerId: member.playerId, targetCompanyId: companyId } : {}) }) })
      setNotice(`Refresh job ${payload.jobId} was queued.`)
      setTab("operations")
      await loadJobs()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not queue the refresh.") }
  }

  async function saveSettings() {
    if (!actionsArmed || !settingsDirty) return
    if (settings.maintenanceMode && !window.confirm("Enable maintenance mode? Non-administrator accounts will be blocked from dashboard API access until you turn it off.")) return
    try {
      setError(""); setNotice("")
      const payload = await adminFetch<{ settings: AdminSettings; changed: string[] }>(apiBase, sessionToken, "/api/admin/settings", { method: "POST", body: JSON.stringify({ settings }) })
      setSettings(payload.settings)
      setSettingsDirty(false)
      setNotice(`Saved settings: ${(payload.changed || []).join(", ") || "no changes"}.`)
      await refreshAll()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save global settings.") }
  }

  async function exportMemberBackup() {
    if (!actionsArmed || !historyTarget) return
    try {
      setHistoryBusy(true); setError(""); setNotice("")
      const backup = await adminFetch<Record<string, unknown>>(apiBase, sessionToken, `/api/admin/history/backup?playerId=${encodeURIComponent(historyTarget)}`)
      downloadJson(`ncd-admin-backup-${historyTarget}.json`, backup)
      setNotice(`Backup exported for Torn ID ${historyTarget}. API credentials and sessions are excluded.`)
      await loadAudit()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not export this member backup.") }
    finally { setHistoryBusy(false) }
  }

  async function previewRestore() {
    if (!actionsArmed || !restoreFile || !historyTarget) return
    try {
      setHistoryBusy(true); setError(""); setNotice("")
      const fileText = await restoreFile.text()
      JSON.parse(fileText)
      const preview = await adminFetch<{ counts?: Record<string, number>; warnings?: string[]; targetPlayerId?: string }>(apiBase, sessionToken, `/api/admin/history/restore?playerId=${encodeURIComponent(historyTarget)}&preview=1`, { method: "POST", body: fileText })
      setRestorePreview({ ...preview, exportedAt: restoreFile.lastModified ? new Date(restoreFile.lastModified).toISOString() : undefined })
      setNotice("Backup passed the server-side format and owner checks. Review the counts before applying it.")
    } catch (caught) { setRestorePreview(null); setError(caught instanceof Error ? caught.message : "Could not validate this backup.") }
    finally { setHistoryBusy(false) }
  }

  async function applyRestore() {
    if (!actionsArmed || !restoreFile || !historyTarget || !restorePreview) return
    if (!window.confirm(`Apply this backup to Torn ID ${historyTarget}? Existing records will be merged, not deleted. Credentials and sessions will not be restored.`)) return
    try {
      setHistoryBusy(true); setError(""); setNotice("")
      const fileText = await restoreFile.text()
      const payload = await adminFetch<{ counts?: Record<string, number>; message?: string }>(apiBase, sessionToken, `/api/admin/history/restore?playerId=${encodeURIComponent(historyTarget)}`, { method: "POST", headers: { "x-admin-confirm-restore": "yes" }, body: fileText })
      setNotice(payload.message || "History backup restored.")
      setRestorePreview(null); setRestoreFile(null)
      await refreshAll(); await loadAudit()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not restore this backup.") }
    finally { setHistoryBusy(false) }
  }

  async function loadAudit() {
    try { const payload = await adminFetch<{ events: AuditEvent[] }>(apiBase, sessionToken, "/api/admin/audit?limit=50"); setAudit(payload.events || []) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load audit records.") }
  }

  const metrics = (overview?.metrics || {}) as Record<string, unknown>
  const historyStats = (historySummary?.stats || {}) as Record<string, unknown>
  const filteredAutomationRuns = useMemo(() => automationStatusFilter === "all" ? automationRuns : automationRuns.filter((run) => run.status === automationStatusFilter), [automationRuns, automationStatusFilter])
  const tabItems: Array<{ key: AdminTab; label: string; icon: string }> = [
    { key: "overview", label: "Overview", icon: "◫" }, { key: "members", label: "Members", icon: "♙" },
    { key: "operations", label: "Operations", icon: "↻" }, { key: "history", label: "History & Backups", icon: "▤" },
    { key: "settings", label: "Global Settings", icon: "⚙" }, { key: "audit", label: "Audit Log", icon: "≡" },
  ]

  return <div className="admin-console">
    <section className="admin-control-bar">
      <div><span className="admin-secure-pill"><span /> ADMINISTRATOR VERIFIED</span><p>Signed in as <strong>{playerName || "SharpSplinter"}</strong> · Torn ID {playerId}</p></div>
      <button type="button" className={actionsArmed ? "admin-mode-button armed" : "admin-mode-button"} onClick={unlockActions}>{actionsArmed ? "Return to read-only" : "Enable admin actions"}</button>
    </section>
    {!actionsArmed && <p className="admin-readonly-note"><strong>Read-only mode.</strong> Inspect diagnostics and audit records safely. Enable admin actions to change settings, repair connections, queue jobs, export backups, or restore history.</p>}
    {actionsArmed && <p className="admin-armed-note"><strong>Administrative actions enabled for this panel session.</strong> High-impact actions still require confirmation.</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    <nav className="admin-tabs" aria-label="Administration sections">{tabItems.map((item) => <button key={item.key} type="button" className={tab === item.key ? "admin-tab active" : "admin-tab"} onClick={() => setTab(item.key)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>

    {tab === "overview" && <div className="admin-section-stack">
      <div className="admin-section-heading"><div><h2>System overview</h2><p>Operational health and data coverage across the dashboard.</p></div><button type="button" className="secondary-button" onClick={() => void refreshAll()} disabled={loading}>{loading ? "Refreshing…" : "Refresh status ↻"}</button></div>
      <div className="admin-metric-grid">{[
        ["Dashboard members", metrics.members], ["Saved companies", metrics.companies], ["Company credentials", metrics.companyKeys], ["Company snapshots", metrics.companySnapshots], ["Director history points", metrics.directorSnapshots], ["Disabled accounts", metrics.disabledMembers], ["Active jobs", metrics.activeJobs], ["Failed jobs", metrics.failedJobs],
      ].map(([label, value]) => <article className="admin-metric-card" key={String(label)}><small>{String(label)}</small><strong>{value == null ? "—" : Number(value).toLocaleString()}</strong></article>)}</div>
      <div className="admin-two-column"><section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Storage freshness</h3><p>Latest successful company profile stored in D1.</p></div></div><strong className="admin-freshness-value">{prettyDate(metrics.latestCompanyRefresh as string | null)}</strong><p className="field-hint">Most recent company snapshot: {prettyDate(historySummary?.latestCompanySnapshot as string | null)}.</p><p className="field-hint">API health endpoint and database health are verified by separate server checks; these timestamps reflect saved dashboard data.</p></section><section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Recent activity</h3><p>Latest administration events.</p></div><button className="text-button" type="button" onClick={() => setTab("audit")}>Open audit log →</button></div>{(overview?.recentActivity as AuditEvent[] || []).length ? <div className="admin-activity-list">{(overview?.recentActivity as AuditEvent[] || []).map((item) => <div key={item.id} className="admin-activity-row"><span className={`admin-outcome ${item.outcome}`}>{item.outcome}</span><div><strong>{item.summary}</strong><small>{item.actorPlayerName} · {prettyDate(item.createdAt)}</small></div></div>)}</div> : <div className="empty-state">No administrative events recorded yet.</div>}</section></div>
    </div>}

    {tab === "members" && <div className="admin-section-stack">
      <div className="admin-section-heading"><div><h2>Member management</h2><p>{memberTotal.toLocaleString()} dashboard accounts. Disabling access revokes active sessions and preserves saved history.</p></div><button className="secondary-button" type="button" onClick={() => void loadMembers(memberQuery)}>Reload members</button></div>
      <form className="admin-search-row" onSubmit={(event) => { event.preventDefault(); setMemberSearch(memberQuery); void loadMembers(memberQuery) }}><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder="Search Torn name, ID, or company" aria-label="Search dashboard members" /><button className="primary-button" type="submit">Search</button></form>
      <div className="admin-members-layout"><section className="panel admin-subpanel"><div className="table-scroll"><table className="admin-table"><thead><tr><th>MEMBER</th><th>COMPANY</th><th>CONNECTION</th><th>ACCESS</th><th>ACTIONS</th></tr></thead><tbody>{members.map((member) => <tr key={member.playerId} className={selectedMemberId === member.playerId ? "selected" : ""}><td><button type="button" className="admin-member-link" onClick={() => void loadMemberDetail(member.playerId)}><strong>{member.playerName}</strong><small>#{member.playerId}</small></button></td><td>{member.companyName || "—"}<small className="admin-cell-subtitle">{member.companyType || "Company not connected"}{member.companyTypeId ? ` · type ${member.companyTypeId}` : ""}</small></td><td><span className={member.companyKeyCount > 0 ? "admin-status good" : member.loginKeySaved ? "admin-status warning" : "admin-status neutral"}>{member.companyKeyCount > 0 ? `${member.companyKeyCount} company key(s)` : member.loginKeySaved ? "Login key only" : "No key"}</span><small className="admin-cell-subtitle">{member.snapshotCount} snapshots</small></td><td><span className={member.disabled ? "admin-status danger" : "admin-status good"}>{member.disabled ? "Disabled" : "Active"}</span></td><td><div className="admin-row-actions"><button type="button" className="text-button" onClick={() => void loadMemberDetail(member.playerId)}>Details</button><button type="button" className="text-button" disabled={!actionsArmed || member.playerId === "351311"} onClick={() => void changeMemberStatus(member)}>{member.disabled ? "Restore" : "Disable"}</button></div></td></tr>)}</tbody></table></div>{!members.length && <div className="empty-state">No matching members were found.</div>}</section>
        <aside className="panel admin-subpanel admin-member-detail"><div className="panel-heading"><div><h3>{memberDetail?.member.playerName || selectedMember?.playerName || "Member details"}</h3><p>{memberDetail ? `Torn ID ${memberDetail.member.playerId}` : "Select a member from the directory."}</p></div></div>
          {memberDetail ? <><div className="admin-detail-facts"><span><small>LOGIN KEY</small><strong>{memberDetail.connections.loginKeySaved ? "Saved" : "Missing"}</strong></span><span><small>COMPANY KEY</small><strong>{memberDetail.connections.companies.length || 0}</strong></span><span><small>COMPANY HISTORY</small><strong>{memberDetail.history.companySnapshots.toLocaleString()}</strong></span><span><small>DIRECTOR HISTORY</small><strong>{memberDetail.history.directorSnapshots.toLocaleString()}</strong></span></div><div className="admin-connection-list">{memberDetail.connections.companies.length ? memberDetail.connections.companies.map((company) => <div key={company.companyId}><strong>{company.companyName || `Company #${company.companyId}`}</strong><small>{company.companyType || "Unknown type"} · #{company.companyId}</small><small>Key updated {prettyDate(company.keyUpdatedAt)} · Snapshot {prettyDate(company.fetchedAt)}</small></div>) : <div className="empty-state">No per-company key is saved. A repair can test the already-encrypted login credential.</div>}</div><div className="admin-detail-actions"><button type="button" className="secondary-button" disabled={!actionsArmed} onClick={() => void connectionAction(memberDetail.member, "test")}>Test connection</button><button type="button" className="primary-button" disabled={!actionsArmed} onClick={() => void connectionAction(memberDetail.member, "repair")}>Repair connection</button><button type="button" className="secondary-button" disabled={!actionsArmed || !(memberDetail.connections.companies?.[0]?.companyId || selectedMember?.companyId)} onClick={() => void queueJob("company-refresh", selectedMember ? { ...selectedMember, companyId: memberDetail.connections.companies?.[0]?.companyId || selectedMember.companyId, companyName: memberDetail.connections.companies?.[0]?.companyName || selectedMember.companyName, companyType: memberDetail.connections.companies?.[0]?.companyType || selectedMember.companyType } : memberDetail.member)}>Refresh company</button></div><p className="field-hint">Credentials are tested server-side. The panel never displays or requests stored API keys.</p></> : <div className="empty-state">Choose a member to inspect connection status and saved history.</div>}
        </aside>
      </div>
    </div>}

    {tab === "operations" && <div className="admin-section-stack">
      <div className="admin-section-heading"><div><h2>Refresh and maintenance jobs</h2><p>Jobs are tracked in D1, prevent equivalent concurrent requests, and report final outcomes.</p></div><button type="button" className="secondary-button" onClick={() => void loadJobs()}>Refresh job list ↻</button></div>
      <section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Manual refresh</h3><p>Global refresh updates ranking profiles, one faction-directory batch, and the global ranking cache.</p></div><span className={settings.manualRefreshEnabled ? "admin-status good" : "admin-status danger"}>{settings.manualRefreshEnabled ? "Enabled by policy" : "Disabled by policy"}</span></div><button className="primary-button" type="button" disabled={!actionsArmed || !settings.manualRefreshEnabled} onClick={() => void queueJob("global-refresh")}>Queue global refresh ↻</button><p className="field-hint">Company-specific refresh is available from a member's detail panel. Work is performed server-side and does not depend on the browser remaining open.</p></section>
      <section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Job history</h3><p>Most recent tracked jobs and failures.</p></div><span className="count-chip">{jobs.length} jobs</span></div>{jobs.length ? <div className="table-scroll"><table className="admin-table"><thead><tr><th>JOB</th><th>TARGET</th><th>STATUS</th><th>CREATED</th><th>RESULT / ERROR</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.jobId}><td><strong>{prettyStatus(job.jobType)}</strong><small>{job.jobId}</small></td><td>{job.targetPlayerId ? `#${job.targetPlayerId}` : "Global"}{job.targetCompanyId ? <small>Company #{job.targetCompanyId}</small> : null}</td><td><span className={`admin-status ${job.status === "completed" ? "good" : job.status === "failed" ? "danger" : "warning"}`}>{job.status}</span></td><td>{prettyDate(job.createdAt)}</td><td>{job.errorMessage || (job.result && typeof job.result === "object" ? JSON.stringify(job.result) : job.status === "completed" ? "Completed" : "Waiting for result")}</td></tr>)}</tbody></table></div> : <div className="empty-state">No administrative jobs have been queued yet.</div>}</section>
      <section className="panel admin-subpanel admin-automation-insights">
        <div className="panel-heading"><div><h3>Automation Insights</h3><p>Execution reliability, runtime, and recurring failure patterns for scheduled Worker runs.</p></div><div className="admin-insight-controls"><label>Time window<select value={automationRange} onChange={(event) => setAutomationRange(event.target.value as AutomationRange)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option><option value="all">All time</option></select></label><label>Run status<select value={automationStatusFilter} onChange={(event) => setAutomationStatusFilter(event.target.value as AutomationStatusFilter)}><option value="all">All outcomes</option><option value="succeeded">Succeeded</option><option value="partial">Partial</option><option value="failed">Failed</option><option value="running">Running</option></select></label><button type="button" className="secondary-button" onClick={() => void loadAutomationRuns()}>Refresh insights ↻</button></div></div>
        <div className="admin-metric-grid admin-automation-metrics">
          <article className="admin-metric-card"><small>Success rate</small><strong>{automationInsights?.successRate == null ? "—" : `${automationInsights.successRate}%`}</strong><span className="admin-insight-footnote">Completed runs only</span></article>
          <article className="admin-metric-card"><small>Completed runs</small><strong>{automationInsights ? Number(automationInsights.completedRuns).toLocaleString() : "—"}</strong><span className="admin-insight-footnote">{automationInsights?.runningRuns ? `${automationInsights.runningRuns} currently running` : "Finished executions"}</span></article>
          <article className="admin-metric-card"><small>Failed / partial</small><strong className={(automationInsights?.failedRuns || automationInsights?.partialRuns) ? "admin-insight-warning" : ""}>{automationInsights ? (automationInsights.failedRuns + automationInsights.partialRuns).toLocaleString() : "—"}</strong><span className="admin-insight-footnote">{automationInsights ? `${automationInsights.failedRuns} failed · ${automationInsights.partialRuns} partial` : "Run outcomes"}</span></article>
          <article className="admin-metric-card"><small>Average duration</small><strong>{formatDuration(automationInsights?.avgDurationSeconds)}</strong><span className="admin-insight-footnote">Finished runs with timing data</span></article>
          <article className="admin-metric-card"><small>Company failures</small><strong>{automationInsights ? Number(automationInsights.companiesFailed).toLocaleString() : "—"}</strong><span className="admin-insight-footnote">Across the selected window</span></article>
          <article className="admin-metric-card"><small>Alerts generated</small><strong>{automationInsights ? Number(automationInsights.alertsCreated).toLocaleString() : "—"}</strong><span className="admin-insight-footnote">Alerts emitted by automation</span></article>
        </div>
        <div className="admin-insight-failures"><div className="admin-insight-subheading"><h4>Failure patterns</h4><p>Most common recorded error summaries in this time window.</p></div>{automationInsights?.recurringFailures?.length ? <div className="admin-failure-list">{automationInsights.recurringFailures.map((failure) => <article className="admin-failure-item" key={failure.errorSummary}><span className="admin-failure-count">{failure.occurrences}×</span><p>{failure.errorSummary}</p></article>)}</div> : <p className="admin-insight-empty">No recorded failure summaries for this time window.</p>}</div>
      </section>
      <section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Scheduled automation runs</h3><p>Daily refresh, company-check outcomes, and alert evaluation history.</p></div><span className="count-chip">{filteredAutomationRuns.length} shown · {Number(automationInsights?.totalRuns ?? automationRuns.length).toLocaleString()} total</span></div>{filteredAutomationRuns.length ? <div className="table-scroll"><table className="admin-table"><thead><tr><th>STARTED</th><th>TRIGGER</th><th>STATUS</th><th>DURATION</th><th>COMPANIES</th><th>ALERTS</th><th>SUMMARY</th></tr></thead><tbody>{filteredAutomationRuns.map((run) => <tr key={run.runId}><td>{prettyDate(run.startedAt)}</td><td>{prettyStatus(run.triggerName)}</td><td><span className={`admin-status ${run.status === "succeeded" ? "good" : run.status === "failed" ? "danger" : "warning"}`}>{run.status}</span></td><td>{runDuration(run)}</td><td>{run.companiesChecked} checked<small>{run.companiesFailed} failed</small></td><td>{run.alertsCreated}</td><td>{run.errorSummary || (run.finishedAt ? "Completed" : "Run in progress")}</td></tr>)}</tbody></table></div> : <div className="empty-state">{automationRuns.length ? "No runs match this status filter." : "No scheduled runs have been recorded for this time window yet."}</div>}{Number(automationInsights?.totalRuns ?? 0) > automationRuns.length && <p className="field-hint">Showing the latest {automationRuns.length} runs. Summary metrics include every run in the selected time window.</p>}</section>
    </div>}

    {tab === "history" && <div className="admin-section-stack">
      <div className="admin-section-heading"><div><h2>History and backups</h2><p>Inspect record coverage, export a selected member's backup, or validate and restore a compatible backup.</p></div><button type="button" className="secondary-button" onClick={() => void refreshAll()}>Reload coverage</button></div>
      <div className="admin-metric-grid admin-history-metrics">{[["Companies", historyStats.companies], ["Financial records", historyStats.financialRecords], ["Company snapshots", historyStats.companySnapshots], ["Director snapshots", historyStats.directorSnapshots], ["Page-data records", historyStats.pageRecords]].map(([label, value]) => <article className="admin-metric-card" key={String(label)}><small>{String(label)}</small><strong>{value == null ? "—" : Number(value).toLocaleString()}</strong></article>)}</div>
      <section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Export member backup</h3><p>The JSON file contains saved company records, supported page data, and historical snapshots. API credentials, sessions, and admin settings are excluded.</p></div></div><label className="admin-field-label" htmlFor="admin-history-target">Target dashboard member</label><select id="admin-history-target" value={historyTarget} onChange={(event) => { setHistoryTarget(event.target.value); setRestorePreview(null) }}><option value="">Select a member…</option>{members.map((member) => <option value={member.playerId} key={member.playerId}>{member.playerName} · #{member.playerId}</option>)}</select><button type="button" className="primary-button" disabled={!actionsArmed || historyBusy || !historyTarget} onClick={() => void exportMemberBackup()}>Export backup ↓</button></section>
      <section className="panel admin-subpanel"><div className="panel-heading"><div><h3>Restore from backup</h3><p>Restoration is limited to the member ID encoded in the backup. Preview counts first. The operation merges data and does not delete current records.</p></div><span className={settings.historyImportEnabled ? "admin-status good" : "admin-status danger"}>{settings.historyImportEnabled ? "Imports enabled" : "Imports disabled"}</span></div><label className="admin-field-label" htmlFor="admin-restore-file">Compatible admin backup or master dashboard backup (.json)</label><input id="admin-restore-file" type="file" accept="application/json,.json" disabled={!actionsArmed || !settings.historyImportEnabled || historyBusy} onChange={(event) => { setRestoreFile(event.target.files?.[0] || null); setRestorePreview(null) }} /><div className="admin-detail-actions"><button type="button" className="secondary-button" disabled={!actionsArmed || !settings.historyImportEnabled || historyBusy || !restoreFile || !historyTarget} onClick={() => void previewRestore()}>{historyBusy ? "Validating…" : "Validate & preview"}</button><button type="button" className="primary-button" disabled={!actionsArmed || !settings.historyImportEnabled || historyBusy || !restorePreview} onClick={() => void applyRestore()}>Apply restore</button></div>{restorePreview && <div className="admin-restore-preview"><strong>Server-side preflight passed for Torn ID {restorePreview.targetPlayerId || historyTarget}</strong><div className="admin-restore-counts">{Object.entries(restorePreview.counts || {}).map(([key, value]) => <span key={key}><small>{prettyStatus(key)}</small><strong>{value}</strong></span>)}</div><ul>{(restorePreview.warnings || []).map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}</section>
    </div>}

    {tab === "settings" && <div className="admin-section-stack">
      <div className="admin-section-heading"><div><h2>Global dashboard settings</h2><p>Settings are validated server-side and kept separate from each member's personal sharing preferences.</p></div><button type="button" className="primary-button" disabled={!actionsArmed || !settingsDirty} onClick={() => void saveSettings()}>Save settings</button></div>
      <section className="panel admin-subpanel admin-settings-list">{[
        { key: "maintenanceMode" as const, title: "Maintenance mode", description: "Block non-administrator dashboard API access. The SharpSplinter admin account remains able to turn this off." },
        { key: "manualRefreshEnabled" as const, title: "Manual refresh operations", description: "Allow dashboard members to request their own refreshes and allow administrators to queue supported refresh jobs." },
        { key: "historyImportEnabled" as const, title: "History imports and restores", description: "Allow member history imports and administrative history restoration. Exporting backups remains a separate audited action." },
      ].map((item) => <label className="admin-setting-row" key={item.key}><span className="admin-toggle"><input type="checkbox" checked={settings[item.key]} disabled={!actionsArmed} onChange={(event) => { setSettings((current) => ({ ...current, [item.key]: event.target.checked })); setSettingsDirty(true) }} /><i /></span><span><strong>{item.title}</strong><small>{item.description}</small></span><em>{settings[item.key] ? "Enabled" : "Disabled"}</em></label>)}{settingsDirty && <p className="admin-armed-note">Unsaved settings changes. They do not take effect until you save.</p>}</section>
      <p className="field-hint">Global settings affect server behavior. Audit records track updates. Member-specific sharing settings and opt-in comparisons remain independent.</p>
    </div>}

    {tab === "audit" && <div className="admin-section-stack">
      <div className="admin-section-heading"><div><h2>Administrative audit log</h2><p>Append-only through the dashboard. Records show actor, action, target, result, and timestamp.</p></div><button type="button" className="secondary-button" onClick={() => void loadAudit()}>Reload audit ↻</button></div>
      <section className="panel admin-subpanel"><div className="table-scroll"><table className="admin-table"><thead><tr><th>WHEN</th><th>ACTOR</th><th>ACTION</th><th>TARGET</th><th>OUTCOME</th><th>SUMMARY</th></tr></thead><tbody>{audit.map((event) => <tr key={event.id}><td>{prettyDate(event.createdAt)}</td><td>{event.actorPlayerName}<small>#{event.actorPlayerId}</small></td><td><code>{event.action}</code></td><td>{event.targetType ? `${event.targetType}${event.targetId ? ` · ${event.targetId}` : ""}` : "—"}</td><td><span className={`admin-status ${event.outcome === "succeeded" ? "good" : event.outcome === "failed" || event.outcome === "denied" ? "danger" : "warning"}`}>{event.outcome}</span></td><td>{event.summary}</td></tr>)}</tbody></table></div>{!audit.length && <div className="empty-state">No audit events have been recorded.</div>}</section>
    </div>}
  </div>
}
