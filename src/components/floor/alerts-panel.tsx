import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"

type AlertRuleType = "income_drop" | "stale_data" | "refresh_failure" | "income_increase" | "rating_drop" | "roster_change"
type CompanyOption = { company_id: string; company_name: string | null }
type AlertRule = { ruleId: string; companyId: string | null; companyName?: string | null; ruleType: AlertRuleType; enabled: number | boolean; thresholdPercent: number; cooldownHours: number; staleAfterHours: number; lastTriggeredAt?: string | null; createdAt: string }
type AlertEvent = { eventId: string; ruleId: string; companyId: string | null; companyName?: string | null; ruleType: AlertRuleType; severity: "info" | "warning" | "critical"; title: string; message: string; previousValue?: number | null; currentValue?: number | null; changePercent?: number | null; sourceSnapshotAt?: string | null; status: "unread" | "acknowledged"; createdAt: string; acknowledgedAt?: string | null }
type AutomationRun = { triggerName: string; status: string; startedAt: string; finishedAt?: string | null; companiesChecked: number; companiesFailed: number; alertsCreated: number } | null
type Props = { apiBase: string; sessionToken: string; companies: CompanyOption[]; selectedCompanyId: string; demoMode: boolean; onNavigateCharts: () => void }
type AutomationPreferences = { browserNotificationsEnabled: boolean; quietHoursEnabled: boolean; quietHoursStart: string; quietHoursEnd: string; timezone: string; minimumSeverity: "info" | "warning" | "critical"; digestMode: "instant" | "daily" | "off" }
type WebhookDelivery = { deliveryId: string; eventId: string; status: "delivered" | "failed"; statusCode?: number | null; detail?: string | null; createdAt: string; deliveredAt?: string | null }
const DEFAULT_PREFERENCES: AutomationPreferences = { browserNotificationsEnabled: false, quietHoursEnabled: false, quietHoursStart: "22:00", quietHoursEnd: "08:00", timezone: "UTC", minimumSeverity: "info", digestMode: "instant" }

async function automationFetch<T>(apiBase: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
  })
  const payload = await response.json().catch(() => ({})) as { error?: string } & Record<string, unknown>
  if (!response.ok) throw Object.assign(new Error(payload.error || `Automation request failed (${response.status}).`), { status: response.status })
  return payload as T
}

function prettyDate(value?: string | null) {
  if (!value) return "Not yet"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}

function ruleLabel(type: AlertRuleType) {
  return type === "income_drop" ? "Daily income drop" : type === "stale_data" ? "Stale company data" : type === "refresh_failure" ? "Refresh failure" : type === "income_increase" ? "Daily income increase" : type === "rating_drop" ? "Company rating drop" : "Employee roster change"
}

function ruleDescription(type: AlertRuleType) {
  return type === "income_drop" ? "Notify when daily income falls by the selected percentage between successful snapshots." : type === "stale_data" ? "Notify when the latest successful snapshot is older than your chosen age limit." : type === "refresh_failure" ? "Notify when a scheduled company refresh fails." : type === "income_increase" ? "Celebrate a daily income increase that exceeds your selected threshold." : type === "rating_drop" ? "Notify when the company rating drops materially between successful snapshots." : "Notify when employee headcount changes by the selected percentage between snapshots."
}

export function AlertsPanel({ apiBase, sessionToken, companies, selectedCompanyId, demoMode, onNavigateCharts }: Props) {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [alertSearch, setAlertSearch] = useState("")
  const [alertStatusFilter, setAlertStatusFilter] = useState<"all" | "unread" | "acknowledged">("all")
  const [alertTypeFilter, setAlertTypeFilter] = useState<"all" | AlertRuleType>("all")
  const [alertSeverityFilter, setAlertSeverityFilter] = useState<"all" | AlertEvent["severity"]>("all")
  const [alertCompanyFilter, setAlertCompanyFilter] = useState("all")
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
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [editThresholdPercent, setEditThresholdPercent] = useState(15)
  const [editCooldownHours, setEditCooldownHours] = useState(24)
  const [editStaleAfterHours, setEditStaleAfterHours] = useState(30)
  const [savingRuleId, setSavingRuleId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [preferences, setPreferences] = useState<AutomationPreferences>(DEFAULT_PREFERENCES)
  const [webhookUrl, setWebhookUrl] = useState("")
  const [webhookConfigured, setWebhookConfigured] = useState(false)
  const [webhookBusy, setWebhookBusy] = useState(false)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const seenEventIds = useRef(new Set<string>())
  const initialEventsLoaded = useRef(false)
  const loadRequestId = useRef(0)

  useEffect(() => { if (!companyId && selectedCompanyId) setCompanyId(selectedCompanyId) }, [companyId, selectedCompanyId])

  const load = useCallback(async () => {
    const requestId = ++loadRequestId.current
    if (!sessionToken || demoMode) { setRules([]); setEvents([]); setUnreadCount(0); setLatestRun(null); return }
    setLoading(true)
    setError("")
    try {
      const [rulePayload, alertPayload] = await Promise.all([
        automationFetch<{ rules: AlertRule[] }>(apiBase, sessionToken, "/api/me/alert-rules"),
        automationFetch<{ events: AlertEvent[]; unreadCount: number; latestRun: AutomationRun }>(apiBase, sessionToken, "/api/me/alerts?limit=50"),
      ])
      if (requestId !== loadRequestId.current) return
      setRules(rulePayload.rules || [])
      setEvents(alertPayload.events || [])
      if (!initialEventsLoaded.current) { for (const event of alertPayload.events || []) seenEventIds.current.add(event.eventId); initialEventsLoaded.current = true }
      setUnreadCount(alertPayload.unreadCount || 0)
      setLatestRun(alertPayload.latestRun || null)
      setBackendAvailable(true)
      const [prefsResult, hookResult, deliveryResult] = await Promise.allSettled([
        automationFetch<{ preferences: Record<string, unknown> }>(apiBase, sessionToken, "/api/me/automation-preferences"),
        automationFetch<{ configured: boolean }>(apiBase, sessionToken, "/api/me/automation-webhook"),
        automationFetch<{ deliveries: WebhookDelivery[] }>(apiBase, sessionToken, "/api/me/automation-webhook/deliveries?limit=10"),
      ])
      if (requestId !== loadRequestId.current) return
      if (prefsResult.status === "fulfilled") { const raw = prefsResult.value.preferences; setPreferences({ browserNotificationsEnabled: Boolean(raw.browserNotificationsEnabled), quietHoursEnabled: Boolean(raw.quietHoursEnabled), quietHoursStart: String(raw.quietHoursStart || "22:00"), quietHoursEnd: String(raw.quietHoursEnd || "08:00"), timezone: String(raw.timezone || "UTC"), minimumSeverity: ["info", "warning", "critical"].includes(String(raw.minimumSeverity)) ? raw.minimumSeverity as AutomationPreferences["minimumSeverity"] : "info", digestMode: raw.digestMode === "daily" ? "daily" : raw.digestMode === "off" ? "off" : "instant" }) }
      if (hookResult.status === "fulfilled") setWebhookConfigured(hookResult.value.configured === true)
      if (deliveryResult.status === "fulfilled") setDeliveries(deliveryResult.value.deliveries || [])
    } catch (caught) {
      if (requestId !== loadRequestId.current) return
      const message = caught instanceof Error ? caught.message : "Could not load automation data."
      const status = caught && typeof caught === "object" && "status" in caught ? Number((caught as { status?: unknown }).status) : 0
      if (status === 404 || message.includes("(404)")) {
        setBackendAvailable(false)
        setError("The Automation Center API is not deployed to this environment yet. Deploy the updated Worker and D1 migration before alerts can load.")
      } else setError(message)
    }
    finally { if (requestId === loadRequestId.current) setLoading(false) }
  }, [apiBase, sessionToken, demoMode])

  useEffect(() => { void load() }, [load])

  const filteredEvents = events.filter((event) => {
    const query = alertSearch.trim().toLocaleLowerCase()
    const matchesSearch = !query || [event.title, event.message, event.companyName || "", ruleLabel(event.ruleType)].some((value) => value.toLocaleLowerCase().includes(query))
    return matchesSearch
      && (alertStatusFilter === "all" || event.status === alertStatusFilter)
      && (alertTypeFilter === "all" || event.ruleType === alertTypeFilter)
      && (alertSeverityFilter === "all" || event.severity === alertSeverityFilter)
      && (alertCompanyFilter === "all" || String(event.companyId || "") === alertCompanyFilter)
  })
  const hasAlertFilters = Boolean(alertSearch.trim()) || alertStatusFilter !== "all" || alertTypeFilter !== "all" || alertSeverityFilter !== "all" || alertCompanyFilter !== "all"
  function clearAlertFilters() { setAlertSearch(""); setAlertStatusFilter("all"); setAlertTypeFilter("all"); setAlertSeverityFilter("all"); setAlertCompanyFilter("all") }

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

  function beginRuleEdit(rule: AlertRule) {
    setEditingRuleId(rule.ruleId)
    setEditThresholdPercent(rule.thresholdPercent || 15)
    setEditCooldownHours(rule.cooldownHours || 24)
    setEditStaleAfterHours(rule.staleAfterHours || 30)
    setError("")
    setNotice("")
  }

  function cancelRuleEdit() { setEditingRuleId(null) }

  async function saveRuleSettings(rule: AlertRule) {
    if (savingRuleId) return
    setSavingRuleId(rule.ruleId); setError(""); setNotice("")
    const settings = {
      ...(["income_drop", "income_increase", "rating_drop", "roster_change"].includes(rule.ruleType) ? { thresholdPercent: editThresholdPercent } : {}),
      ...(rule.ruleType === "stale_data" ? { staleAfterHours: editStaleAfterHours } : {}),
      cooldownHours: editCooldownHours,
    }
    try {
      await automationFetch(apiBase, sessionToken, `/api/me/alert-rules/${encodeURIComponent(rule.ruleId)}`, { method: "POST", body: JSON.stringify(settings) })
      setEditingRuleId(null)
      setNotice(`${ruleLabel(rule.ruleType)} settings saved.`)
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the alert rule settings.") }
    finally { setSavingRuleId(null) }
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

  async function saveWebhook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!webhookUrl.trim()) return
    setWebhookBusy(true); setError(""); setNotice("")
    try { await automationFetch(apiBase, sessionToken, "/api/me/automation-webhook", { method: "POST", body: JSON.stringify({ url: webhookUrl.trim() }) }); setWebhookUrl(""); setWebhookConfigured(true); setNotice("Encrypted webhook endpoint saved. Future matching alerts will be delivered automatically."); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save the webhook endpoint.") }
    finally { setWebhookBusy(false) }
  }

  async function removeWebhook() {
    if (!window.confirm("Remove the saved webhook endpoint? Existing alert history will remain.")) return
    setWebhookBusy(true); setError(""); setNotice("")
    try { await automationFetch(apiBase, sessionToken, "/api/me/automation-webhook", { method: "DELETE" }); setWebhookConfigured(false); setNotice("Webhook endpoint removed. Existing delivery history is retained."); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not remove the webhook.") }
    finally { setWebhookBusy(false) }
  }

  async function retryWebhook(delivery: WebhookDelivery) {
    setWebhookBusy(true); setError(""); setNotice("")
    try { const result = await automationFetch<{ delivery: { delivered: boolean; detail?: string } }>(apiBase, sessionToken, `/api/me/automation-webhook/retry/${encodeURIComponent(delivery.eventId)}`, { method: "POST" }); setNotice(result.delivery.detail || (result.delivery.delivered ? "Webhook delivered." : "Webhook retry did not succeed.")); await load() }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not retry webhook delivery.") }
    finally { setWebhookBusy(false) }
  }

  function withinQuietHours(prefs: AutomationPreferences) {
    if (!prefs.quietHoursEnabled) return false
    try {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: prefs.timezone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date())
      const hour = Number(parts.find((part) => part.type === "hour")?.value || 0), minute = Number(parts.find((part) => part.type === "minute")?.value || 0)
      const current = hour * 60 + minute, start = Number(prefs.quietHoursStart.slice(0, 2)) * 60 + Number(prefs.quietHoursStart.slice(3)), end = Number(prefs.quietHoursEnd.slice(0, 2)) * 60 + Number(prefs.quietHoursEnd.slice(3))
      return start === end ? true : start < end ? current >= start && current < end : current >= start || current < end
    } catch { return true }
  }

  useEffect(() => {
    if (!preferences.browserNotificationsEnabled || typeof Notification === "undefined" || Notification.permission !== "granted" || withinQuietHours(preferences)) return
    const rank = (value: string) => value === "critical" ? 3 : value === "warning" ? 2 : 1
    for (const event of events) {
      if (event.status !== "unread" || seenEventIds.current.has(event.eventId) || rank(event.severity) < rank(preferences.minimumSeverity)) continue
      seenEventIds.current.add(event.eventId)
      try { new Notification(event.title, { body: event.message, tag: event.eventId }) } catch { /* Browser notification support varies. */ }
    }
  }, [events, preferences])

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
    <section className="panel automation-delivery-settings">
      <div className="panel-heading"><div><h2>Notification delivery & quiet hours</h2><p>In-app alerts are always retained. Browser notifications can respect your local quiet window; optional webhooks send matching alerts to an external HTTPS endpoint.</p></div><span className={webhookConfigured ? "admin-status good" : "admin-status neutral"}>{webhookConfigured ? "Webhook configured" : "In-app only"}</span></div>
      <div className="automation-delivery-grid">
        <div className="automation-webhook-panel"><div className="automation-webhook-heading"><div><h3>HTTPS webhook</h3><p>The destination is encrypted at rest and never shown again after saving. Private/local addresses are rejected.</p></div></div><form className="automation-form" onSubmit={saveWebhook}><label>Webhook URL<input type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://hooks.your-domain.com/alerts" autoComplete="off" /></label><button type="submit" className="primary-button" disabled={webhookBusy || !webhookUrl.trim()}>{webhookBusy ? "Saving…" : webhookConfigured ? "Replace encrypted webhook" : "Save encrypted webhook"}</button></form>{webhookConfigured && <button type="button" className="text-button" disabled={webhookBusy} onClick={() => void removeWebhook()}>Remove webhook endpoint</button>}<p className="field-hint">Payload includes alert title, severity, rule type, company ID, message, and timestamp. Never paste a webhook URL you do not control.</p></div>
      </div>
      <div className="automation-delivery-history"><div className="panel-heading"><div><h3>Webhook delivery history</h3><p>Latest outbound attempts. Failed deliveries can be retried after fixing the endpoint.</p></div><span className="count-chip">{deliveries.length} attempts</span></div>{deliveries.length ? <div className="table-scroll"><table className="admin-table"><thead><tr><th>TIME</th><th>STATUS</th><th>HTTP</th><th>DETAIL</th><th>ACTION</th></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.deliveryId}><td>{prettyDate(delivery.createdAt)}</td><td><span className={`admin-status ${delivery.status === "delivered" ? "good" : "danger"}`}>{delivery.status}</span></td><td>{delivery.statusCode ?? "—"}</td><td>{delivery.detail || "—"}</td><td>{delivery.status === "failed" && <button type="button" className="text-button" disabled={webhookBusy || !webhookConfigured} onClick={() => void retryWebhook(delivery)}>Retry</button>}</td></tr>)}</tbody></table></div> : <div className="empty-state">No webhook delivery attempts yet. Save an HTTPS endpoint to start delivering new alerts.</div>}</div>
    </section>
    <div className="automation-grid">
      <section className="panel automation-rule-builder">
        <div className="panel-heading"><div><h2>Create an alert rule</h2><p>Choose a template. Notifications stay inside your account.</p></div></div>
        <form className="automation-form" onSubmit={createRule}>
          <label>Alert type<select value={ruleType} onChange={(event) => setRuleType(event.target.value as AlertRuleType)}><option value="income_drop">Daily income drop</option><option value="stale_data">Stale company data</option><option value="refresh_failure">Refresh failure</option><option value="income_increase">Daily income increase</option><option value="rating_drop">Company rating drop</option><option value="roster_change">Employee roster change</option></select></label>
          <p className="automation-description">{ruleDescription(ruleType)}</p>
          <label>Company scope<select value={companyId} onChange={(event) => setCompanyId(event.target.value)}><option value="">All connected companies</option>{companies.map((company) => <option key={company.company_id} value={company.company_id}>{company.company_name || `Company #${company.company_id}`}</option>)}</select></label>
          {["income_drop", "income_increase", "rating_drop", "roster_change"].includes(ruleType) && <label>{ruleType === "income_drop" ? "Trigger when income drops by" : ruleType === "income_increase" ? "Trigger when income increases by" : ruleType === "rating_drop" ? "Trigger when rating drops by" : "Trigger when roster changes by"}<select value={thresholdPercent} onChange={(event) => setThresholdPercent(Number(event.target.value))}><option value={5}>5% or more</option><option value={10}>10% or more</option><option value={15}>15% or more</option><option value={20}>20% or more</option><option value={30}>30% or more</option><option value={50}>50% or more</option></select></label>}
          {ruleType === "stale_data" && <label>Mark data stale after<select value={staleAfterHours} onChange={(event) => setStaleAfterHours(Number(event.target.value))}><option value={24}>24 hours</option><option value={30}>30 hours</option><option value={36}>36 hours</option><option value={48}>48 hours</option><option value={72}>72 hours</option></select></label>}
          <label>Repeat alert cooldown<select value={cooldownHours} onChange={(event) => setCooldownHours(Number(event.target.value))}><option value={1}>1 hour</option><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></label>
          <button className="primary-button" type="submit" disabled={saving || loading || !backendAvailable}>{!backendAvailable ? "Backend deployment pending" : saving ? "Saving rule…" : "Create alert rule →"}</button>
        </form>
      </section>
      <section className="panel automation-rules-list">
        <div className="panel-heading"><div><h2>Your rules</h2><p>Pause a rule without deleting its history.</p></div><span className="count-chip">{rules.length} total</span></div>
        {loading && !rules.length ? <div className="empty-state">Loading alert rules…</div> : rules.length ? <div className="automation-rule-list">{rules.map((rule) => {
          const editing = editingRuleId === rule.ruleId
          const savingThisRule = savingRuleId === rule.ruleId
          return <article className="automation-rule-card" key={rule.ruleId}>
            <div className="automation-rule-top"><span className={`automation-rule-icon ${rule.enabled ? "enabled" : "paused"}`}>{rule.enabled ? "●" : "Ⅱ"}</span><div><h3>{ruleLabel(rule.ruleType)}</h3><p>{rule.companyName || (rule.companyId ? `Company #${rule.companyId}` : "All connected companies")}</p></div><span className={`automation-rule-state ${rule.enabled ? "enabled" : "paused"}`}>{rule.enabled ? "Active" : "Paused"}</span></div>
            {!editing ? <p className="automation-rule-detail">{rule.ruleType === "stale_data" ? `Stale after ${rule.staleAfterHours}h · ` : rule.ruleType === "refresh_failure" ? "Refresh failure · " : ["income_drop", "income_increase", "rating_drop", "roster_change"].includes(rule.ruleType) ? `Threshold ${rule.thresholdPercent}% · ` : ""}Cooldown {rule.cooldownHours}h · Last triggered {prettyDate(rule.lastTriggeredAt)}</p> : <div className="automation-rule-editor">
              {["income_drop", "income_increase", "rating_drop", "roster_change"].includes(rule.ruleType) && <label>Trigger threshold<select value={editThresholdPercent} onChange={(event) => setEditThresholdPercent(Number(event.target.value))}><option value={5}>5% or more</option><option value={10}>10% or more</option><option value={15}>15% or more</option><option value={20}>20% or more</option><option value={30}>30% or more</option><option value={50}>50% or more</option></select></label>}
              {rule.ruleType === "stale_data" && <label>Mark data stale after<select value={editStaleAfterHours} onChange={(event) => setEditStaleAfterHours(Number(event.target.value))}><option value={24}>24 hours</option><option value={30}>30 hours</option><option value={36}>36 hours</option><option value={48}>48 hours</option><option value={72}>72 hours</option></select></label>}
              <label>Repeat alert cooldown<select value={editCooldownHours} onChange={(event) => setEditCooldownHours(Number(event.target.value))}><option value={1}>1 hour</option><option value={6}>6 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></label>
            </div>}
            <div className="automation-rule-actions">{editing ? <><button className="primary-button" type="button" disabled={savingThisRule} onClick={() => void saveRuleSettings(rule)}>{savingThisRule ? "Saving…" : "Save settings"}</button><button className="secondary-button" type="button" disabled={savingThisRule} onClick={cancelRuleEdit}>Cancel</button></> : <><button className="secondary-button" type="button" onClick={() => beginRuleEdit(rule)}>Edit settings</button><button className="secondary-button" type="button" onClick={() => void updateRule(rule, !Boolean(rule.enabled))}>{Boolean(rule.enabled) ? "Pause" : "Enable"}</button><button className="text-button" type="button" onClick={() => void deleteRule(rule)}>Delete rule</button></>}</div>
          </article>
        })}</div> : <div className="empty-state">No rules yet. Create one to let the dashboard monitor changes for you.</div>}
      </section>
    </div>
    <section className="panel automation-inbox">
      <div className="panel-heading"><div><h2>Alert inbox</h2><p>Search and narrow recent alerts by company, rule, severity, or acknowledgement.</p></div><span className="count-chip">{unreadCount} unread</span></div>
      <div className="automation-alert-filters">
        <label className="automation-alert-search"><span>Search alerts</span><input type="search" value={alertSearch} onChange={(event) => setAlertSearch(event.target.value)} placeholder="Search title, message, or company…" aria-label="Search alert title, message, or company" /></label>
        <label><span>Company</span><select value={alertCompanyFilter} onChange={(event) => setAlertCompanyFilter(event.target.value)}><option value="all">All companies</option>{companies.filter((company) => events.some((item) => String(item.companyId || "") === company.company_id)).map((company) => <option key={company.company_id} value={company.company_id}>{company.company_name || `Company #${company.company_id}`}</option>)}{events.filter((item) => item.companyId && !companies.some((company) => company.company_id === item.companyId)).map((event) => <option key={event.companyId} value={String(event.companyId)}> {event.companyName || `Company #${event.companyId}`} </option>).filter((option, index, list) => list.findIndex((item) => item.key === option.key) === index)}</select></label>
        <label><span>Status</span><select value={alertStatusFilter} onChange={(event) => setAlertStatusFilter(event.target.value as typeof alertStatusFilter)}><option value="all">All statuses</option><option value="unread">Unread</option><option value="acknowledged">Acknowledged</option></select></label>
        <label><span>Alert type</span><select value={alertTypeFilter} onChange={(event) => setAlertTypeFilter(event.target.value as typeof alertTypeFilter)}><option value="all">All types</option><option value="income_drop">Income drop</option><option value="stale_data">Stale data</option><option value="refresh_failure">Refresh failure</option><option value="income_increase">Daily income increase</option><option value="rating_drop">Company rating drop</option><option value="roster_change">Employee roster change</option></select></label>
        <label><span>Severity</span><select value={alertSeverityFilter} onChange={(event) => setAlertSeverityFilter(event.target.value as typeof alertSeverityFilter)}><option value="all">All severity</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></label>
        <div className="automation-alert-filter-summary"><span>{hasAlertFilters ? `${filteredEvents.length} of ${events.length} alerts` : `${events.length} recent alerts`}</span>{hasAlertFilters && <button className="text-button" type="button" onClick={clearAlertFilters}>Clear filters</button>}</div>
      </div>
      {loading && !events.length ? <div className="empty-state">Loading alerts…</div> : events.length ? filteredEvents.length ? <div className="automation-event-list">{filteredEvents.map((event) => <article className={`automation-event-card ${event.status === "acknowledged" ? "acknowledged" : ""}`} key={event.eventId}><div className={`automation-event-severity ${event.severity}`}>{event.severity === "critical" ? "!" : event.severity === "warning" ? "▲" : "i"}</div><div className="automation-event-content"><div className="automation-event-meta"><span>{ruleLabel(event.ruleType)}</span><span>{prettyDate(event.createdAt)}</span></div><h3>{event.title}</h3><p>{event.message}</p>{event.companyName && <small>{event.companyName}</small>}{event.changePercent != null && <div className="automation-event-values"><span>Previous {Number(event.previousValue ?? 0).toLocaleString()}</span><span>Current {Number(event.currentValue ?? 0).toLocaleString()}</span><strong>{event.changePercent.toFixed(1)}%</strong></div>}{event.sourceSnapshotAt && <small>Snapshot: {prettyDate(event.sourceSnapshotAt)}</small>}</div><div className="automation-event-actions">{event.status === "unread" ? <button className="secondary-button" type="button" onClick={() => void acknowledge(event)}>Acknowledge</button> : <span className="automation-acknowledged">Acknowledged</span>}{event.ruleType === "income_drop" && <button className="text-button" type="button" onClick={onNavigateCharts}>Open trends ↗</button>}</div></article>)}</div> : <div className="empty-state">No alerts match these filters. Try a different search or clear the filters.</div> : <div className="empty-state">No alerts yet. When a rule detects a meaningful change, it will appear here.</div>}
    </section>
  </div>
}


export function NotificationSettingsPanel({ apiBase, sessionToken, demoMode }: { apiBase: string; sessionToken: string; demoMode: boolean }) {
  const [preferences, setPreferences] = useState<AutomationPreferences>(DEFAULT_PREFERENCES)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  useEffect(() => {
    let cancelled = false
    if (!sessionToken || demoMode) { setLoading(false); return }
    setLoading(true); setError("")
    automationFetch<{ preferences: Record<string, unknown> }>(apiBase, sessionToken, "/api/me/automation-preferences")
      .then(({ preferences: raw }) => { if (!cancelled) setPreferences({ browserNotificationsEnabled: Boolean(raw.browserNotificationsEnabled), quietHoursEnabled: Boolean(raw.quietHoursEnabled), quietHoursStart: String(raw.quietHoursStart || "22:00"), quietHoursEnd: String(raw.quietHoursEnd || "08:00"), timezone: String(raw.timezone || "UTC"), minimumSeverity: ["info", "warning", "critical"].includes(String(raw.minimumSeverity)) ? raw.minimumSeverity as AutomationPreferences["minimumSeverity"] : "info", digestMode: raw.digestMode === "daily" ? "daily" : raw.digestMode === "off" ? "off" : "instant" }) })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load notification preferences.") })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [apiBase, sessionToken, demoMode])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("")
    try { await automationFetch(apiBase, sessionToken, "/api/me/automation-preferences", { method: "POST", body: JSON.stringify(preferences) }); setNotice("Notification preferences saved.") }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save notification preferences.") }
    finally { setSaving(false) }
  }

  async function setBrowserEnabled(enabled: boolean) {
    setError(""); setNotice("")
    if (enabled && typeof Notification === "undefined") { setError("This browser does not support desktop notifications."); return }
    if (enabled && Notification.permission !== "granted") {
      if (Notification.permission === "denied") { setError("Browser notifications are blocked for this site. Allow them in your browser site settings, then try again."); return }
      try { const permission = await Notification.requestPermission(); if (permission !== "granted") { setError("Browser notification permission was not granted."); return } }
      catch { setError("Could not request browser notification permission. Check your browser settings and try again."); return }
    }
    setPreferences((current) => ({ ...current, browserNotificationsEnabled: enabled }))
  }

  if (!sessionToken || demoMode) return <section className="panel automation-delivery-settings"><div className="panel-heading"><div><h2>Browser notification settings</h2><p>Choose whether this browser can notify you about company alerts.</p></div></div><div className="empty-state">Sign in to configure browser notifications. Notification preferences are unavailable in demo mode.</div></section>

  return <section className="panel automation-delivery-settings"><div className="panel-heading"><div><h2>Browser notification settings</h2><p>Control browser notifications for alerts about your connected companies. These are personal preferences and are available to every signed-in user.</p></div><span className="count-chip">Personal settings</span></div>
    {loading ? <div className="empty-state">Loading notification preferences…</div> : <form className="automation-form" onSubmit={save}>
      <label className="automation-checkbox-label"><input type="checkbox" checked={preferences.browserNotificationsEnabled} onChange={(event) => void setBrowserEnabled(event.target.checked)} /> Enable company browser notifications</label>
      <label>Minimum notification severity<select value={preferences.minimumSeverity} onChange={(event) => setPreferences((current) => ({ ...current, minimumSeverity: event.target.value as AutomationPreferences["minimumSeverity"] }))}><option value="info">Info and above</option><option value="warning">Warning and critical</option><option value="critical">Critical only</option></select></label>
      <label>Webhook delivery mode<select value={preferences.digestMode} onChange={(event) => setPreferences((current) => ({ ...current, digestMode: event.target.value as AutomationPreferences["digestMode"] }))}><option value="instant">Instant webhook delivery</option><option value="daily">Daily webhook digest</option><option value="off">Webhook delivery off</option></select></label>
      <label className="automation-checkbox-label"><input type="checkbox" checked={preferences.quietHoursEnabled} onChange={(event) => setPreferences((current) => ({ ...current, quietHoursEnabled: event.target.checked }))} /> Respect quiet hours for browser notifications</label>
      <div className="automation-time-row"><label>Quiet hours start<input required type="time" value={preferences.quietHoursStart} onChange={(event) => setPreferences((current) => ({ ...current, quietHoursStart: event.target.value }))} /></label><label>Quiet hours end<input required type="time" value={preferences.quietHoursEnd} onChange={(event) => setPreferences((current) => ({ ...current, quietHoursEnd: event.target.value }))} /></label></div><p className="field-hint">If start and end match, browser notifications are quiet all day. Quiet hours do not hide in-app alerts.</p>
      <label>Time zone<select value={preferences.timezone} onChange={(event) => setPreferences((current) => ({ ...current, timezone: event.target.value }))}><option value="UTC">UTC</option><option value="America/New_York">America/New_York</option><option value="America/Chicago">America/Chicago</option><option value="America/Denver">America/Denver</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="Europe/London">Europe/London</option><option value="Europe/Paris">Europe/Paris</option><option value="Asia/Tokyo">Asia/Tokyo</option><option value="Australia/Sydney">Australia/Sydney</option></select></label>
      <button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving preferences…" : "Save notification preferences"}</button>
    </form>}
    {error && <div className="error-banner" role="alert">{error}</div>}{notice && <div className="automation-notice" role="status">{notice}</div>}
  </section>
}
