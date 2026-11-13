import { useEffect, useState } from "react"
import { filterAndSortWeeklyMembers, type WeeklyLeaderboardDirection, type WeeklyLeaderboardParticipationFilter, type WeeklyLeaderboardSortKey, type WeeklyLeaderboardStatusFilter } from "../../lib/faction-performance/leaderboard"

type SavedCompanySummary = {
  company_id: string
  company_name: string | null
  company_type: string | null
  fetched_at: string
  key_last_four?: string | null
  key_updated_at?: string | null
  has_api_key?: boolean
  uses_portal_key?: boolean
  can_remove_key?: boolean
}

type HalloweenMemberEventWindow = {
  configured: boolean
  startMinuteOfDay: number | null
  startTime: string | null
  startAt: string | null
  endAt: string | null
}

type HalloweenLiveMember = {
  playerId: string
  playerName: string
  eventWindowConfigured: boolean
  startTime: string | null
  eventStartAt: string | null
  eventEndAt: string | null
  currentTreats: number | null
  totalTreats: number | null
  upgradesUnlocked: number | null
  upgrades: unknown[] | null
  capturedAt: string | null
  snapshotKind: string | null
  sourceTimestamp: number | null
  coverage: string
}

type HalloweenLivePayload = {
  event: { eventYear: number; startAt: string; endAt: string; liveCollectionEnabled: number }
  myWindow: HalloweenMemberEventWindow | null
  leaderboard: HalloweenLiveMember[]
  mySnapshot: HalloweenLiveMember | null
}

const halloweenStartTimeOptions = Array.from({ length: 25 }, (_, index) => {
  const totalMinutes = 10 * 60 + index * 15
  return String(Math.floor(totalMinutes / 60)).padStart(2, "0") + ":" + String(totalMinutes % 60).padStart(2, "0")
})

const formatTctDateTime = (value: string) => new Intl.DateTimeFormat(undefined, {
  timeZone: "UTC", dateStyle: "medium", timeStyle: "short", hour12: false,
}).format(new Date(value))

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

type FactionDirectorSummary = {
  playerId: string
  directorName: string
  companyId: string
  companyName: string
  companyType: string | null
  companyTypeId: number | string | null
  starRating: number | null
  dailyIncome: number | null
  weeklyIncome: number | null
  fetchedAt: string
}

type FactionDirectoryPayload = {
  directors: FactionDirectorSummary[]
  weeklyStarCounts: Array<{ starRating: number; companyCount: number }>
  weeklyStarCountsCapturedAt: string
  generatedAt: string
  source: string
}

type FactionDirectorHistory = {
  director: FactionDirectorSummary
  history: Array<{ day: string; dailyIncome: number | null; weeklyIncome: number | null; dailyProfit: number | null; stockQuantity: number | null; stock: unknown }>
  stockHistoryAvailable: boolean
}

type FactionMemberSummary = {
  playerId: string
  playerName: string
  membershipVerifiedAt: string | null
  companyName: string | null
  companyType: string | null
  companyTypeId: number | string | null
}

type FactionWorkspaceProps = Pick<WorkspaceProps, "playerName" | "onNavigate"> & { apiBase: string; sessionToken: string }

type FactionStatsPayload = {
  factionId: string
  generatedAt: string
  snapshot: { runId: string; capturedAt: string; scheduledAt: string; status: string; returnedStatCount: number } | null
  stats: Array<{ name: string; value: number }>
  missingStatNames: string[]
  unexpectedStatNames: string[]
  collection: { lastSuccessAt: string | null; lastRunId: string | null; lastError: string | null; updatedAt: string } | null
}

type FactionWeeklyMetric =
  | "xantaken" | "lsdtaken" | "drugsused" | "overdosed" | "alcoholused" | "boostersused"
  | "energydrinkused" | "refills" | "statenhancersused" | "networth" | "cantaken"
  | "exttaken" | "kettaken" | "opitaken" | "shrtaken" | "spetaken" | "pcptaken" | "victaken"
type FactionWeeklyRankingMetric = FactionWeeklyMetric | "gymEnergy"

type FactionWeeklyMember = {
  userId: string
  name: string
  position: string | null
  level: number | null
  participation: "full_week" | "partial_week" | "unknown"
  status: "complete" | "partial" | "incomplete" | "waiting_for_baseline" | "waiting_for_update" | "anomaly"
  metrics: Record<FactionWeeklyMetric, number | null>
  startingNetworth: number | null
  endingNetworth: number | null
  gymEnergy: number | null
  knownMetricCount: number
  anomalyMetrics: FactionWeeklyRankingMetric[]
  rank: number | null
  baselineCapturedAt: string | null
  endingCapturedAt: string | null
  baselineSnapshotId: number | string | null
  endingSnapshotId: number | string | null
  endingIsBoundary: boolean
  gymEnergyBaselineCapturedAt: string | null
  gymEnergyEndingCapturedAt: string | null
  gymEnergyEndingIsBoundary: boolean
}

type FactionWeeklyHistoryOption = {
  weekStartAt: string
  weekEndAt: string
  status: "complete" | "partial"
  memberCount: number
  completeMemberCount: number
  finalizedAt: string
}
type FactionWeeklyHistoryMember = FactionWeeklyMember & {
  endingIsBoundary: boolean
  comparison: {
    previousValue: number | null
    weeklyChange: number | null
    previousRank: number | null
    rankMovement: number | null
  }
}
type FactionWeeklyHistoryPayload = {
  report: { weekStartAt: string; weekEndAt: string; status: string; memberCount: number; completeMemberCount: number; finalizedAt: string }
  comparedReport: { weekStartAt: string; weekEndAt: string; status: string; finalizedAt: string } | null
  selectedMetric: FactionWeeklyRankingMetric
  members: FactionWeeklyHistoryMember[]
}

type FactionWeeklyPayload = {
  generatedAt: string
  week: { startAt: string; endAt: string; secondsRemaining: number; generatedAt: string }
  boundary: {
    statsStatus: string
    gymEnergyStatus: string
    statsCompletedAt: string | null
    gymEnergyCompletedAt: string | null
    statsCapturedAt: string | null
    gymEnergyCapturedAt: string | null
    statsTimingDeviationSeconds: number | null
    gymEnergyTimingDeviationSeconds: number | null
    statsLate: boolean | null
    gymEnergyLate: boolean | null
  }
  selectedMetric: FactionWeeklyRankingMetric
  summary: Record<FactionWeeklyMetric, { total: number; knownMembers: number }> & { gymEnergy: { total: number; knownMembers: number } }
  completeMembers: number
  totalMembers: number
  members: FactionWeeklyMember[]
}

const factionWeeklyMetricOptions: Array<{ value: FactionWeeklyRankingMetric; label: string }> = [
  { value: "xantaken", label: "Xanax used" },
  { value: "lsdtaken", label: "LSD used" },
  { value: "alcoholused", label: "Alcohol consumed" },
  { value: "boostersused", label: "Boosters used" },
  { value: "energydrinkused", label: "Energy drinks" },
  { value: "refills", label: "Energy refills" },
  { value: "drugsused", label: "Total drugs used" },
  { value: "overdosed", label: "Overdoses" },
  { value: "statenhancersused", label: "Stat enhancers" },
  { value: "networth", label: "Networth change" },
  { value: "cantaken", label: "Cannabis" },
  { value: "exttaken", label: "Ecstasy" },
  { value: "kettaken", label: "Ketamine" },
  { value: "opitaken", label: "Opium" },
  { value: "shrtaken", label: "Shrooms" },
  { value: "spetaken", label: "Speed" },
  { value: "pcptaken", label: "PCP" },
  { value: "victaken", label: "Vicodin" },
  { value: "gymEnergy", label: "Gym energy" },
]

export function FactionWorkspacePlaceholder(props: FactionWorkspaceProps) {
  const [tab, setTab] = useState<"weekly" | "live" | "activity" | "stats" | "directory">("weekly")
  return (
    <div className="faction-workspace-switcher">
      <nav className="faction-workspace-tabs" aria-label="Faction dashboard sections">
        <button type="button" className={tab === "weekly" ? "active" : ""} onClick={() => setTab("weekly")}>Weekly rankings</button>
        <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>Live member status</button>
        <button type="button" className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Faction activity</button>
        <button type="button" className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>Faction totals</button>
        <button type="button" className={tab === "directory" ? "active" : ""} onClick={() => setTab("directory")}>Company directory</button>
      </nav>
      {tab === "weekly" ? <FactionWeeklyRankings {...props} /> : tab === "live" ? <FactionLiveStatus {...props} /> : tab === "activity" ? <FactionActivityFeed {...props} /> : tab === "stats" ? <FactionStatsOverview {...props} /> : <FactionCompanyDirectory {...props} />}
    </div>
  )
}

const factionStatsLabels: Record<string, string> = {
  "medicalitemsused": "Medical items used",
  "criminaloffences": "Criminal offences",
  "organisedcrimerespect": "Organised crime respect",
  "organisedcrimemoney": "Organised crime money",
  "organisedcrimesuccess": "Organised crimes succeeded",
  "organisedcrimefail": "Organised crimes failed",
  "attackswon": "Attacks won",
  "attackslost": "Attacks lost",
  "attackschain": "Attacks in chains",
  "attacksleave": "Attacks left",
  "attacksmug": "Attacks mugged",
  "attackshosp": "Attacks hospitalized",
  "bestchain": "Best chain",
  "busts": "Busts",
  "revives": "Revives",
  "jails": "Times jailed",
  "hosps": "Times hospitalized",
  "medicalitemrecovery": "Medical item recovery",
  "medicalcooldownused": "Medical cooldown used",
  "gymtrains": "Gym trains",
  "gymstrength": "Strength gained",
  "gymspeed": "Speed gained",
  "gymenergy": "Gym energy",
  "gymdefense": "Defense gained",
  "gymdexterity": "Dexterity gained",
  "candyused": "Candy used",
  "alcoholused": "Alcohol consumed",
  "energydrinkused": "Energy drinks used",
  "drugsused": "Drugs used",
  "drugoverdoses": "Drug overdoses",
  "rehabs": "Rehabs",
  "caymaninterest": "Cayman interest",
  "traveltimes": "Travel trips",
  "traveltime": "Time spent travelling",
  "hunting": "Hunting",
  "attacksdamagehits": "Attack damage hits",
  "attacksdamage": "Attack damage",
  "hosptimegiven": "Hospital time given",
  "hosptimereceived": "Hospital time received",
  "attacksdamaging": "Damaging attacks",
  "attacksrunaway": "Attacks escaped",
  "highestterritories": "Highest territories held",
  "territoryrespect": "Territory respect"
}
const factionStatsGroups = [
  {
    "title": "Combat & territory",
    "names": [
      "attackswon",
      "attackslost",
      "attackschain",
      "attacksleave",
      "attacksmug",
      "attackshosp",
      "bestchain",
      "attacksdamagehits",
      "attacksdamage",
      "attacksdamaging",
      "attacksrunaway",
      "highestterritories",
      "territoryrespect"
    ]
  },
  {
    "title": "Crime & medical",
    "names": [
      "criminaloffences",
      "organisedcrimerespect",
      "organisedcrimemoney",
      "organisedcrimesuccess",
      "organisedcrimefail",
      "busts",
      "jails",
      "hosps",
      "revives",
      "medicalitemsused",
      "medicalitemrecovery",
      "medicalcooldownused",
      "rehabs",
      "drugoverdoses"
    ]
  },
  {
    "title": "Training & consumables",
    "names": [
      "gymtrains",
      "gymstrength",
      "gymspeed",
      "gymdefense",
      "gymdexterity",
      "gymenergy",
      "candyused",
      "alcoholused",
      "energydrinkused",
      "drugsused"
    ]
  },
  {
    "title": "Travel & other",
    "names": [
      "caymaninterest",
      "traveltimes",
      "traveltime",
      "hunting",
      "hosptimegiven",
      "hosptimereceived"
    ]
  }
]

function FactionStatsOverview({ onNavigate, apiBase, sessionToken }: FactionWorkspaceProps) {
  const [payload, setPayload] = useState<FactionStatsPayload | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")

  const load = async () => {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(apiBase + "/api/faction/stats", {
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const result = await response.json() as { error?: string } & Partial<FactionStatsPayload>
      if (!response.ok) throw new Error(result.error || "Could not load faction-wide totals.")
      if (!Array.isArray(result.stats) || !Array.isArray(result.missingStatNames) || !Array.isArray(result.unexpectedStatNames)) {
        throw new Error("The faction stats response is incomplete.")
      }
      setPayload(result as FactionStatsPayload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load faction-wide totals.")
      setPayload(null)
    } finally { setBusy(false) }
  }

  useEffect(() => { void load() }, [apiBase, sessionToken])

  const values = new Map((payload?.stats ?? []).map(stat => [stat.name, stat.value]))
  // Older snapshots treated membersamount as a missing field; it is not a Torn /faction/stats counter.
  const missingStatNames = (payload?.missingStatNames ?? []).filter(name => name !== "membersamount")
  const number = (value: number | undefined) => value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
  const capturedAt = payload?.snapshot?.capturedAt
    ? new Intl.DateTimeFormat(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(payload.snapshot.capturedAt)) + " UTC"
    : "Awaiting first successful capture"

  return (
    <main className="module-page faction-module faction-stats-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>FACTION WORKSPACE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> NAUGHTY SOULS · FACTION INTELLIGENCE</div><h1>Faction <em>Lifetime Totals</em></h1><p>Faction-wide counters returned by Torn's /faction/stats endpoint. These aggregate totals are separate from individual members' personal statistics and weekly rankings.</p></section>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      <section className="faction-stats-toolbar">
        <div><small>FACTION STATS SNAPSHOT</small><strong>{capturedAt}</strong><span>{payload?.snapshot ? payload.snapshot.returnedStatCount + " recognized counters captured" : "No saved snapshot yet"}{missingStatNames.length ? " · " + missingStatNames.length + " fields not returned" : ""}</span></div>
        <button type="button" onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh ↻"}</button>
      </section>
      {busy && !payload ? <p className="historical-key-muted">Loading the latest faction-wide totals…</p> : payload?.snapshot ? (
        <>
          {factionStatsGroups.map(group => (
            <section className="halloween-panel faction-stats-group" key={group.title}>
              <div className="faction-directory-heading"><div><div className="halloween-status"><i /> FACTION AGGREGATES</div><h2>{group.title}</h2><p>Latest successful capture. A dash means Torn did not return that field.</p></div></div>
              <div className="faction-stats-grid">
                {group.names.map(name => <article key={name}><small>{factionStatsLabels[name] || name}</small><strong>{number(values.get(name))}</strong></article>)}
              </div>
            </section>
          ))}
          {(missingStatNames.length > 0 || payload.unexpectedStatNames.length > 0) && (
            <section className="historical-empty faction-stats-schema-note">
              <strong>API field coverage</strong>
              <span>{missingStatNames.length ? "Not included in this capture: " + missingStatNames.join(", ") + ". " : ""}{payload.unexpectedStatNames.length ? "New, unrecognized Torn fields: " + payload.unexpectedStatNames.join(", ") + "." : ""}</span>
            </section>
          )}
        </>
      ) : (
        <section className="historical-empty"><strong>No faction totals have been captured yet.</strong><span>The scheduled faction collector saves a timestamped snapshot every 15 minutes. Totals will appear after its first successful run.</span></section>
      )}
      <footer className="module-footer"><span>NAUGHTY FAMILY · FACTION TOTALS</span><span>{payload?.generatedAt ? "Read " + new Date(payload.generatedAt).toLocaleTimeString() : "Collection status unavailable"}</span></footer>
    </main>
  )
}

function FactionWeeklyRankings({ playerName, onNavigate, apiBase, sessionToken }: FactionWorkspaceProps) {
  const [payload, setPayload] = useState<FactionWeeklyPayload | null>(null)
  const [metric, setMetric] = useState<FactionWeeklyRankingMetric>("xantaken")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [historyWeeks, setHistoryWeeks] = useState<FactionWeeklyHistoryOption[]>([])
  const [historyWeekStart, setHistoryWeekStart] = useState("")
  const [compareWeekStart, setCompareWeekStart] = useState("")
  const [historyPayload, setHistoryPayload] = useState<FactionWeeklyHistoryPayload | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState("")
  const [statusFilter, setStatusFilter] = useState<WeeklyLeaderboardStatusFilter>("all")
  const [participationFilter, setParticipationFilter] = useState<WeeklyLeaderboardParticipationFilter>("all")
  const [anomaliesOnly, setAnomaliesOnly] = useState(false)
  const [sortBy, setSortBy] = useState<WeeklyLeaderboardSortKey>("rank")
  const [sortDirection, setSortDirection] = useState<WeeklyLeaderboardDirection>("asc")
  const [selectedMember, setSelectedMember] = useState<{
    member: FactionWeeklyMember | FactionWeeklyHistoryMember
    weekStartAt: string
    weekEndAt: string
    archived: boolean
  } | null>(null)

  const load = async () => {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(apiBase + "/api/faction/weekly-rankings?metric=" + encodeURIComponent(metric), {
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const result = await response.json() as { error?: string } & Partial<FactionWeeklyPayload>
      if (!response.ok) throw new Error(result.error || "Could not load faction weekly rankings.")
      if (!result.week || !Array.isArray(result.members) || !result.summary) throw new Error("The weekly ranking response is incomplete.")
      setPayload(result as FactionWeeklyPayload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load faction weekly rankings.")
      setPayload(null)
    } finally { setBusy(false) }
  }

  const loadHistoryWeeks = async () => {
    try {
      const response = await fetch(apiBase + "/api/faction/weekly-history", {
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const result = await response.json() as { error?: string; reports?: FactionWeeklyHistoryOption[] }
      if (!response.ok || !Array.isArray(result.reports)) throw new Error(result.error || "Could not load completed weekly reports.")
      setHistoryWeeks(result.reports)
      setHistoryWeekStart(current => current || result.reports?.[0]?.weekStartAt || "")
      setCompareWeekStart(current => current || result.reports?.[1]?.weekStartAt || "")
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "Could not load completed weekly reports.")
    }
  }

  const loadHistoryComparison = async () => {
    if (!historyWeekStart) return
    setHistoryBusy(true)
    setHistoryError("")
    try {
      const query = new URLSearchParams({ weekStart: historyWeekStart, metric })
      if (compareWeekStart && compareWeekStart < historyWeekStart) query.set("compareTo", compareWeekStart)
      const response = await fetch(apiBase + "/api/faction/weekly-history?" + query.toString(), {
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const result = await response.json() as { error?: string } & Partial<FactionWeeklyHistoryPayload>
      if (!response.ok || !result.report || !Array.isArray(result.members)) {
        throw new Error(result.error || "Could not load that completed weekly report.")
      }
      setHistoryPayload(result as FactionWeeklyHistoryPayload)
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : "Could not load completed weekly comparison.")
      setHistoryPayload(null)
    } finally { setHistoryBusy(false) }
  }

  useEffect(() => { void load() }, [apiBase, sessionToken, metric])
  useEffect(() => { void loadHistoryWeeks() }, [apiBase, sessionToken])

  const filtered = filterAndSortWeeklyMembers(payload?.members || [], {
    search,
    status: statusFilter,
    participation: participationFilter,
    anomaliesOnly,
    sortBy,
    direction: sortDirection,
    selectedMetric: metric,
  })
  const formatNumber = (value: number | null, selected: FactionWeeklyRankingMetric = metric) => {
    if (value === null || !Number.isFinite(value)) return "—"
    if (selected === "networth") return (value < 0 ? "−$" : "$") + Math.round(Math.abs(value)).toLocaleString()
    return Math.round(value).toLocaleString()
  }
  const formatUtc = (value: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value)) + " UTC"
  const remaining = (seconds: number) => {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return days ? days + "d " + hours + "h remaining" : hours + "h " + minutes + "m remaining"
  }
  const statusLabel = (value: FactionWeeklyMember["status"]) => ({
    complete: "Complete", partial: "Partial data", incomplete: "Incomplete",
    waiting_for_baseline: "Waiting for Sunday baseline", waiting_for_update: "Waiting for next sample", anomaly: "Counter anomaly",
  })[value]
  const metricValue = (member: FactionWeeklyMember, key: FactionWeeklyRankingMetric) => key === "gymEnergy" ? member.gymEnergy : member.metrics[key]
  const metricTotal = (key: FactionWeeklyMetric) => {
    const aggregate = payload?.summary[key]
    return !aggregate || aggregate.knownMembers === 0 ? "—" : formatNumber(aggregate.total, key)
  }
  const gymKnownMembers = payload?.summary.gymEnergy.knownMembers ?? 0
  const gymEnergyTotal = gymKnownMembers
    ? formatNumber(payload?.summary.gymEnergy.total ?? 0, "drugsused")
    : "—"
  const timingLabel = (capturedAt: string | null | undefined, deviation: number | null | undefined, late: boolean | null | undefined) => {
    if (!capturedAt) return "Awaiting first sample"
    if (deviation === null || deviation === undefined) return formatUtc(capturedAt)
    const minutes = Math.max(0, Math.ceil(deviation / 60))
    return formatUtc(capturedAt) + (late ? " · late by " + minutes + "m" : " · within 5m")
  }
  const metricsStatus = payload?.boundary.statsStatus || "not_scheduled"
  const gymStatus = payload?.boundary.gymEnergyStatus || "not_scheduled"
  const setSort = (key: WeeklyLeaderboardSortKey) => {
    if (sortBy === key) setSortDirection(current => current === "asc" ? "desc" : "asc")
    else {
      setSortBy(key)
      setSortDirection(key === "rank" || key === "name" || key === "position" ? "asc" : "desc")
    }
  }
  const sortHeader = (label: string, key: WeeklyLeaderboardSortKey) => (
    <th aria-sort={sortBy === key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="faction-weekly-sort-button" onClick={() => setSort(key)} aria-label={"Sort by " + label}>
        {label}<span aria-hidden="true">{sortBy === key ? (sortDirection === "asc" ? " ↑" : " ↓") : " ↕"}</span>
      </button>
    </th>
  )

  return (
    <main className="module-page faction-module faction-weekly-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>FACTION WORKSPACE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> NAUGHTY SOULS · WEEKLY PERFORMANCE</div><h1>Faction <em>Weekly Rankings</em></h1><p>Lifetime counters are compared with this week's Sunday 00:00 UTC baseline. Xanax and LSD remain independent rankings. Missing or anomalous samples are never treated as zero.</p></section>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      <section className="faction-weekly-toolbar">
        <div><small>REPORTING WINDOW · TCT / UTC</small><strong>{payload ? formatUtc(payload.week.startAt) + " – " + formatUtc(payload.week.endAt) : "Sunday 00:00 UTC – following Sunday 00:00 UTC"}</strong><span>{payload ? remaining(payload.week.secondsRemaining) : "Exact 168-hour reporting week"}</span></div>
        <div className="faction-weekly-controls">
          <label>Rank by<select value={metric} onChange={event => setMetric(event.target.value as FactionWeeklyRankingMetric)}>{factionWeeklyMetricOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <button type="button" onClick={() => void load()} disabled={busy}>{busy ? "Loading…" : "Refresh ↻"}</button>
        </div>
      </section>
      <section className="faction-weekly-boundary-status">
        <span>Sunday stats baseline: <strong>{metricsStatus.replace(/_/g, " ")}</strong></span>
        <span>First stats capture: <strong>{timingLabel(payload?.boundary.statsCapturedAt, payload?.boundary.statsTimingDeviationSeconds, payload?.boundary.statsLate)}</strong></span>
        <span>Gym-energy baseline: <strong>{gymStatus.replace(/_/g, " ")}</strong></span>
        <span>First gym capture: <strong>{timingLabel(payload?.boundary.gymEnergyCapturedAt, payload?.boundary.gymEnergyTimingDeviationSeconds, payload?.boundary.gymEnergyLate)}</strong></span>
        <span>Updated: <strong>{payload ? formatUtc(payload.generatedAt) : "—"}</strong></span>
      </section>
      <section className="faction-weekly-summary">
        <article><small>FACTION MEMBERS</small><strong>{payload?.totalMembers ?? "—"}</strong><span>Current membership intervals</span></article>
        <article><small>COMPLETE WEEKLY DATA</small><strong>{payload?.completeMembers ?? "—"}</strong><span>All 18 public counters available</span></article>
        <article><small>KNOWN XANAX THIS WEEK</small><strong>{metricTotal("xantaken")}</strong><span>{payload?.summary.xantaken.knownMembers ?? 0} members with known deltas</span></article>
        <article><small>KNOWN LSD THIS WEEK</small><strong>{metricTotal("lsdtaken")}</strong><span>{payload?.summary.lsdtaken.knownMembers ?? 0} members with known deltas</span></article>
        <article><small>KNOWN ALCOHOL THIS WEEK</small><strong>{metricTotal("alcoholused")}</strong><span>{payload?.summary.alcoholused.knownMembers ?? 0} members with known deltas</span></article>
        <article><small>KNOWN BOOSTERS THIS WEEK</small><strong>{metricTotal("boostersused")}</strong><span>{payload?.summary.boostersused.knownMembers ?? 0} members with known deltas</span></article>
        <article><small>KNOWN ENERGY DRINKS THIS WEEK</small><strong>{metricTotal("energydrinkused")}</strong><span>{payload?.summary.energydrinkused.knownMembers ?? 0} members with known deltas</span></article>
        <article><small>KNOWN GYM ENERGY THIS WEEK</small><strong>{gymEnergyTotal}</strong><span>{gymKnownMembers} members with known deltas</span></article>
      </section>
      <section className="halloween-panel faction-weekly-ranking-panel">
        <div className="faction-directory-heading"><div><div className="halloween-status"><i /> LIVE WEEKLY LEADERBOARD</div><h2>{factionWeeklyMetricOptions.find(option => option.value === metric)?.label || "Weekly activity"}</h2><p>Sorted by weekly change, not lifetime totals. Members without a valid baseline or ending sample remain unranked.</p></div><input aria-label="Search faction members" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search member or Torn ID…" /></div>
        <div className="faction-weekly-filter-controls">
          <label>Data status<select value={statusFilter} onChange={event => setStatusFilter(event.target.value as WeeklyLeaderboardStatusFilter)}>
            <option value="all">All data states</option><option value="complete">Complete</option><option value="partial">Partial</option><option value="incomplete">Incomplete</option><option value="waiting_for_baseline">Waiting for baseline</option><option value="waiting_for_update">Waiting for update</option><option value="anomaly">Counter anomaly</option>
          </select></label>
          <label>Participation<select value={participationFilter} onChange={event => setParticipationFilter(event.target.value as WeeklyLeaderboardParticipationFilter)}>
            <option value="all">All participation</option><option value="full_week">Full week</option><option value="partial_week">Partial week</option><option value="unknown">Unknown</option>
          </select></label>
          <label className="faction-weekly-anomaly-toggle"><input type="checkbox" checked={anomaliesOnly} onChange={event => setAnomaliesOnly(event.target.checked)} /><span>Only members with counter anomalies</span></label>
          <button type="button" onClick={() => { setSearch(""); setStatusFilter("all"); setParticipationFilter("all"); setAnomaliesOnly(false) }}>Clear filters</button>
          <span className="faction-weekly-result-count">{filtered.length} of {payload?.members.length ?? 0} members</span>
        </div>
        {busy && !payload ? <p className="historical-key-muted">Loading weekly snapshots…</p> : filtered.length ? (
          <div className="historical-leaderboard">
            <table><thead><tr>{sortHeader("RANK", "rank")}{sortHeader("MEMBER", "name")}{sortHeader("POSITION", "position")}{sortHeader("SELECTED METRIC", "selectedMetric")}{sortHeader("XANAX", "xantaken")}{sortHeader("LSD", "lsdtaken")}{sortHeader("ALCOHOL", "alcoholused")}{sortHeader("BOOSTERS", "boostersused")}{sortHeader("ENERGY DRINKS", "energydrinkused")}{sortHeader("REFILLS", "refills")}{sortHeader("GYM ENERGY", "gymEnergy")}{sortHeader("STARTING NETWORTH", "startingNetworth")}{sortHeader("CURRENT NETWORTH", "endingNetworth")}{sortHeader("NETWORTH CHANGE", "networth")}{sortHeader("DATA", "completeness")}</tr></thead><tbody>
              {filtered.map(member => <tr key={member.userId}>
                <td>{member.rank === null ? "—" : "#" + member.rank}</td>
                <td><button type="button" className="faction-weekly-member-link" onClick={() => setSelectedMember({ member, weekStartAt: payload?.week.startAt || "", weekEndAt: payload?.week.endAt || "", archived: false })} aria-expanded={selectedMember?.member.userId === member.userId}>{member.name}</button><small>#{member.userId}</small></td>
                <td>{member.position || "—"}</td>
                <td><strong>{formatNumber(metricValue(member, metric), metric)}</strong></td>
                <td>{formatNumber(member.metrics.xantaken)}</td>
                <td>{formatNumber(member.metrics.lsdtaken)}</td>
                <td>{formatNumber(member.metrics.alcoholused)}</td>
                <td>{formatNumber(member.metrics.boostersused)}</td>
                <td>{formatNumber(member.metrics.energydrinkused)}</td>
                <td>{formatNumber(member.metrics.refills)}</td>
                <td>{formatNumber(member.gymEnergy, "drugsused")}</td>
                <td>{formatNumber(member.startingNetworth, "networth")}</td>
                <td>{formatNumber(member.endingNetworth, "networth")}</td>
                <td>{formatNumber(member.metrics.networth, "networth")}</td>
                <td>
                  <span className={"coverage-pill " + (member.status === "complete" ? "complete" : member.status === "anomaly" || member.status === "incomplete" ? "partial" : "collecting")}>{statusLabel(member.status)}</span>
                  <small>{member.participation.replace(/_/g, " ")}</small>
                  <small>{member.baselineCapturedAt ? "Base " + formatUtc(member.baselineCapturedAt) : "No baseline sample"}</small>
                  <small>{member.endingCapturedAt ? "End " + formatUtc(member.endingCapturedAt) : "No ending sample"}</small>
                  {member.anomalyMetrics.length > 0 && <small className="faction-weekly-anomaly">Decreased: {member.anomalyMetrics.join(", ")}</small>}
                </td>
              </tr>)}
            </tbody></table>
          </div>
        ) : <div className="historical-empty"><strong>{payload?.members.length ? "No members match that search." : "Weekly baseline is being prepared."}</strong><span>{payload?.members.length ? "Try another name or Torn ID." : "The five-minute scheduler creates a dedicated Sunday snapshot. Until the baseline and a later sample are available, weekly values remain unknown."}</span></div>}
      </section>
      {selectedMember && (() => {
        const member = selectedMember.member
        const archivedComparison = "comparison" in member ? member.comparison : null
        return (
          <section className="faction-weekly-member-detail" aria-label={"Weekly profile for " + member.name}>
            <div className="faction-weekly-member-detail-heading">
              <div><small>{selectedMember.archived ? "ARCHIVED WEEKLY PROFILE" : "CURRENT WEEKLY PROFILE"}</small><h3>{member.name}</h3><span>#{member.userId} · {member.position || "Position unavailable"} · Level {member.level ?? "—"}</span></div>
              <button type="button" onClick={() => setSelectedMember(null)}>Close profile ×</button>
            </div>
            <div className="faction-weekly-member-meta">
              <article><small>REPORTING WINDOW</small><strong>{formatUtc(selectedMember.weekStartAt)} – {formatUtc(selectedMember.weekEndAt)}</strong></article>
              <article><small>DATA STATUS</small><strong>{statusLabel(member.status)}</strong></article>
              <article><small>PARTICIPATION</small><strong>{member.participation.replace(/_/g, " ")}</strong></article>
              <article><small>KNOWN COUNTERS</small><strong>{member.knownMetricCount} / 18</strong></article>
              <article><small>STARTING NETWORTH</small><strong>{formatNumber(member.startingNetworth, "networth")}</strong></article>
              <article><small>ENDING NETWORTH</small><strong>{formatNumber(member.endingNetworth, "networth")}</strong></article>
            </div>
            <div className="faction-weekly-member-capture">
              <span>Stats baseline: <strong>{member.baselineCapturedAt ? formatUtc(member.baselineCapturedAt) : "Unavailable"}</strong></span>
              <span>Stats ending sample: <strong>{member.endingCapturedAt ? formatUtc(member.endingCapturedAt) : "Unavailable"}</strong></span>
              <span>Gym baseline: <strong>{member.gymEnergyBaselineCapturedAt ? formatUtc(member.gymEnergyBaselineCapturedAt) : "Unavailable"}</strong></span>
              <span>Gym ending sample: <strong>{member.gymEnergyEndingCapturedAt ? formatUtc(member.gymEnergyEndingCapturedAt) : "Unavailable"}</strong></span>
              <span>Ending source: <strong>{member.endingIsBoundary ? "Sunday boundary capture" : "Latest in-week capture"}</strong></span>
            </div>
            {member.anomalyMetrics.length > 0 && <p className="faction-weekly-profile-anomaly">Counter decreases flagged: {member.anomalyMetrics.join(", ")}. These values are excluded from positive-use rankings.</p>}
            <div className="faction-weekly-member-metrics">
              {factionWeeklyMetricOptions.map(option => <article key={option.value}><small>{option.label} · WEEKLY</small><strong>{formatNumber(metricValue(member, option.value), option.value)}</strong></article>)}
            </div>
            {archivedComparison && <div className="faction-weekly-profile-comparison"><span>Previous period value: <strong>{formatNumber(archivedComparison.previousValue)}</strong></span><span>Week-over-week change: <strong>{formatNumber(archivedComparison.weeklyChange)}</strong></span><span>Previous rank: <strong>{archivedComparison.previousRank === null ? "—" : "#" + archivedComparison.previousRank}</strong></span><span>Rank movement: <strong>{archivedComparison.rankMovement === null ? "—" : archivedComparison.rankMovement > 0 ? "↑ " + archivedComparison.rankMovement : archivedComparison.rankMovement < 0 ? "↓ " + Math.abs(archivedComparison.rankMovement) : "No change"}</strong></span></div>}
            <p className="faction-weekly-profile-note">These are weekly changes derived from public faction snapshots, not lifetime counter totals. Missing data remains unavailable rather than zero. No private bars or cooldown data is included.</p>
          </section>
        )
      })()}
      <section className="halloween-panel faction-weekly-history-panel">
        <div className="faction-directory-heading">
          <div>
            <div className="halloween-status"><i /> ARCHIVED WEEKLY REPORTS</div>
            <h2>History &amp; week-to-week comparison</h2>
            <p>Completed reports are immutable snapshots. Compare a member's weekly activity and ranking against an earlier Sunday-to-Sunday period.</p>
          </div>
        </div>
        {historyError && <p className="settings-feedback error" role="alert">{historyError}</p>}
        {historyWeeks.length ? (
          <>
            <div className="faction-weekly-history-controls">
              <label>Completed week
                <select value={historyWeekStart} onChange={event => {
                  const selected = event.target.value
                  setHistoryWeekStart(selected)
                  if (compareWeekStart && compareWeekStart >= selected) {
                    setCompareWeekStart(historyWeeks.find(report => report.weekStartAt < selected)?.weekStartAt || "")
                  }
                }}>
                  {historyWeeks.map(report => <option key={report.weekStartAt} value={report.weekStartAt}>{formatUtc(report.weekStartAt)} · {report.status}</option>)}
                </select>
              </label>
              <label>Compare against
                <select value={compareWeekStart} onChange={event => setCompareWeekStart(event.target.value)}>
                  <option value="">No comparison</option>
                  {historyWeeks.filter(report => report.weekStartAt < historyWeekStart).map(report =>
                    <option key={report.weekStartAt} value={report.weekStartAt}>{formatUtc(report.weekStartAt)} · {report.status}</option>
                  )}
                </select>
              </label>
              <button type="button" onClick={() => void loadHistoryComparison()} disabled={historyBusy || !historyWeekStart}>
                {historyBusy ? "Loading…" : "Load report ↗"}
              </button>
            </div>
            {historyPayload ? (
              <>
                <div className="faction-weekly-history-meta">
                  <span>REPORT STATUS <strong>{historyPayload.report.status}</strong></span>
                  <span>MEMBERS <strong>{historyPayload.report.completeMemberCount}/{historyPayload.report.memberCount} complete</strong></span>
                  <span>FINALIZED <strong>{formatUtc(historyPayload.report.finalizedAt)}</strong></span>
                  {historyPayload.comparedReport && <span>COMPARISON <strong>{formatUtc(historyPayload.comparedReport.weekStartAt)}</strong></span>}
                </div>
                <div className="historical-leaderboard">
                  <table>
                    <thead><tr><th>RANK</th><th>MEMBER</th><th>WEEKLY VALUE</th><th>PREVIOUS WEEK</th><th>WEEK CHANGE</th><th>PREVIOUS RANK</th><th>RANK MOVEMENT</th><th>DATA</th></tr></thead>
                    <tbody>
                      {historyPayload.members.map(member => {
                        const value = metricValue(member, metric)
                        const movement = member.comparison.rankMovement
                        return <tr key={member.userId}>
                          <td>{member.rank === null ? "—" : "#" + member.rank}</td>
                          <td><button type="button" className="faction-weekly-member-link" onClick={() => setSelectedMember({ member, weekStartAt: historyPayload.report.weekStartAt, weekEndAt: historyPayload.report.weekEndAt, archived: true })} aria-expanded={selectedMember?.member.userId === member.userId}>{member.name}</button><small>#{member.userId}</small></td>
                          <td>{formatNumber(value, metric)}</td>
                          <td>{formatNumber(member.comparison.previousValue, metric)}</td>
                          <td>{formatNumber(member.comparison.weeklyChange, metric)}</td>
                          <td>{member.comparison.previousRank === null ? "—" : "#" + member.comparison.previousRank}</td>
                          <td>{movement === null ? "—" : movement > 0 ? "↑ " + movement : movement < 0 ? "↓ " + Math.abs(movement) : "—"}</td>
                          <td><span className={"coverage-pill " + (member.status === "complete" ? "complete" : member.status === "anomaly" || member.status === "incomplete" ? "partial" : "collecting")}>{statusLabel(member.status)}</span><small>{member.participation.replace(/_/g, " ")}</small></td>
                        </tr>
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <div className="historical-empty"><strong>No report loaded yet.</strong><span>Choose a completed week and optionally an earlier week, then load the comparison.</span></div>}
          </>
        ) : <div className="historical-empty"><strong>No completed weekly reports yet.</strong><span>The first archived report is created after the following Sunday boundary collections finish. The current week remains provisional until then.</span></div>}
      </section>
      <footer className="module-footer"><span>FACTION WEEKLY RANKINGS</span><span>Signed in as {playerName} · Public faction-key snapshots only</span></footer>
    </main>
  )
}

type FactionLiveMember = {
  userId: string
  name: string
  position: string | null
  level: number | null
  daysInFaction: number | null
  rosterCapturedAt: string
  lastActionStatus: string | null
  lastActionTimestamp: number | null
  lastActionRelative: string | null
  statusDescription: string | null
  statusDetails: string | null
  statusState: string | null
  statusUntil: string | null
  statusColor: string | null
  isRevivable: boolean | null
  reviveSetting: string | null
  isOnWall: boolean | null
  isInOc: boolean | null
  hasEarlyDischarge: boolean | null
  privateLive: {
    capturedAt: string
    bars: Record<"energy" | "nerve" | "happy" | "life", { current: number | null; maximum: number | null }>
    cooldowns: { drug: number | null; booster: number | null; medical: number | null }
    networth: Record<string, number> | null
    sourceTimestamps: { capturedAt?: string; networthSourceTimestamp?: number | null } | null
  } | null
}

type FactionLivePayload = {
  generatedAt: string
  roster: { runId: string; capturedAt: string; scheduledAt: string; memberCount: number } | null
  collection: Array<{ collectionKind: string; lastSuccessAt: string | null; lastError: string | null }>
  members: FactionLiveMember[]
}

type FactionLiveFilter = "all" | "online" | "idle" | "offline" | "inactive24" | "inactive72" | "hospital" | "wall" | "oc" | "revivable" | "reviveEveryone" | "reviveFriendsFaction" | "reviveNoOne" | "reviveUnknown" | "unknown"

function formatPrivateLiveBar(value: { current: number | null; maximum: number | null } | undefined): string {
  if (!value || value.current === null && value.maximum === null) return "Unknown"
  return (value.current === null ? "—" : Math.round(value.current).toLocaleString()) +
    " / " + (value.maximum === null ? "—" : Math.round(value.maximum).toLocaleString())
}

function formatPrivateLiveSourceTime(timestampSeconds: number | null | undefined): string {
  if (timestampSeconds === null || timestampSeconds === undefined || !Number.isFinite(timestampSeconds)) return "Source time unavailable"
  const date = new Date(timestampSeconds * 1000)
  if (!Number.isFinite(date.getTime())) return "Source time unavailable"
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date) + " UTC"
}

function formatPrivateLiveCooldown(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "Unknown"
  if (seconds <= 0) return "Ready"
  const total = Math.ceil(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days) return days + "d " + hours + "h"
  if (hours) return hours + "h " + minutes + "m"
  if (minutes) return minutes + "m"
  return total + "s"
}

function liveLastActionMs(member: FactionLiveMember): number | null {
  return typeof member.lastActionTimestamp === "number" && Number.isFinite(member.lastActionTimestamp)
    ? member.lastActionTimestamp * 1000
    : null
}

function liveActivityState(member: FactionLiveMember): "online" | "idle" | "offline" | "unknown" {
  const value = (member.lastActionStatus || "").trim().toLowerCase()
  if (value.includes("online")) return "online"
  if (value.includes("idle")) return "idle"
  if (value.includes("offline")) return "offline"
  return "unknown"
}

function liveIsHospitalized(member: FactionLiveMember): boolean {
  return [member.statusDescription, member.statusDetails, member.statusState]
    .some(value => String(value || "").toLowerCase().includes("hospital"))
}

function liveDurationLabel(timestampMs: number | null, nowMs: number): string {
  if (timestampMs === null) return "Unknown"
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000))
  if (seconds < 60) return "Under a minute"
  if (seconds < 3600) return Math.floor(seconds / 60) + "m"
  const hours = Math.floor(seconds / 3600)
  if (hours < 48) return hours + "h"
  const days = Math.floor(hours / 24)
  return days + "d " + hours % 24 + "h"
}

function liveRelativeTime(timestampMs: number | null, nowMs: number): string {
  if (timestampMs === null) return "No last-action timestamp"
  const seconds = Math.round((timestampMs - nowMs) / 1000)
  const absolute = Math.abs(seconds)
  const [value, unit] = absolute < 3600
    ? [Math.round(seconds / 60), "minute"]
    : absolute < 86400
      ? [Math.round(seconds / 3600), "hour"]
      : [Math.round(seconds / 86400), "day"]
  const relativeValue = typeof value === "number" ? value : Number(value)
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(relativeValue, unit as Intl.RelativeTimeFormatUnit)
}

function liveStatusUntil(value: string | null, nowMs: number): string | null {
  if (!value) return null
  const raw = value.trim()
  if (!raw) return null
  const numeric = /^\d+$/.test(raw) ? Number(raw) : null
  const timestamp = numeric === null ? Date.parse(raw) : numeric < 100000000000 ? numeric * 1000 : numeric
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  if (timestamp <= nowMs) return "Timer elapsed"
  return "Until " + new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date) + " UTC"
}

function FactionLiveStatus({ playerName, onNavigate, apiBase, sessionToken }: FactionWorkspaceProps) {
  const [payload, setPayload] = useState<FactionLivePayload | null>(null)
  const [filter, setFilter] = useState<FactionLiveFilter>("all")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")

  const load = async () => {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(apiBase + "/api/faction/performance", {
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const result = await response.json() as { error?: string } & Partial<FactionLivePayload>
      if (!response.ok) throw new Error(result.error || "Could not load the latest faction roster.")
      if (!result.roster || !Array.isArray(result.members)) throw new Error("The latest faction roster is not available yet.")
      setPayload(result as FactionLivePayload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load live member status.")
      setPayload(null)
    } finally { setBusy(false) }
  }

  useEffect(() => { void load() }, [apiBase, sessionToken])

  const nowMs = Date.now()
  const allMembers = payload?.members || []
  const countInactive = (thresholdHours: number, upperHours?: number) => allMembers.filter(member => {
    const lastAction = liveLastActionMs(member)
    if (lastAction === null) return false
    const hours = Math.max(0, (nowMs - lastAction) / 3600000)
    return hours >= thresholdHours && (upperHours === undefined || hours < upperHours)
  }).length
  const onlineCount = allMembers.filter(member => liveActivityState(member) === "online").length
  const idleCount = allMembers.filter(member => liveActivityState(member) === "idle").length
  const offlineCount = allMembers.filter(member => liveActivityState(member) === "offline").length
  const unknownCount = allMembers.filter(member => liveActivityState(member) === "unknown").length
  const hospitalCount = allMembers.filter(liveIsHospitalized).length
  const wallCount = allMembers.filter(member => member.isOnWall === true).length
  const ocCount = allMembers.filter(member => member.isInOc === true).length
  const revivableCount = allMembers.filter(member => member.isRevivable === true).length

  const matchesFilter = (member: FactionLiveMember): boolean => {
    const state = liveActivityState(member)
    const actionMs = liveLastActionMs(member)
    const hours = actionMs === null ? null : Math.max(0, (nowMs - actionMs) / 3600000)
    switch (filter) {
      case "online": return state === "online"
      case "idle": return state === "idle"
      case "offline": return state === "offline"
      case "inactive24": return hours !== null && hours >= 24
      case "inactive72": return hours !== null && hours >= 72
      case "hospital": return liveIsHospitalized(member)
      case "wall": return member.isOnWall === true
      case "oc": return member.isInOc === true
      case "revivable": return member.isRevivable === true
      case "reviveEveryone": return member.reviveSetting === "Everyone"
      case "reviveFriendsFaction": return member.reviveSetting === "Friends & faction"
      case "reviveNoOne": return member.reviveSetting === "No one"
      case "reviveUnknown": return !member.reviveSetting || member.reviveSetting === "Unknown"
      case "unknown": return state === "unknown" || actionMs === null
      default: return true
    }
  }
  const filtered = allMembers.filter(member => {
    const term = search.trim().toLowerCase()
    const searchMatch = !term || [member.name, member.userId, member.position].some(value => String(value ?? "").toLowerCase().includes(term))
    return searchMatch && matchesFilter(member)
  }).sort((a, b) => {
    const aTime = liveLastActionMs(a)
    const bTime = liveLastActionMs(b)
    if (aTime === null && bTime === null) return (a.name || "").localeCompare(b.name || "")
    if (aTime === null) return 1
    if (bTime === null) return -1
    return aTime - bTime
  })

  const formatRosterCapture = (value: string) => new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value)) + " UTC"
  const rosterAgeMinutes = payload?.roster?.capturedAt
    ? Math.max(0, Math.floor((nowMs - Date.parse(payload.roster.capturedAt)) / 60000))
    : null
  const rosterStale = rosterAgeMinutes !== null && rosterAgeMinutes > 15
  const statusCollection = payload?.collection.find(item => item.collectionKind === "roster")

  return (
    <main className="module-page faction-module faction-live-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>FACTION WORKSPACE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> NAUGHTY SOULS · MEMBER ACTIVITY</div><h1>Live <em>Member Status</em></h1><p>Public faction roster activity, hospital state, wall/OC flags and revive information. The configured revive setting and the API key's current revivability are shown separately.</p></section>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      <section className={"faction-live-freshness " + (rosterStale ? "stale" : "")}>
        <span>Roster snapshot: <strong>{payload?.roster ? formatRosterCapture(payload.roster.capturedAt) : "—"}</strong></span>
        <span>Age: <strong>{rosterAgeMinutes === null ? "—" : rosterAgeMinutes + " min"}</strong></span>
        <span>Collector: <strong>{statusCollection?.lastError ? "Last run reported an error" : "Last successful collection " + (statusCollection?.lastSuccessAt ? formatRosterCapture(statusCollection.lastSuccessAt) : "not available")}</strong></span>
        <button type="button" onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh ↻"}</button>
      </section>
      {rosterStale && <p className="faction-live-warning" role="status">The most recent completed roster is more than 15 minutes old. Activity and hospital details may be stale.</p>}
      <section className="faction-live-summary">
        <article><small>ROSTER MEMBERS</small><strong>{payload?.roster?.memberCount ?? "—"}</strong><span>Last completed roster</span></article>
        <article><small>ONLINE</small><strong>{payload ? onlineCount : "—"}</strong><span>Latest Torn action status</span></article>
        <article><small>IDLE</small><strong>{payload ? idleCount : "—"}</strong><span>Latest Torn action status</span></article>
        <article><small>INACTIVE 24H+</small><strong>{payload ? countInactive(24) : "—"}</strong><span>Based on Unix last-action time</span></article>
        <article><small>INACTIVE 72H+</small><strong>{payload ? countInactive(72) : "—"}</strong><span>Based on Unix last-action time</span></article>
        <article><small>HOSPITAL</small><strong>{payload ? hospitalCount : "—"}</strong><span>Current public status snapshot</span></article>
        <article><small>ON WALL</small><strong>{payload ? wallCount : "—"}</strong><span>Public faction roster flag</span></article>
        <article><small>IN OC</small><strong>{payload ? ocCount : "—"}</strong><span>Public faction roster flag</span></article>
        <article><small>KEY REVIVABLE</small><strong>{payload ? revivableCount : "—"}</strong><span>{payload ? unknownCount + " unknown · " + offlineCount + " offline" : "Owner-specific API field"}</span></article>
      </section>
      <section className="halloween-panel faction-live-panel">
        <div className="faction-directory-heading">
          <div><div className="halloween-status"><i /> LATEST PUBLIC FACTION ROSTER</div><h2>Member activity</h2><p>Sorted by oldest known last action first, with unknown timestamps kept at the bottom. A missing timestamp is not treated as inactivity.</p></div>
          <div className="faction-live-search"><input aria-label="Search faction members" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search member, position, or Torn ID…" /><select aria-label="Filter live member status" value={filter} onChange={event => setFilter(event.target.value as FactionLiveFilter)}><option value="all">All members</option><option value="online">Online</option><option value="idle">Idle</option><option value="offline">Offline</option><option value="inactive24">Inactive 24h+</option><option value="inactive72">Inactive 72h+</option><option value="hospital">Hospital</option><option value="wall">On wall</option><option value="oc">In OC</option><option value="revivable">Key revivable (owner-specific)</option><option value="reviveEveryone">Revive setting: Everyone</option><option value="reviveFriendsFaction">Revive setting: Friends &amp; faction</option><option value="reviveNoOne">Revive setting: No one</option><option value="reviveUnknown">Revive setting: Unknown</option><option value="unknown">Unknown activity</option></select></div>
        </div>
        {busy && !payload ? <p className="historical-key-muted">Loading the latest roster snapshot…</p> : filtered.length ? (
          <div className="historical-leaderboard faction-live-table-wrap">
            <table><thead><tr><th>MEMBER</th><th>ACTIVITY</th><th>LAST ACTION</th><th>INACTIVITY</th><th>STATUS / TIMER</th><th>REVIVE SETTING</th><th>KEY REVIVABLE</th><th>FLAGS</th><th>VOLUNTARY LIVE DATA</th></tr></thead><tbody>
              {filtered.map(member => {
                const actionMs = liveLastActionMs(member)
                const hospitalized = liveIsHospitalized(member)
                const state = liveActivityState(member)
                const timer = liveStatusUntil(member.statusUntil, nowMs)
                return <tr key={member.userId} className={hospitalized ? "faction-live-hospital-row" : ""}>
                  <td><strong>{member.name}</strong><small>#{member.userId} · {member.position || "No position"} · Lv {member.level ?? "—"}</small></td>
                  <td><span className={"faction-live-pill " + state}>{state === "unknown" ? "Unknown" : state}</span></td>
                  <td>{liveRelativeTime(actionMs, nowMs)}<small>{actionMs === null ? "Timestamp unavailable" : new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(actionMs)) + " UTC"}</small></td>
                  <td>{liveDurationLabel(actionMs, nowMs)}</td>
                  <td><strong>{member.statusDescription || member.statusState || "Unknown"}</strong>{member.statusDetails && <small>{member.statusDetails}</small>}{hospitalized && timer && <small>{timer}</small>}</td>
                  <td>{member.reviveSetting || "Unknown"}</td>
                  <td><span className={"faction-live-pill " + (member.isRevivable === true ? "yes" : member.isRevivable === false ? "no" : "unknown")}>{member.isRevivable === true ? "Yes" : member.isRevivable === false ? "No" : "Unknown"}</span></td>
                  <td className="faction-live-flags">{member.isOnWall === true && <span>Wall</span>}{member.isInOc === true && <span>OC</span>}{member.hasEarlyDischarge === true && <span>Early discharge</span>}{member.isOnWall !== true && member.isInOc !== true && member.hasEarlyDischarge !== true ? "—" : ""}</td>
                  <td className="faction-live-private-data">{member.privateLive ? <>
                    <small>Updated {liveDurationLabel(Date.parse(member.privateLive.capturedAt), nowMs)} ago</small>
                    <div className="faction-live-private-bars">
                      <span>Energy <strong>{formatPrivateLiveBar(member.privateLive.bars?.energy)}</strong></span>
                      <span>Nerve <strong>{formatPrivateLiveBar(member.privateLive.bars?.nerve)}</strong></span>
                      <span>Happy <strong>{formatPrivateLiveBar(member.privateLive.bars?.happy)}</strong></span>
                      <span>Life <strong>{formatPrivateLiveBar(member.privateLive.bars?.life)}</strong></span>
                    </div>
                    <div className="faction-live-private-cooldowns">
                      <span>Drug <strong>{formatPrivateLiveCooldown(member.privateLive.cooldowns?.drug)}</strong></span>
                      <span>Booster <strong>{formatPrivateLiveCooldown(member.privateLive.cooldowns?.booster)}</strong></span>
                      <span>Medical <strong>{formatPrivateLiveCooldown(member.privateLive.cooldowns?.medical)}</strong></span>
                    </div>
                    {member.privateLive.networth && <small>Detailed networth: <strong>{member.privateLive.networth.total === undefined ? "—" : "$" + Math.round(member.privateLive.networth.total).toLocaleString()}</strong> · {formatPrivateLiveSourceTime(member.privateLive.sourceTimestamps?.networthSourceTimestamp)}</small>}
                  </> : <span className="faction-live-private-unavailable">Not connected or not shared</span>}</td>
                </tr>
              })}
            </tbody></table>
          </div>
        ) : <div className="historical-empty"><strong>{allMembers.length ? "No members match that filter." : "No completed faction roster is available."}</strong><span>{allMembers.length ? "Change the activity filter or search term." : "The scheduled roster collector will populate this view when its first full run succeeds."}</span></div>}
      </section>
      <footer className="module-footer"><span>LIVE FACTION MEMBER STATUS</span><span>Signed in as {playerName} · Public faction roster fields only</span></footer>
    </main>
  )
}

type FactionActivityEvent = {
  id: string
  eventType: "member_added" | "member_removed" | "activity_changed" | "status_changed" | "wall_changed" | "oc_changed" | "early_discharge_changed" | "revive_setting_changed" | "position_changed"
  occurredAt: string
  userId: string
  memberName: string
  detail: string
  previousValue: string | null
  currentValue: string | null
}

type FactionActivityPayload = {
  generatedAt: string
  comparisonStatus: "compared" | "waiting_for_roster" | "waiting_for_previous_roster"
  latestRoster: { runId: string; capturedAt: string; scheduledAt: string; memberCount: number } | null
  previousRoster: { runId: string; capturedAt: string; scheduledAt: string; memberCount: number } | null
  eventCount: number
  eventCounts: Record<string, number>
  events: FactionActivityEvent[]
}

type FactionActivityFilter = "all" | "membership" | "status" | "flags" | "settings" | "position"

const factionActivityLabels: Record<FactionActivityEvent["eventType"], string> = {
  member_added: "Member added",
  member_removed: "Member removed",
  activity_changed: "Activity status",
  status_changed: "Member status",
  wall_changed: "Wall status",
  oc_changed: "OC status",
  early_discharge_changed: "Early discharge",
  revive_setting_changed: "Revive setting",
  position_changed: "Position changed",
}

function factionActivityCategory(type: FactionActivityEvent["eventType"]): Exclude<FactionActivityFilter, "all"> {
  if (type === "member_added" || type === "member_removed") return "membership"
  if (type === "activity_changed" || type === "status_changed") return "status"
  if (type === "wall_changed" || type === "oc_changed" || type === "early_discharge_changed") return "flags"
  if (type === "revive_setting_changed") return "settings"
  return "position"
}

function FactionActivityFeed({ playerName, onNavigate, apiBase, sessionToken }: FactionWorkspaceProps) {
  const [payload, setPayload] = useState<FactionActivityPayload | null>(null)
  const [filter, setFilter] = useState<FactionActivityFilter>("all")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")

  const load = async () => {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(apiBase + "/api/faction/activity", {
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const result = await response.json() as { error?: string } & Partial<FactionActivityPayload>
      if (!response.ok) throw new Error(result.error || "Could not load faction activity.")
      if (!Array.isArray(result.events) || !result.comparisonStatus) throw new Error("The faction activity response is incomplete.")
      setPayload(result as FactionActivityPayload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load faction activity.")
      setPayload(null)
    } finally { setBusy(false) }
  }

  useEffect(() => { void load() }, [apiBase, sessionToken])

  const formatAt = (value: string) => {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return "Unknown time"
    return new Intl.DateTimeFormat(undefined, {
      timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date) + " UTC"
  }
  const events = (payload?.events || []).filter(event => {
    const term = search.trim().toLowerCase()
    const matchesSearch = !term || [event.memberName, event.userId, event.detail, event.previousValue, event.currentValue]
      .some(value => String(value ?? "").toLowerCase().includes(term))
    return matchesSearch && (filter === "all" || factionActivityCategory(event.eventType) === filter)
  })
  const comparisonLabel = payload?.comparisonStatus === "compared"
    ? "Two completed roster snapshots compared"
    : payload?.comparisonStatus === "waiting_for_previous_roster"
      ? "Waiting for a second completed roster"
      : "Waiting for the first completed roster"
  const typeCount = (type: FactionActivityEvent["eventType"]) => payload?.eventCounts[type] || 0

  return (
    <main className="module-page faction-module faction-activity-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>FACTION WORKSPACE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> NAUGHTY SOULS · ROSTER CHANGES</div><h1>Faction <em>Activity</em></h1><p>Changes observed between the two latest completed public faction rosters. This feed reports what the collector observed, not an inferred minute-by-minute audit trail.</p></section>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      <section className="faction-activity-freshness">
        <div><small>LATEST COMPLETED ROSTER</small><strong>{payload?.latestRoster ? formatAt(payload.latestRoster.capturedAt) : "—"}</strong></div>
        <div><small>PREVIOUS COMPLETED ROSTER</small><strong>{payload?.previousRoster ? formatAt(payload.previousRoster.capturedAt) : "—"}</strong></div>
        <div><small>COMPARISON</small><strong>{comparisonLabel}</strong></div>
        <div><small>OBSERVED CHANGES</small><strong>{payload?.eventCount ?? "—"}</strong></div>
        <button type="button" onClick={() => void load()} disabled={busy}>{busy ? "Refreshing…" : "Refresh ↻"}</button>
      </section>
      <section className="faction-activity-summary">
        <article><small>MEMBERS ADDED</small><strong>{typeCount("member_added")}</strong></article>
        <article><small>DEPARTURES OBSERVED</small><strong>{typeCount("member_removed")}</strong></article>
        <article><small>ACTIVITY / STATUS CHANGES</small><strong>{typeCount("activity_changed") + typeCount("status_changed")}</strong></article>
        <article><small>WALL / OC CHANGES</small><strong>{typeCount("wall_changed") + typeCount("oc_changed")}</strong></article>
        <article><small>REVIVE-SETTING CHANGES</small><strong>{typeCount("revive_setting_changed")}</strong></article>
      </section>
      <section className="halloween-panel faction-activity-panel">
        <div className="faction-directory-heading">
          <div><div className="halloween-status"><i /> SNAPSHOT-TO-SNAPSHOT CHANGES</div><h2>Recent faction activity</h2><p>Membership and public roster changes only. Up to 100 most recent events per comparison.</p></div>
          <div className="faction-activity-controls">
            <input aria-label="Search faction activity" placeholder="Search member or change…" value={search} onChange={event => setSearch(event.target.value)} />
            <select aria-label="Filter faction activity" value={filter} onChange={event => setFilter(event.target.value as FactionActivityFilter)}>
              <option value="all">All changes</option><option value="membership">Membership</option><option value="status">Activity &amp; status</option><option value="flags">Wall / OC flags</option><option value="settings">Revive settings</option><option value="position">Position</option>
            </select>
          </div>
        </div>
        {busy && !payload ? <p className="historical-key-muted">Comparing completed roster snapshots…</p> : events.length ? (
          <ol className="faction-activity-list">
            {events.map(event => <li key={event.id} className={"faction-activity-event " + event.eventType}>
              <div className="faction-activity-event-marker" aria-hidden="true" />
              <div className="faction-activity-event-main">
                <div className="faction-activity-event-top"><span>{factionActivityLabels[event.eventType]}</span><time dateTime={event.occurredAt}>{formatAt(event.occurredAt)}</time></div>
                <strong>{event.memberName}</strong><small>#{event.userId}</small>
                <p>{event.detail}</p>
                {(event.previousValue !== null || event.currentValue !== null) && <div className="faction-activity-transition"><span>{event.previousValue ?? "Unknown"}</span><b>→</b><span>{event.currentValue ?? "Unknown"}</span></div>}
              </div>
            </li>)}
          </ol>
        ) : <div className="historical-empty"><strong>{payload?.comparisonStatus === "compared" ? (payload.events.length ? "No changes match this filter." : "No changes observed between these rosters.") : "Activity comparison is preparing."}</strong><span>{payload?.comparisonStatus === "compared" ? "The feed only includes changes visible between completed roster snapshots." : "A second completed roster is required before snapshot-to-snapshot changes can be reported."}</span></div>}
      </section>
      <footer className="module-footer"><span>FACTION ACTIVITY FEED</span><span>Signed in as {playerName} · Public roster history only</span></footer>
    </main>
  )
}

function FactionCompanyDirectory({ playerName, onNavigate, apiBase, sessionToken }: FactionWorkspaceProps) {
  const [directory, setDirectory] = useState<FactionDirectoryPayload | null>(null)
  const [members, setMembers] = useState<FactionMemberSummary[]>([])
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState(true)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [selectedHistory, setSelectedHistory] = useState<FactionDirectorHistory | null>(null)
  const [error, setError] = useState("")

  const loadDirectory = async () => {
    setBusy(true); setError("")
    try {
      const response = await fetch(apiBase + "/api/faction/directors", { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string } & Partial<FactionDirectoryPayload>
      if (!response.ok) throw new Error(payload.error || "Could not load the faction company directory.")
      setDirectory({
        directors: Array.isArray(payload.directors) ? payload.directors : [],
        weeklyStarCounts: Array.isArray(payload.weeklyStarCounts) ? payload.weeklyStarCounts : [],
        weeklyStarCountsCapturedAt: payload.weeklyStarCountsCapturedAt || "",
        generatedAt: payload.generatedAt || "",
        source: payload.source || "Faction directory cache",
      })
      const memberResponse = await fetch(apiBase + "/api/dashboard-members", { headers: { Authorization: "Bearer " + sessionToken } })
      const memberPayload = await memberResponse.json() as { error?: string; members?: FactionMemberSummary[] }
      if (!memberResponse.ok) throw new Error(memberPayload.error || "Could not load the active faction member roster.")
      setMembers(Array.isArray(memberPayload.members) ? memberPayload.members : [])
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load the faction company directory.") }
    finally { setBusy(false) }
  }

  const refreshDirectory = async () => {
    if (refreshBusy) return
    setRefreshBusy(true); setError("")
    try {
      const response = await fetch(apiBase + "/api/faction/directors", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken },
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not refresh the faction directory.")
      await loadDirectory()
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not refresh the faction directory.") }
    finally { setRefreshBusy(false) }
  }

  const loadDirectorHistory = async (director: FactionDirectorSummary) => {
    setHistoryBusy(true); setError(""); setSelectedHistory(null)
    try {
      const response = await fetch(apiBase + "/api/faction/compare?playerId=" + encodeURIComponent(director.playerId), { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string; director?: FactionDirectorSummary; history?: FactionDirectorHistory["history"]; stockHistoryAvailable?: boolean }
      if (!response.ok) throw new Error(payload.error || "Could not load this director's historical company data.")
      if (!payload.director) throw new Error("The faction directory did not return this director's company profile.")
      setSelectedHistory({ director: payload.director, history: payload.history || [], stockHistoryAvailable: payload.stockHistoryAvailable === true })
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not load this director's historical company data.") }
    finally { setHistoryBusy(false) }
  }

  useEffect(() => { void loadDirectory() }, [apiBase, sessionToken])

  const directors = (directory?.directors || []).filter(director => {
    const term = search.trim().toLowerCase()
    return !term || [director.directorName, director.companyName, director.companyType, director.playerId, director.companyId].some(value => String(value ?? "").toLowerCase().includes(term))
  })
  const filteredMembers = members.filter(member => {
    const term = search.trim().toLowerCase()
    return !term || [member.playerName, member.playerId, member.companyName, member.companyType].some(value => String(value ?? "").toLowerCase().includes(term))
  })
  const totalWeeklyIncome = (directory?.directors || []).reduce((sum, director) => sum + (typeof director.weeklyIncome === "number" ? director.weeklyIncome : 0), 0)
  const totalDailyIncome = (directory?.directors || []).reduce((sum, director) => sum + (typeof director.dailyIncome === "number" ? director.dailyIncome : 0), 0)
  const knownWeekly = (directory?.directors || []).filter(director => typeof director.weeklyIncome === "number").length
  const knownDaily = (directory?.directors || []).filter(director => typeof director.dailyIncome === "number").length
  const money = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : "$" + Math.round(value).toLocaleString()

  return (
    <main className="module-page faction-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>FACTION WORKSPACE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> NAUGHTY SOULS · SHARED INTELLIGENCE</div><h1>Faction <em>Dashboard</em></h1><p>Company leadership, operating income, and faction-wide business visibility. Private company details remain governed by each director's sharing permissions.</p></section>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      <section className="faction-toolbar">
        <div><small>FACTION COMPANY DIRECTORY</small><strong>{directory?.directors.length ?? 0} confirmed director accounts</strong><span>{directory?.source || "Loading directory source…"}</span></div>
        <div className="live-toolbar-actions"><button type="button" onClick={() => void loadDirectory()} disabled={busy}>{busy ? "Refreshing cache…" : "Reload directory ↻"}</button><button type="button" onClick={() => void refreshDirectory()} disabled={refreshBusy}>{refreshBusy ? "Syncing Torn…" : "Sync from Torn"}</button></div>
      </section>
      <section className="faction-metric-grid">
        <article><small>ACTIVE FACTION MEMBERS</small><strong>{members.length || (busy ? "—" : 0)}</strong><span>Verified and enabled member accounts</span></article>
        <article><small>KNOWN DAILY INCOME</small><strong>{directory ? money(totalDailyIncome) : "—"}</strong><span>{knownDaily} of {directory?.directors.length ?? 0} with income data</span></article>
        <article><small>KNOWN WEEKLY INCOME</small><strong>{directory ? money(totalWeeklyIncome) : "—"}</strong><span>{knownWeekly} of {directory?.directors.length ?? 0} with income data</span></article>
      </section>
      <section className="halloween-panel faction-directory-panel">
        <div className="faction-directory-heading"><div><div className="halloween-status"><i /> DIRECTOR DIRECTORY</div><h2>Company leadership</h2><p>Ranked by cached weekly income. Missing financial fields remain unavailable rather than being treated as zero.</p></div><input aria-label="Search faction directors" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search director, company, or ID…" /></div>
        {busy && !directory ? <p className="historical-key-muted">Loading the faction directory…</p> : directors.length ? (
          <div className="historical-leaderboard">
            <table><thead><tr><th>DIRECTOR</th><th>COMPANY</th><th>TYPE</th><th>STARS</th><th>DAILY INCOME</th><th>WEEKLY INCOME</th><th>UPDATED</th><th>HISTORY</th></tr></thead><tbody>
              {directors.map(director => <tr key={director.playerId + ":" + director.companyId}>
                <td><strong>{director.directorName}</strong><small>#{director.playerId}</small></td>
                <td><strong>{director.companyName || "Company #" + director.companyId}</strong><small>ID {director.companyId}</small></td>
                <td>{director.companyType || "—"}</td>
                <td>{director.starRating === null ? "—" : director.starRating.toFixed(1)}</td>
                <td>{money(director.dailyIncome)}</td>
                <td>{money(director.weeklyIncome)}</td>
                <td>{director.fetchedAt ? new Date(director.fetchedAt).toLocaleString() : "—"}</td>
                <td><button type="button" className="faction-history-button" disabled={historyBusy} onClick={() => void loadDirectorHistory(director)}>{historyBusy ? "Loading…" : "View history"}</button></td>
              </tr>)}
            </tbody></table>
          </div>
        ) : <div className="historical-empty"><strong>{directory?.directors.length ? "No directors match that search." : "No faction director records are available yet."}</strong><span>{directory?.directors.length ? "Try a director name, company name, or Torn ID." : "Use Sync from Torn to refresh the directory with your saved faction login key."}</span></div>}
      </section>
      {selectedHistory && <section className="halloween-panel faction-history-panel">
        <div className="faction-directory-heading"><div><div className="halloween-status"><i /> DIRECTOR HISTORY</div><h2>{selectedHistory.director.companyName}</h2><p>{selectedHistory.director.directorName} · Company #{selectedHistory.director.companyId} · {selectedHistory.history.length} saved snapshots</p></div><button type="button" className="faction-history-button" onClick={() => setSelectedHistory(null)}>Close history</button></div>
        <div className="coverage-grid">
          <div><small>LATEST DAILY INCOME</small><strong>{money(selectedHistory.history.at(-1)?.dailyIncome ?? null)}</strong><span>From the latest shared snapshot</span></div>
          <div><small>LATEST WEEKLY INCOME</small><strong>{money(selectedHistory.history.at(-1)?.weeklyIncome ?? null)}</strong><span>From the latest shared snapshot</span></div>
          <div><small>STOCK HISTORY</small><strong>{selectedHistory.stockHistoryAvailable ? "Shared" : "Not shared"}</strong><span>Stock details follow the director's sharing permissions</span></div>
        </div>
        <div className="historical-leaderboard">
          {selectedHistory.history.length ? <table><thead><tr><th>SNAPSHOT DAY</th><th>DAILY INCOME</th><th>WEEKLY INCOME</th><th>DAILY PROFIT</th><th>STOCK QUANTITY</th></tr></thead><tbody>
            {selectedHistory.history.slice(-30).slice().reverse().map(point => <tr key={point.day}>
              <td>{point.day}</td><td>{money(point.dailyIncome)}</td><td>{money(point.weeklyIncome)}</td><td>{money(point.dailyProfit)}</td><td>{point.stockQuantity === null ? "—" : point.stockQuantity.toLocaleString()}</td>
            </tr>)}
          </tbody></table> : <div className="historical-empty"><strong>No historical snapshots are available.</strong><span>This director has not accumulated enough saved history yet, or no history has been shared with your account.</span></div>}
        </div>
      </section>}
      <section className="halloween-panel faction-roster-panel">
        <div className="faction-directory-heading"><div><div className="halloween-status"><i /> ACTIVE FACTION ROSTER</div><h2>Naughty Souls members</h2><p>Verified Naughty Souls accounts with enabled portal access. Membership is periodically rechecked; the last successful verification time is shown for transparency.</p></div></div>
        <div className="historical-leaderboard">
          {busy && !members.length ? <p className="historical-key-muted">Loading the active member roster…</p> : filteredMembers.length ? <table><thead><tr><th>MEMBER</th><th>TORN ID</th><th>COMPANY</th><th>COMPANY TYPE</th><th>MEMBERSHIP VERIFIED</th></tr></thead><tbody>
            {filteredMembers.map(member => <tr key={member.playerId}>
              <td><strong>{member.playerName}</strong></td>
              <td>#{member.playerId}</td>
              <td>{member.companyName || "—"}</td>
              <td>{member.companyType || "—"}</td>
              <td>{member.membershipVerifiedAt ? new Date(member.membershipVerifiedAt).toLocaleString() : "Not verified"}</td>
            </tr>)}
          </tbody></table> : <div className="historical-empty"><strong>No matching faction members.</strong><span>{members.length ? "Try another name, Torn ID, or company search." : "No active verified member accounts are available in the roster yet."}</span></div>}
        </div>
      </section>
      <section className="faction-star-panel">
        <div><small>WEEKLY STAR DISTRIBUTION</small><strong>Faction company ratings</strong><span>{directory?.weeklyStarCountsCapturedAt ? "Captured " + new Date(directory.weeklyStarCountsCapturedAt).toLocaleString() : "No weekly snapshot timestamp available"}</span></div>
        <div className="faction-star-list">
          {(directory?.weeklyStarCounts || []).slice().sort((a, b) => b.starRating - a.starRating).map(item => <div key={item.starRating}><span>{item.starRating.toFixed(1)} stars</span><div><i style={{ width: Math.min(100, item.companyCount / Math.max(1, ...(directory?.weeklyStarCounts || []).map(value => value.companyCount)) * 100) + "%" }} /></div><strong>{item.companyCount}</strong></div>)}
          {!directory?.weeklyStarCounts.length && <span className="settings-form-hint">Weekly star-rating data will appear after the Sunday snapshot.</span>}
        </div>
      </section>
      <footer className="module-footer"><span>FACTION WORKSPACE</span><span>Signed in as {playerName} · {directory?.generatedAt ? "Updated " + new Date(directory.generatedAt).toLocaleString() : "Waiting for directory data"}</span></footer>
    </main>
  )
}

export function HalloweenWorkspace({ playerName, onNavigate, apiBase, sessionToken }: Pick<WorkspaceProps, "playerName" | "onNavigate"> & { apiBase: string; sessionToken: string }) {
  const eventYear = new Date().getUTCFullYear()
  const [tab, setTab] = useState<"live" | "historical">("live")
  const [personalWindow, setPersonalWindow] = useState<HalloweenMemberEventWindow | null>(null)
  const [personalStartTime, setPersonalStartTime] = useState("")
  const [eventWindowLocked, setEventWindowLocked] = useState(false)
  const [eventWindowBusy, setEventWindowBusy] = useState(false)
  const [eventWindowError, setEventWindowError] = useState("")
  const [eventWindowNotice, setEventWindowNotice] = useState("")
  const [historicalConsent, setHistoricalConsent] = useState(false)
  const [historicalKeyStatus, setHistoricalKeyStatus] = useState<{ connected: boolean; key: { lastFour: string; accessLevel: string; consentedAt: string; lastValidatedAt: string } | null } | null>(null)
  const [historicalKeyBusy, setHistoricalKeyBusy] = useState(false)
  const [historicalKeyMessage, setHistoricalKeyMessage] = useState("")
  const [historicalKeyError, setHistoricalKeyError] = useState("")
  const [live, setLive] = useState<HalloweenLivePayload | null>(null)
  const [liveBusy, setLiveBusy] = useState(true)
  const [liveCaptureBusy, setLiveCaptureBusy] = useState(false)
  const [liveError, setLiveError] = useState("")
  const [archive, setArchive] = useState<{ event: { eventYear: number; startAt: string; endAt: string }; myWindow?: HalloweenMemberEventWindow | null; leaderboard: Array<{ playerId: string; playerName: string; eventWindowConfigured?: boolean; startTime?: string | null; keyConnected: boolean; collectionStatus: string; pagesCollected: number; logsCollected: number; totalHits: number | null; lastCollectedAt: string | null; coverage: string }>; myCollection: { playerId: string; collectionStatus: string; coverage: string; totalHits: number | null } | null } | null>(null)
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
      const payload = await response.json() as { error?: string; event?: { eventYear: number; startAt: string; endAt: string }; myWindow?: HalloweenMemberEventWindow | null; leaderboard?: typeof archive extends infer T ? T extends { leaderboard: infer L } ? L : never : never; myCollection?: { playerId: string; collectionStatus: string; coverage: string; totalHits: number | null } | null }
      if (!response.ok) throw new Error(payload.error || "Could not load the faction Halloween archive.")
      if (!payload.event) throw new Error("This Halloween event year is not configured yet.")
      setArchive({ event: payload.event, myWindow: payload.myWindow ?? null, leaderboard: (payload.leaderboard || []) as NonNullable<typeof archive>["leaderboard"], myCollection: payload.myCollection ?? null })
      if (payload.myWindow) { setPersonalWindow(payload.myWindow); if (payload.myWindow.startTime) setPersonalStartTime(payload.myWindow.startTime) }
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
        myWindow: payload.myWindow ?? null,
        leaderboard: Array.isArray(payload.leaderboard) ? payload.leaderboard : [],
        mySnapshot: payload.mySnapshot ?? null,
      })
      if (payload.myWindow) { setPersonalWindow(payload.myWindow); if (payload.myWindow.startTime) setPersonalStartTime(payload.myWindow.startTime) }
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

  const loadPersonalEventWindow = async () => {
    try {
      const response = await fetch(apiBase + "/api/me/halloween/event-window?year=" + eventYear, { headers: { Authorization: "Bearer " + sessionToken } })
      const payload = await response.json() as { error?: string; myWindow?: HalloweenMemberEventWindow | null; locked?: boolean }
      if (!response.ok) throw new Error(payload.error || "Could not load your personal event time.")
      setPersonalWindow(payload.myWindow ?? null)
      setPersonalStartTime(payload.myWindow?.startTime ?? "")
      setEventWindowLocked(payload.locked === true)
    } catch (caught) { setEventWindowError(caught instanceof Error ? caught.message : "Could not load your personal event time.") }
  }

  const savePersonalEventWindow = async () => {
    if (!personalStartTime || eventWindowBusy || eventWindowLocked) return
    setEventWindowBusy(true); setEventWindowError(""); setEventWindowNotice("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/event-window", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ year: eventYear, startTime: personalStartTime }),
      })
      const payload = await response.json() as { error?: string; saved?: boolean; locked?: boolean; myWindow?: HalloweenMemberEventWindow }
      if (!response.ok) throw new Error(payload.error || "Could not save your personal event time.")
      setPersonalWindow(payload.myWindow ?? null)
      setEventWindowLocked(payload.locked === true)
      setEventWindowNotice("Your personal event window is saved. The end time uses the same TCT clock time on November 1.")
      await Promise.all([loadLive(), loadArchive()])
    } catch (caught) { setEventWindowError(caught instanceof Error ? caught.message : "Could not save your personal event time.") }
    finally { setEventWindowBusy(false) }
  }

  useEffect(() => { void loadPersonalEventWindow() }, [eventYear, apiBase, sessionToken])
  useEffect(() => { if (tab === "live") void loadLive() }, [tab, eventYear, apiBase, sessionToken])
  useEffect(() => { void loadHistoricalKeyStatus() }, [apiBase, sessionToken])
  useEffect(() => { if (tab === "historical") void loadArchive() }, [tab, eventYear, apiBase, sessionToken])

  const saveHistoricalKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!historicalConsent || historicalKeyBusy) return
    setHistoricalKeyBusy(true); setHistoricalKeyError(""); setHistoricalKeyMessage("")
    try {
      const response = await fetch(apiBase + "/api/me/halloween/key", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, consentVersion: "halloween-history-v1" }),
      })
      const payload = await response.json() as { error?: string; saved?: boolean }
      if (!response.ok) throw new Error(payload.error || "Could not enable historical collection with your portal key.")
      setHistoricalConsent(false)
      setHistoricalKeyMessage("Historical collection is enabled using your saved portal API key.")
      await Promise.all([loadHistoricalKeyStatus(), loadArchive()])
    } catch (caught) { setHistoricalKeyError(caught instanceof Error ? caught.message : "Could not enable historical collection with your portal key.") }
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
  const personalStartMs = personalWindow?.startAt ? Date.parse(personalWindow.startAt) : Number.NaN
  const personalEndMs = personalWindow?.endAt ? Date.parse(personalWindow.endAt) : Number.NaN
  const nowMs = Date.now()
  const personalEventPhase = !personalWindow?.configured ? "TIME SLOT REQUIRED" : nowMs < personalStartMs ? "UPCOMING FOR YOU" : nowMs < personalEndMs ? "ACTIVE FOR YOU" : "YOUR EVENT WINDOW CONCLUDED"
  const canCapturePersonalSnapshot = Boolean(personalWindow?.configured && nowMs >= personalStartMs && nowMs < personalEndMs)

  return (
    <main className="module-page halloween-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>HALLOWEEN INTELLIGENCE</small></span></a><button type="button" onClick={() => onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> SHARED FACTION EVENT DATA</div><h1>Halloween <em>Dashboard</em></h1><p>One faction leaderboard and event archive, built from members' own authorized Torn data.</p></section>
      <nav className="halloween-tabs" aria-label="Halloween dashboard sections">
        <button type="button" className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}><span>◉</span> Live / Current Year</button>
        <button type="button" className={tab === "historical" ? "active" : ""} onClick={() => setTab("historical")}><span>◷</span> Historical</button>
      </nav>
      <section className="halloween-personal-window" aria-labelledby="halloween-personal-window-title">
        <div className="halloween-personal-window-copy">
          <div className="halloween-status"><i /> YOUR PERSONAL EVENT WINDOW · {eventYear}</div>
          <h2 id="halloween-personal-window-title">Your Trick or Treat start time</h2>
          <p>Choose the same start time you selected in Torn's Calendar. TCT is UTC. Your personal window starts on October 25 and ends on November 1 at the same selected clock time, so members can have different start and finish times.</p>
          {personalWindow?.configured && personalWindow.startAt && personalWindow.endAt ? (
            <div className="halloween-personal-window-range">
              <span><small>START</small><strong>{formatTctDateTime(personalWindow.startAt)} TCT</strong></span>
              <span><small>END</small><strong>{formatTctDateTime(personalWindow.endAt)} TCT</strong></span>
            </div>
          ) : <div className="halloween-personal-window-unset">No personal time saved yet. Select your Torn event slot before contributing historical logs or receiving scheduled live snapshots.</div>}
        </div>
        <div className="halloween-personal-window-control">
          <label htmlFor="halloween-personal-start-time">Start time (TCT)</label>
          <select id="halloween-personal-start-time" value={personalStartTime} onChange={event => setPersonalStartTime(event.target.value)} disabled={eventWindowBusy || eventWindowLocked}>
            <option value="">Choose your time</option>
            {halloweenStartTimeOptions.map(time => <option value={time} key={time}>{time}</option>)}
          </select>
          <button type="button" onClick={() => void savePersonalEventWindow()} disabled={eventWindowBusy || eventWindowLocked || !personalStartTime}>{eventWindowBusy ? "Saving…" : eventWindowLocked ? "Time locked after collection" : "Save my event time"}</button>
          {eventWindowLocked && <small className="halloween-slot-hint">Locked because collection or snapshot capture has started. This protects existing records from being assigned to a different window.</small>}
          {eventWindowError && <p className="historical-key-error" role="alert">{eventWindowError}</p>}
          {eventWindowNotice && <p className="historical-key-message" role="status">{eventWindowNotice}</p>}
        </div>
      </section>
      {tab === "live" ? (
        <section className="halloween-panel">
          <div className="halloween-status"><i /> {personalEventPhase} · {eventYear}</div>
          <h2>Live event intelligence</h2>
          <p>The current-year leaderboard uses each member's own saved limited-access login key. Detailed logs and hit history are collected separately through each member's Full Access historical key.</p>
          <div className="historical-collection-toolbar">
            <div><small>FACTION LIVE LEADERBOARD</small><strong>{live?.leaderboard.length ?? 0} member accounts</strong></div>
            <div className="live-toolbar-actions">
              {canCapturePersonalSnapshot && <button type="button" onClick={() => void captureLiveSnapshot()} disabled={liveCaptureBusy}>{liveCaptureBusy ? "Capturing…" : "Capture my snapshot"}</button>}
              <button type="button" onClick={() => void loadLive()} disabled={liveBusy}>{liveBusy ? "Refreshing…" : "Refresh live board ↻"}</button>
            </div>
          </div>
          {liveError && <p className="historical-key-error" role="alert">{liveError}</p>}
          {liveBusy && !live ? <p className="historical-key-muted">Loading live faction snapshots…</p> : live ? <>
            {live.mySnapshot?.capturedAt ? <div className="coverage-grid">
              <div><small>MY CURRENT TREATS</small><strong>{live.mySnapshot.currentTreats?.toLocaleString() ?? "—"}</strong><span>Latest saved current count</span></div>
              <div><small>MY TOTAL TREATS</small><strong>{live.mySnapshot.totalTreats?.toLocaleString() ?? "—"}</strong><span>Latest saved event total</span></div>
              <div><small>UPGRADES UNLOCKED</small><strong>{live.mySnapshot.upgradesUnlocked ?? "—"}</strong><span>{live.mySnapshot.capturedAt ? "Captured " + new Date(live.mySnapshot.capturedAt).toLocaleString() : "No snapshot timestamp"}</span></div>
            </div> : <div className="historical-empty"><strong>Your live snapshot has not been collected.</strong><span>Live snapshots use your own saved faction login key. Missing data remains unavailable, not zero.</span></div>}
            <div className="historical-leaderboard">
              {live.leaderboard.length ? <table><thead><tr><th>RANK</th><th>MEMBER</th><th>CURRENT TREATS</th><th>TOTAL TREATS</th><th>UPGRADES</th><th>COVERAGE</th></tr></thead><tbody>
                {live.leaderboard.map((member, index) => <tr key={member.playerId}>
                  <td>{member.totalTreats === null ? "—" : index + 1}</td>
                  <td>{member.playerName}<small>#{member.playerId} · {member.startTime ? "Event slot " + member.startTime + " TCT" : "Event slot not set"} · {member.snapshotKind ?? "no snapshot"} · {member.sourceTimestamp == null ? "source time unavailable" : "Torn " + new Date(member.sourceTimestamp * 1000).toLocaleString()}</small></td>
                  <td>{member.currentTreats === null ? "—" : member.currentTreats.toLocaleString()}</td>
                  <td>{member.totalTreats === null ? "—" : member.totalTreats.toLocaleString()}</td>
                  <td>{member.upgradesUnlocked === null ? "—" : member.upgradesUnlocked}</td>
                  <td><span className={"coverage-pill " + (member.coverage === "captured" ? "complete" : "not_collected")}>{member.coverage === "captured" ? "Captured" : "Not collected"}</span></td>
                </tr>)}
              </tbody></table> : <div className="historical-empty"><strong>No live snapshots have been collected yet.</strong><span>Opening, periodic and closing collection is controlled by the event's live-collection setting.</span></div>}
            </div>
            <p className="historical-key-muted">{live.event.liveCollectionEnabled ? "Scheduled live collection is enabled for this event." : "Scheduled live collection is currently disabled for this event."} {personalWindow?.configured && personalWindow.startAt && personalWindow.endAt ? "Your event window: " + formatTctDateTime(personalWindow.startAt) + " to " + formatTctDateTime(personalWindow.endAt) + " TCT." : "Set your personal TCT time above to enable a member-specific event window."}</p>
          </> : !liveBusy ? <div className="historical-empty"><strong>Live snapshots are unavailable.</strong><span>Refresh to check the current faction leaderboard.</span></div> : null}
        </section>
      ) : (
        <section className="halloween-panel">
          <div className="halloween-status historical"><i /> FACTION ARCHIVE · {eventYear}</div>
          <h2>Historical event records</h2>
          <p>Historical log collection reuses your single portal API key. Full Access or Custom Access with User → Log is supported. Collected event history is shared with authenticated Naughty Souls members only after you opt in.</p>
          <div className="historical-key-notice"><strong>Your own key. Your own records. Shared faction history.</strong><span>Your sign-in key is already encrypted and associated with your Torn player ID. Enable historical collection below to authorize its use for your own event logs. Other members can browse the shared faction archive without connecting a key. If you leave Naughty Souls, your saved key and contributed Halloween records are purged.</span></div>
          <section className="historical-key-card">
            <div className="historical-key-heading"><div><small>YOUR HISTORICAL COLLECTION KEY</small><strong>{historicalKeyStatus?.connected ? "Enabled · •••• " + (historicalKeyStatus.key?.lastFour || "••••") : "Not connected"}</strong></div><span className={historicalKeyStatus?.connected ? "key-status connected" : "key-status"}><i /> {historicalKeyStatus?.connected ? (historicalKeyStatus.key?.accessLevel || "PORTAL KEY") + " VERIFIED" : "OPT-IN REQUIRED"}</span></div>
            {historicalKeyStatus?.connected ? <div className="historical-key-connected"><p>Your saved portal key will be reused for historical collection. Last validation: {historicalKeyStatus.key?.lastValidatedAt ? new Date(historicalKeyStatus.key.lastValidatedAt).toLocaleString() : "Not available"}.</p><button type="button" disabled={historicalKeyBusy} onClick={removeHistoricalKey}>Disable historical collection</button></div> : <form className="historical-key-form" onSubmit={saveHistoricalKey}>
              <p>Your saved portal API key will be used. No second API key is required.</p>
              <div className="historical-tos"><strong>Historical Halloween data use</strong><table><tbody>
                <tr><th>Data Storage</th><td>Persistent, until account deletion or faction change. Disconnecting the key does not erase records already contributed.</td></tr>
                <tr><th>Data Sharing</th><td>All authenticated Naughty Souls faction members.</td></tr>
                <tr><th>Purpose of Use</th><td>Halloween event analytics, personal event history, and faction-wide leaderboard/archive.</td></tr>
                <tr><th>Key Storage & Sharing</th><td>Stored remotely encrypted; used only by this service's historical collection workflows. The raw key is not shared with faction members.</td></tr>
                <tr><th>Key Access Level</th><td>Full Access, or Custom Access with the User → Log selection. Category restrictions must include the event records you want to contribute.</td></tr>
              </tbody></table></div>
              <label className="historical-consent"><input type="checkbox" checked={historicalConsent} onChange={event => setHistoricalConsent(event.target.checked)} disabled={historicalKeyBusy} /><span>I have reviewed the data-use terms and consent to using my saved portal API key for historical log collection and sharing the collected Halloween event records with authenticated Naughty Souls faction members.</span></label>
              <button className="historical-connect-button" type="submit" disabled={historicalKeyBusy || !historicalConsent}>{historicalKeyBusy ? "Enabling…" : "Enable historical collection with portal key"}</button>
            </form>}
            {historicalKeyError && <p className="historical-key-error" role="alert">{historicalKeyError}</p>}
            {historicalKeyMessage && <p className="historical-key-message" role="status">{historicalKeyMessage}</p>}
            {!historicalKeyStatus && <p className="historical-key-muted">Checking your saved key status…</p>}
          </section>
          <div className="historical-collection-toolbar"><div><small>FACTION HISTORICAL LEADERBOARD</small><strong>{archive?.leaderboard.length ?? 0} member accounts in the archive</strong></div><button type="button" onClick={() => { void loadArchive(); void loadHistoricalKeyStatus() }} disabled={archiveBusy}>{archiveBusy ? "Refreshing…" : "Refresh archive ↻"}</button></div>
          {archiveError && <p className="historical-key-error" role="alert">{archiveError}</p>}
          {collectMessage && <p className="historical-key-message" role="status">{collectMessage}</p>}
          {archive?.myCollection?.coverage !== "complete" && historicalKeyStatus?.connected && <div className="historical-collect-banner"><div><strong>Contribute your historical event logs</strong><span>Collection follows your saved personal window, from your selected October 25 start time through November 1 at the same TCT time.</span></div><button type="button" onClick={startHistoricalCollection} disabled={collectBusy || archive?.myCollection?.coverage === "collecting" || !personalWindow?.configured}>{collectBusy ? "Queueing…" : archive?.myCollection?.coverage === "collecting" ? "Collection running…" : !personalWindow?.configured ? "Set event time above" : "Collect my history"}</button></div>}
          <div className="historical-leaderboard">
            {!archive && archiveBusy ? <p className="historical-key-muted">Loading faction archive…</p> : archive?.leaderboard.length ? <table><thead><tr><th>RANK</th><th>MEMBER</th><th>TOTAL HITS</th><th>LOGS</th><th>COVERAGE</th></tr></thead><tbody>
              {archive.leaderboard.map((member, index) => <tr key={member.playerId} className={selectedMember?.playerId === member.playerId ? "selected" : ""}>
                <td>{member.totalHits === null ? "—" : index + 1}</td>
                <td><button type="button" className="historical-member-link" onClick={() => void loadMemberDetail({ playerId: member.playerId, playerName: member.playerName })}>{member.playerName}<small>#{member.playerId} · {member.startTime ? "Event slot " + member.startTime + " TCT" : "Event slot not set"}</small></button></td>
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
type PrivateLiveConnectionStatus = {
  connected: boolean
  key: {
    lastFour: string
    includeNetworth: boolean
    shareWithFaction: boolean
    consentedAt: string | null
    lastCollectedAt: string | null
    lastError: string | null
  } | null
  snapshot: { capturedAt: string } | null
}

type AccountSettingsProps = WorkspaceProps & {
  apiBase: string
  sessionToken: string
  onCompaniesChanged: (companies: SavedCompanySummary[]) => void
  onLoginKeyChanged: (saved: boolean) => void
}

export function AccountSettingsWorkspace(props: AccountSettingsProps) {
  const [loginKey, setLoginKey] = useState("")
  const [loginBusy, setLoginBusy] = useState(false)
  const [companyBusy, setCompanyBusy] = useState(false)
  const [secondaryCompanyKey, setSecondaryCompanyKey] = useState("")
  const [sessionBusy, setSessionBusy] = useState(false)
  const [accountError, setAccountError] = useState("")
  const [accountNotice, setAccountNotice] = useState("")
  const [privateLiveStatus, setPrivateLiveStatus] = useState<PrivateLiveConnectionStatus | null>(null)
  const [privateLiveConsent, setPrivateLiveConsent] = useState(false)
  const [privateLiveIncludeNetworth, setPrivateLiveIncludeNetworth] = useState(false)
  const [privateLiveBusy, setPrivateLiveBusy] = useState(false)

  const loadPrivateLiveStatus = async () => {
    const response = await fetch(props.apiBase + "/api/me/private-live/key", {
      headers: { Authorization: "Bearer " + props.sessionToken },
    })
    const payload = await response.json() as { error?: string } & Partial<PrivateLiveConnectionStatus>
    if (!response.ok) throw new Error(payload.error || "Could not load your private live connection status.")
    setPrivateLiveStatus(payload as PrivateLiveConnectionStatus)
    if (payload.key) setPrivateLiveIncludeNetworth(payload.key.includeNetworth)
    return payload as PrivateLiveConnectionStatus
  }

  useEffect(() => {
    void loadPrivateLiveStatus().catch(caught => {
      setAccountError(caught instanceof Error ? caught.message : "Could not load your private live connection status.")
    })
  }, [props.apiBase, props.sessionToken])

  const connectPrivateLiveKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!privateLiveConsent || privateLiveBusy) return
    setPrivateLiveBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/me/private-live/key", {
        method: "POST",
        headers: { Authorization: "Bearer " + props.sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          consent: true,
          shareWithFaction: true,
          includeNetworth: privateLiveIncludeNetworth,
          consentVersion: "faction-private-live-v1",
        }),
      })
      const payload = await response.json() as { error?: string; lastFour?: string; includeNetworth?: boolean; warning?: string | null }
      if (!response.ok) throw new Error(payload.error || "Could not connect your private live Torn key.")
      setPrivateLiveConsent(false)
      await loadPrivateLiveStatus()
      setAccountNotice(payload.warning || "Your saved portal key was owner-verified and used to share your latest snapshot with Naughty Souls members.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not connect your private live Torn key.") }
    finally { setPrivateLiveBusy(false) }
  }

  const refreshPrivateLive = async () => {
    if (privateLiveBusy || !privateLiveStatus?.connected) return
    setPrivateLiveBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/me/private-live/refresh", {
        method: "POST",
        headers: { Authorization: "Bearer " + props.sessionToken },
      })
      const payload = await response.json() as { error?: string; warning?: string | null }
      if (!response.ok) throw new Error(payload.error || "Could not refresh private live data.")
      await loadPrivateLiveStatus()
      setAccountNotice(payload.warning || "Your latest bars and cooldowns were refreshed.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not refresh private live data.") }
    finally { setPrivateLiveBusy(false) }
  }

  const disconnectPrivateLive = async () => {
    if (privateLiveBusy || !privateLiveStatus?.connected) return
    if (!window.confirm("Disconnect your private live Torn key? This deletes the encrypted key and removes your current faction-shared bars, cooldowns and optional networth snapshot.")) return
    setPrivateLiveBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/me/private-live/key", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + props.sessionToken },
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not disconnect your private live key.")
      await loadPrivateLiveStatus()
      setPrivateLiveIncludeNetworth(false)
      setAccountNotice("Your private live key and current faction-shared snapshot were deleted.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not disconnect your private live key.") }
    finally { setPrivateLiveBusy(false) }
  }

  const refreshCompanies = async () => {
    const response = await fetch(props.apiBase + "/api/me/companies", { headers: { Authorization: "Bearer " + props.sessionToken } })
    const payload = await response.json() as { error?: string; companies?: SavedCompanySummary[] }
    if (!response.ok) throw new Error(payload.error || "Could not refresh your company connections.")
    const companies = payload.companies || []
    props.onCompaniesChanged(companies)
    return companies
  }

  const replaceLoginKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!loginKey.trim() || loginBusy) return
    setLoginBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/auth/key", {
        method: "POST",
        headers: { Authorization: "Bearer " + props.sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: loginKey.trim() }),
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not update your faction login key.")
      setLoginKey("")
      props.onLoginKeyChanged(true)
      setAccountNotice("Your faction login key was validated and replaced.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not update your faction login key.") }
    finally { setLoginBusy(false) }
  }

  const addCompanyKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (companyBusy) return
    setCompanyBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/auth/company-key", {
        method: "POST",
        headers: { Authorization: "Bearer " + props.sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const payload = await response.json() as { error?: string; companyId?: string | number; companyName?: string }
      if (!response.ok) throw new Error(payload.error || "Could not validate this company API key.")
      await refreshCompanies()
      setAccountNotice((payload.companyName || "Company connection") + " was validated and saved to your account.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not add this company API key.") }
    finally { setCompanyBusy(false) }
  }

  const addSecondaryCompanyKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!secondaryCompanyKey.trim() || companyBusy) return
    setCompanyBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/auth/company-key", {
        method: "POST",
        headers: { Authorization: "Bearer " + props.sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: secondaryCompanyKey.trim() }),
      })
      const payload = await response.json() as { error?: string; companyId?: string | number; companyName?: string }
      if (!response.ok) throw new Error(payload.error || "Could not validate this secondary company key.")
      setSecondaryCompanyKey("")
      await refreshCompanies()
      setAccountNotice((payload.companyName || "Company #" + payload.companyId) + " was added using a secondary company key.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not add the secondary company key.") }
    finally { setCompanyBusy(false) }
  }

  const removeCompanyKey = async (company: SavedCompanySummary) => {
    if (!company.can_remove_key || companyBusy) return
    if (!window.confirm("Remove the secondary API key for " + (company.company_name || "Company #" + company.company_id) + "? Saved company records and history will remain.")) return
    setCompanyBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/auth/company-key?companyId=" + encodeURIComponent(company.company_id), {
        method: "DELETE",
        headers: { Authorization: "Bearer " + props.sessionToken },
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not remove the secondary company key.")
      await refreshCompanies()
      setAccountNotice("The secondary company key was removed. Saved company records and history were retained.")
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not remove the secondary company key.") }
    finally { setCompanyBusy(false) }
  }

  const signOutEverywhere = async () => {
    if (sessionBusy) return
    if (!window.confirm("Sign out this account on every device? This will end your current session too.")) return
    setSessionBusy(true); setAccountError(""); setAccountNotice("")
    try {
      const response = await fetch(props.apiBase + "/api/auth/sign-out-all", {
        method: "POST",
        headers: { Authorization: "Bearer " + props.sessionToken },
      })
      const payload = await response.json() as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not revoke account sessions.")
      props.onSignOut()
    } catch (caught) { setAccountError(caught instanceof Error ? caught.message : "Could not revoke account sessions.") }
    finally { setSessionBusy(false) }
  }

  const connectedCompanies = props.companies.filter(company => company.has_api_key === true)
  return (
    <main className="module-page settings-module">
      <header className="module-topbar"><a className="portal-brand" href="/" onClick={(event) => { event.preventDefault(); props.onNavigate("/") }}><span className="portal-brand-mark">NF</span><span><strong>NAUGHTY FAMILY</strong><small>ACCOUNT SETTINGS</small></span></a><button type="button" onClick={() => props.onNavigate("/")}>← Return to portal</button></header>
      <section className="module-heading"><div className="portal-eyebrow"><span /> PERSONAL ACCOUNT</div><h1>Account <em>Settings</em></h1><p>Manage the connections and security settings attached to your own Torn account. Credentials remain private to your player ID.</p></section>
      <section className="settings-member-card"><span className="portal-user-avatar">{props.playerName.slice(0, 2).toUpperCase() || "NS"}</span><div><strong>{props.playerName}</strong><small>Torn ID {props.playerId} · Naughty Souls member</small></div><span className="settings-badge">AUTHENTICATED</span></section>
      {accountError && <p className="settings-feedback error" role="alert">{accountError}</p>}
      {accountNotice && <p className="settings-feedback success" role="status">{accountNotice}</p>}
      <section className="settings-grid">
        <article className="settings-card settings-card-wide">
          <div className="settings-card-icon">⌘</div><small>IDENTITY & MEMBERSHIP</small><h2>Portal API key</h2>
          <p>Your single Torn key verifies your identity and Naughty Souls membership, and is reused across company data, private live status and optional Halloween collection. Use the recommended Custom Access key or a Full Access key. Replacements must belong to this same Torn player.</p>
          <span className={props.loginKeySaved ? "settings-connection good" : "settings-connection"}><i /> {props.loginKeySaved ? "Saved securely" : "Not saved"}</span>
          <form className="settings-inline-form" onSubmit={replaceLoginKey}>
            <label htmlFor="settings-login-key">Replace portal API key</label>
            <input id="settings-login-key" type="password" autoComplete="off" spellCheck={false} value={loginKey} onChange={event => setLoginKey(event.target.value)} placeholder="Paste your own Custom Access or Full Access key" disabled={loginBusy} />
            <button type="submit" disabled={loginBusy || !loginKey.trim()}>{loginBusy ? "Validating…" : "Validate & replace portal key"}</button>
            <span className="settings-form-hint">The key is validated against your Torn player ID and current faction membership before being saved.</span>
          </form>
        </article>
        <article className="settings-card settings-card-wide">
          <div className="settings-card-icon">▦</div><small>COMPANY WORKSPACE</small><h2>Company API connections</h2>
          <p>Your primary portal key is tried first for your company. When you own multiple companies or need different access, add a secondary key for each additional company. Secondary keys are encrypted, checked against your Torn account owner ID, and used only for the matching company.</p>
          <div className="settings-connection good"><i /> {connectedCompanies.length} company connection{connectedCompanies.length === 1 ? "" : "s"} saved</div>
          <form className="settings-inline-form" onSubmit={addCompanyKey}>
            <button type="submit" disabled={companyBusy}>{companyBusy ? "Connecting…" : "Connect company using portal key"}</button>
          </form>
          <form className="settings-inline-form" onSubmit={addSecondaryCompanyKey}>
            <label htmlFor="settings-secondary-company-key">Add a secondary company API key</label>
            <input id="settings-secondary-company-key" type="password" autoComplete="off" spellCheck={false} value={secondaryCompanyKey} onChange={event => setSecondaryCompanyKey(event.target.value)} placeholder="Paste a key for another company you own" disabled={companyBusy} />
            <button type="submit" disabled={companyBusy || !secondaryCompanyKey.trim()}>{companyBusy ? "Validating…" : "Validate & add secondary key"}</button>
            <span className="settings-form-hint">Use one secondary key per additional company. The key must belong to Torn ID {props.playerId} and return that company's profile.</span>
          </form>
          <div className="settings-company-list">
            {connectedCompanies.length ? connectedCompanies.map(company => (
              <div className="settings-company-row" key={company.company_id}>
                <div><strong>{company.company_name || "Company #" + company.company_id}</strong><small>{company.company_type || "Company"} · ID {company.company_id} · {company.uses_portal_key ? "Portal key" : "Secondary key"}{company.key_last_four ? " •••• " + company.key_last_four : ""}</small></div>
                {company.can_remove_key && <button type="button" disabled={companyBusy} onClick={() => void removeCompanyKey(company)}>{companyBusy ? "Working…" : "Remove secondary key"}</button>}
              </div>
            )) : <p className="settings-form-hint">No company connections are saved yet. Connect your primary company or add a secondary company key.</p>}
          </div>
          <button type="button" className="settings-link-button" onClick={() => props.onNavigate("/company")}>Open Company Dashboard →</button>
        </article>
        <article className="settings-card settings-card-wide settings-private-live-card">
          <div className="settings-card-icon">◉</div><small>FACTION LIVE MEMBER STATUS</small><h2>Private live Torn connection</h2>
          <p>Use your saved portal API key to read your own bars and cooldowns. Its owner is verified against your signed-in Torn ID. The key itself is never shared; only your latest live snapshot is shared with authenticated Naughty Souls members.</p>
          <span className={privateLiveStatus?.connected ? "settings-connection good" : "settings-connection"}><i /> {privateLiveStatus?.connected ? "Connected securely · •••• " + (privateLiveStatus.key?.lastFour || "••••") : privateLiveStatus ? "Not connected" : "Checking connection…"}</span>
          {privateLiveStatus?.connected && <div className="settings-private-live-meta">
            <span>Last snapshot <strong>{privateLiveStatus.snapshot?.capturedAt ? new Date(privateLiveStatus.snapshot.capturedAt).toLocaleString() : "Not available"}</strong></span>
            <span>Optional networth <strong>{privateLiveStatus.key?.includeNetworth ? "Enabled" : "Off"}</strong></span>
            {privateLiveStatus.key?.lastError && <span className="settings-private-live-warning">Last refresh issue: {privateLiveStatus.key.lastError}</span>}
          </div>}
          <div className="settings-private-live-disclosure">
            <table><tbody>
              <tr><th>Data storage</th><td>Only the latest bars, cooldowns and optionally networth snapshot are retained while connected. No historical live-data archive is created.</td></tr>
              <tr><th>Data sharing</th><td>Latest snapshot is visible to authenticated current Naughty Souls faction members. Your API key is not shared.</td></tr>
              <tr><th>Purpose</th><td>Faction live-status display and member coordination. Optional detailed networth is a separate opt-in.</td></tr>
              <tr><th>Key storage & sharing</th><td>Encrypted at rest; used by the API Worker only to request data belonging to your own Torn account.</td></tr>
              <tr><th>Key access level</th><td>The key must successfully return your own bars and cooldowns. Only those selections are requested. Detailed networth is requested only when you separately enable it and Torn confirms access.</td></tr>
            </tbody></table>
          </div>
          <form className="settings-inline-form" onSubmit={connectPrivateLiveKey}>
            <p>Your saved portal API key will be used for this connection. No second key is required.</p>
            <label className="settings-private-live-check"><input type="checkbox" checked={privateLiveIncludeNetworth} onChange={event => setPrivateLiveIncludeNetworth(event.target.checked)} disabled={privateLiveBusy} /><span>Also share my detailed networth breakdown with the faction. This is optional and is not requested unless checked.</span></label>
            <label className="settings-private-live-check"><input type="checkbox" checked={privateLiveConsent} onChange={event => setPrivateLiveConsent(event.target.checked)} disabled={privateLiveBusy} /><span>I consent to encrypted storage of my own key and sharing my latest bars/cooldowns with authenticated Naughty Souls members. I understand disconnecting deletes the key and current shared snapshot. I have reviewed the data-use terms above.</span></label>
            <button type="submit" disabled={privateLiveBusy || !privateLiveConsent}>{privateLiveBusy ? "Connecting…" : privateLiveStatus?.connected ? "Reconnect using portal key" : "Connect using portal key"}</button>
            <span className="settings-form-hint">These sharing choices apply when you connect or reconnect using your saved portal key. The Worker verifies the key owner and requests only the selected private endpoints. Custom Access keys must include Bars and Cooldowns; detailed Networth is requested only when separately enabled. Connect and refresh attempts share a 30-second server-side request limit.</span>
          </form>
          {privateLiveStatus?.connected && <div className="settings-private-live-actions">
            <button type="button" disabled={privateLiveBusy} onClick={() => void refreshPrivateLive()}>{privateLiveBusy ? "Working…" : "Refresh my live data ↻"}</button>
            <button type="button" disabled={privateLiveBusy} onClick={() => void disconnectPrivateLive()}>Disconnect & delete snapshot</button>
          </div>}
        </article>
        <article className="settings-card">
          <div className="settings-card-icon">♧</div><small>HALLOWEEN ARCHIVE</small><h2>Halloween historical collection</h2>
          <p>Historical collection reuses your saved portal key, if it includes User → Log access and you opt in.</p>
          <span className="settings-connection"><i /> Managed in Halloween workspace</span>
          <button type="button" onClick={() => props.onNavigate("/halloween")}>Open Halloween settings →</button>
        </article>
        <article className="settings-card">
          <div className="settings-card-icon">◈</div><small>ACCOUNT SECURITY</small><h2>Sessions & access</h2>
          <p>Revoke all active sessions when you suspect another device may still have access. You will be signed out here as well.</p>
          <span className="settings-connection good"><i /> Member session active</span>
          <button type="button" disabled={sessionBusy} onClick={() => void signOutEverywhere()}>{sessionBusy ? "Revoking sessions…" : "Sign out on all devices"}</button>
        </article>
      </section>
      <footer className="module-footer"><span>ACCOUNT SETTINGS</span><button type="button" onClick={props.onSignOut}>Sign out</button></footer>
    </main>
  )
}