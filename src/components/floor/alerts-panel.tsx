import { useCallback, useEffect, useState } from "react"
import type { FormEvent } from "react"

type AlertRuleType = "income_drop" | "stale_data" | "refresh_failure"
type CompanyOption = { company_id: string; company_name: string | null }
type AlertRule = { ruleId: string; companyId: string | null; companyName?: string | null; ruleType: AlertRuleType; enabled: number | boolean; thresholdPercent: number; cooldownHours: number; staleAfterHours: number; lastTriggeredAt?: string | null; createdAt: string }
type AlertEvent = { eventId: string; ruleId: string; companyId: string | null; companyName?: string | null; ruleType: AlertRuleType; severity: "info" | "warning" | "critical"; title: string; message: string; previousValue?: number | null; currentValue?: number | null; changePercent?: number | null; sourceSnapshotAt?: string | null; status: "unread" | "acknowledged"; createdAt: string; acknowledgedAt?: string | null }
type AutomationRun = { triggerName: string; status: string; startedAt: string; finishedAt?: string | null; companiesChecked: number; companiesFailed: number; alertsCreated: number } | null
type Props = { apiBase: string; sessionToken: string; companies: CompanyOption[]; selectedCompanyId: string; demoMode: boolean; onNavigateCharts: () => void }

async function automationFetch<T>(apiBase: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>
  if (!response.ok) throw new Error(payload.error || `Automation request failed (${response.status}).`)
  return payload as T
}

function prettyDate(value?: string | null) {
  if (!value) return "Not yet"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}

function ruleLabel(type: AlertRuleType) {
  return type === "income_drop" ? "Daily income drop" : type === "stale_data" ? "Stale company data" : "Refresh failure"
}

function ruleDescription(type: AlertRuleType) {
  return type === "income_drop" ? "Notify when daily income drops by the selected percentage between successful snapshots." : type === "stale_data" ? "Notify when the latest successful snapshot is older than your chosen age limit." : "Notify when a scheduled refresh fails for a connected company."
}

export function AlertsPanel({ apiBase, sessionToken, companies, selectedCompanyId, demoMode, onNavigateCharts }: Props) {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [latestRun, setLatestRun] = useState<AutomationRun>(null)
  const [ruleType, setRuleType] = useState<AlertRuleType>("income_drop")
  const [companyId, setCompanyId] = useState(selectedCompanyId)
  const [thresholdPercent, setThresholdPercent] = useState(15)
  const [cooldownHours, setCooldownHours] = useState(24)
  const [staleAfterHours, setStaleAfterHours] = useState(30)
  const [loading, setLoading] = useState(false)
  const [backendAvailable, setBackendAvailable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  useEffect(() => { if (!companyId && selectedCompanyId) setCompanyId(selectedCompanyId) }, [companyId, selectedCompanyId])

  const load = useCallback(async () => {
    if (!sessionToken || demoMode) { setRules([]); setEvents([]); setUnreadCount(0); setLatestRun(null); return }
    setLoading(true)
    setError("")
    try {
      const [rulePayload, alertPayload] = await Promise.all([
        automationFetch<{ rules: AlertRule[] }>(apiBase, sessionToken, "/api/me/alert-rules"),
        automationFetch<{ events: AlertEvent[]; unreadCount: number; latestRun: AutomationRun }>(apiBase, sessionToken, "/api/me/alerts?limit=50"),
      ])
      setRules(rulePayload.rules || [])
      setEvents(alertPayload.events || [])
      setUnreadCount(alertPayload.unreadCount || 0)
      setLatestRun(alertPayload.latestRun || null)
      setBackendAvailable(true)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not load automation data."
      if (message.includes("(404)")) {
        setBackendAvailable(false)
        setError("The Automation Center backend is not deployed to this preview yet. The interface is available, but the Worker routes and D1 migration must be deployed before alerts can run.")
      } else setError(message)
    }
    finally { setLoading(false) }
  }, [apiBase, sessionToken, demoMode])

  useEffect(() => { void load() }, [load])

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!sessionToken || demoMode || saving || !backendAvailable) return
    setSaving(true); setError(""); setNotice("")
    try {
      await automationFetch(apiBase, sessionToken, "/api/me/alert-rules", { method: "POST", body: JSON.stringify({ ruleType, companyId: companyId || null, thresholdPercent, cooldownHours, staleAfterHours }) })
      setNotice(`${ruleLabel(ruleType)} rule created.`)
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the alert rule.") }
    finally { setSaving(false) }
  }

  async function updateRule(rule: AlertRule, enabled: boolean) {
    setError(""); setNotice("")
    try {
      await automationFetch(apiBase, sessionToken, `/api/me/alert-rules/${encodeURIComponent(rule.ruleId)}`, { method: "POST", body: JSON.stringify({ enabled }) })
      setNotice(`${ruleLabel(rule.ruleType)} ${enabled ? "enabled" : "paused"}.`)
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update the alert rule.") }
  }

  async function deleteRule(rule: AlertRule) {
    if (!window.confirm(`Delete the ${ruleLabel(rule.ruleType)} rule and its alert history?`)) return
    setError(""); setNotice("")
    try {
      await automationFetch(apiBase, sessionToken, `/api/me/alert-rules/${encodeURIComponent(rule.ruleId)}`, { method: "DELETE" })
      setNotice("Alert rule deleted.")
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not delete the alert rule.") }
  }

  async function acknowledge(event: AlertEvent) {
    try {
      await automationFetch(apiBase, sessionToken, `/api/me/alerts/${encodeURIComponent(event.eventId)}/acknowledge`, { method: "POST" })
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not acknowledge this alert.") }
  }

  if (demoMode || !sessionToken) return <div className="automation-workspace"><section className="panel automation-intro"><div className="automation-eyebrow">AUTOMATION CENTER</div><h2>Let the dashboard watch the numbers.</h2><p>Sign in to create private alerts for your connected companies. Demo data is never monitored, and alert rules are not active in demo mode.</p></section><div className="empty-state">Automation requires an authenticated dashboard session.</div></div>

  return <div className="automation-workspace">
    <section className="panel automation-intro">
      <div className="automation-intro-copy"><div className="automation-eyebrow">AUTOMATION CENTER</div><h2>Catch important changes without babysitting the dashboard.</h2><p>Private, in-app alerts evaluate your own saved company snapshots. Rules use successful refreshes, cooldowns, and duplicate protection. They never change who can see your data.</p></div>
      <div className="automation-intro-stats"><div><small>UNREAD ALERTS</small><strong>{unreadCount}</strong></div><div><small>ACTIVE RULES</small><strong>{rules.filter((rule) => Boolean(rule.enabled)).length}</strong></div></div>
    </section>
    {error && <div className="error-banner" role="alert">{error}</div>}{notice && <div className="automation-notice" role="status">{notice}</div>}
    <section className="panel automation-run-card">
      <div className="panel-heading"><div><h2>Automation health</h2><p>Scheduled refreshes are recorded so failed or partial runs are visible.</p></div><button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? "Checking…" : "Refresh status ↻"}</button></div>
      {latestRun ? <div className="automation-run-summary"><span className={`automation-status ${latestRun.status}`}>{latestRun.status}</span><div><strong>Last scheduled run</strong><p>{prettyDate(latestRun.finishedAt || latestRun.startedAt)} · {latestRun.companiesChecked} companies checked · {latestRun.companiesFailed} failures · {latestRun.alertsCreated} alerts generated</p></div></div> : <div className="empty-state">No scheduled run has been recorded yet. Automation health will appear after the next scheduled Worker run.</div>}
    </section>
    <div className="automation-grid">
      <section className="panel automation-rule-builder">
        <div className="panel-heading"><div><h2>Create an alert rule</h2><p>Choose a template. Notifications stay inside your account.</p></div></div>
        <form className="automation-form" onSubmit={createRule}>
          <label>Alert type<select value={ruleType} onChange={(event) => setRuleType(event.target.value as AlertRuleType)}><option value="income_drop">Daily income drop</option><option value="stale_data">Stale company data</option><option value="refresh_failure">Refresh failure</option></select></label>
          <p className="automation-description">{ruleDescription(ruleType)}</p>
          <label>Company scope<select value={companyId} onChange={(event) => setCompanyId(event.target.value)}><option value="">All connected companies</option>{companies.map((company) => <option key={company.company_id} value={company.company_id}>{company.company_name || `Company #${company.company_id}`}</option>)}</select></label>
          {ruleType === "income_drop" && <label>Trigger when daily income drops<select value={thresholdPercent} onChange={(event) => setThresholdPercent(Number(event.target.value))}><option value={5}>5% or more</option><option value={10}>10% or more</option><option value={15}>15% or more</option><option value={20}>20% or more</option><option value={30}>30% or more</option><option value={50}>50% or more</option></select></label>}
          {ruleType === "stale_data" && <label>Mark data stale after<select value={staleAfterHours} onChange={(event) => setStaleAfterHours(Number(event.target.value))}><option value={24}>24 hours</option><option value={30}>30 hours</option><option value={36}>36 hours</option><option value={48}>48 hours</option><option value={72}>72 hours</option></select></label>}
          <label>Repeat alert cooldown<select value={cooldownHours} onChange={(event) => setCooldownHours(Number(event.target.value))}><option value={1}>1 hour</option><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></label>
          <button className="primary-button" type="submit" disabled={saving || loading || !backendAvailable}>{!backendAvailable ? "Backend deployment pending" : saving ? "Saving rule…" : "Create alert rule →"}</button>
        </form>
      </section>
      <section className="panel automation-rules-list">
        <div className="panel-heading"><div><h2>Your rules</h2><p>Pause a rule without deleting its history.</p></div><span className="count-chip">{rules.length} total</span></div>
        {loading && !rules.length ? <div className="empty-state">Loading alert rules…</div> : rules.length ? <div className="automation-rule-list">{rules.map((rule) => <article className="automation-rule-card" key={rule.ruleId}><div className="automation-rule-top"><span className={`automation-rule-icon ${rule.enabled ? "enabled" : "paused"}`}>{rule.enabled ? "●" : "Ⅱ"}</span><div><h3>{ruleLabel(rule.ruleType)}</h3><p>{rule.companyName || (rule.companyId ? `Company #${rule.companyId}` : "All connected companies")}</p></div><span className={`automation-rule-state ${rule.enabled ? "enabled" : "paused"}`}>{rule.enabled ? "Active" : "Paused"}</span></div><p className="automation-rule-detail">{rule.ruleType === "income_drop" ? `Drop threshold ${rule.thresholdPercent}% · ` : rule.ruleType === "stale_data" ? `Stale after ${rule.staleAfterHours}h · ` : "Refresh failure · "}Cooldown ${rule.cooldownHours}h · Last triggered {prettyDate(rule.lastTriggeredAt)}</p><div className="automation-rule-actions"><button className="secondary-button" type="button" onClick={() => void updateRule(rule, !Boolean(rule.enabled))}>{Boolean(rule.enabled) ? "Pause" : "Enable"}</button><button className="text-button" type="button" onClick={() => void deleteRule(rule)}>Delete rule</button></div></article>)}</div> : <div className="empty-state">No rules yet. Create one to let the dashboard monitor changes for you.</div>}
      </section>
    </div>
    <section className="panel automation-inbox">
      <div className="panel-heading"><div><h2>Alert inbox</h2><p>Recent changes and system warnings for your connected companies.</p></div><span className="count-chip">{unreadCount} unread</span></div>
      {loading && !events.length ? <div className="empty-state">Loading alerts…</div> : events.length ? <div className="automation-event-list">{events.map((event) => <article className={`automation-event-card ${event.status === "acknowledged" ? "acknowledged" : ""}`} key={event.eventId}><div className={`automation-event-severity ${event.severity}`}>{event.severity === "critical" ? "!" : event.severity === "warning" ? "▲" : "i"}</div><div className="automation-event-content"><div className="automation-event-meta"><span>{ruleLabel(event.ruleType)}</span><span>{prettyDate(event.createdAt)}</span></div><h3>{event.title}</h3><p>{event.message}</p>{event.companyName && <small>{event.companyName}</small>}{event.changePercent != null && <div className="automation-event-values"><span>Previous {Number(event.previousValue ?? 0).toLocaleString()}</span><span>Current {Number(event.currentValue ?? 0).toLocaleString()}</span><strong>{event.changePercent.toFixed(1)}%</strong></div>}{event.sourceSnapshotAt && <small>Snapshot: {prettyDate(event.sourceSnapshotAt)}</small>}</div><div className="automation-event-actions">{event.status === "unread" ? <button className="secondary-button" type="button" onClick={() => void acknowledge(event)}>Acknowledge</button> : <span className="automation-acknowledged">Acknowledged</span>}{event.ruleType === "income_drop" && <button className="text-button" type="button" onClick={onNavigateCharts}>Open trends ↗</button>}</div></article>)}</div> : <div className="empty-state">No alerts yet. When a rule detects a meaningful change, it will appear here.</div>}
    </section>
  </div>
}
