import { useEffect, useMemo, useRef, useState } from "react"
import type { ChristmasTownItemMetric, ChristmasTownMetrics } from "../../lib/christmas-town/metrics"

type ChristmasTownWorkspaceProps = {
  playerName: string
  onNavigate: (path: string) => void
  apiBase: string
  sessionToken: string
}

type ChristmasTownKeyStatus = {
  connected: boolean
  previouslyConsented: boolean
  key?: {
    lastFour: string
    accessLevel: string
    consentVersion: string
    consentedAt: string
    lastValidatedAt: string
  } | null
}

type ChristmasTownCollectionJob = {
  eventYear: number
  status: string
  pagesCollected: number
  logsCollected: number
  lastError: string | null
  windowStartAt: string
  windowEndAt: string
  updatedAt: string
}

type ChristmasTownArchivePayload = {
  fromDate: string
  toDate: string
  metrics: ChristmasTownMetrics
  market: {
    status: string
    snapshotAt: number | null
    pricedItemCount: number
    itemCount: number
    unpricedItemCount: number
  }
  collection: ChristmasTownCollectionJob[]
}

const todayUtc = () => new Date().toISOString().slice(0, 10)

function christmasTownAvailableYears(): number[] {
  const today = todayUtc()
  const currentYear = Number(today.slice(0, 4))
  const latestYear = today >= currentYear + "-12-10" ? currentYear : currentYear - 1
  return Array.from({ length: Math.max(0, latestYear - 2021 + 1) }, (_, index) => 2021 + index)
}

function christmasTownDateRange(yearScope: string): { from: string; to: string } {
  const today = todayUtc()
  if (yearScope === "all") return { from: "2021-12-10", to: today }
  const year = Number(yearScope)
  const seasonEnd = year + "-12-31"
  return { from: year + "-12-10", to: seasonEnd > today ? today : seasonEnd }
}
const formatMoney = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : "$" + Math.round(value).toLocaleString()
const formatCount = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString()
const formatStamp = (timestamp: number | null | undefined) =>
  timestamp === null || timestamp === undefined ? "—" : new Date(timestamp * 1000).toLocaleString()

const itemGroups: Array<{ key: ChristmasTownItemMetric["group"]; label: string }> = [
  { key: "chest", label: "Chest rewards" },
  { key: "minigame", label: "Minigame rewards" },
  { key: "santa", label: "Santa & Grotto" },
  { key: "present", label: "Presents & gifts" },
  { key: "coupon", label: "Prize coupon exchanges" },
  { key: "wheel", label: "Wheel rewards" },
  { key: "pot", label: "Christmas Town pot" },
  { key: "other", label: "Other finds" },
]

function christmasTownSeasonRows(fromDate: string, toDate: string, jobs: ChristmasTownCollectionJob[]) {
  const startMs = Date.parse(fromDate + "T00:00:00Z")
  const endMs = Date.parse(toDate + "T00:00:00Z") + 86400000
  const byYear = new Map(jobs.map(job => [job.eventYear, job]))
  const firstYear = Math.max(2021, new Date(startMs).getUTCFullYear() - 1)
  const lastYear = new Date(endMs).getUTCFullYear()
  const seasons: Array<{ year: number; status: string; job?: ChristmasTownCollectionJob }> = []
  for (let year = firstYear; year <= lastYear; year++) {
    const seasonStart = Date.UTC(year, 11, 1)
    const seasonEnd = Date.UTC(year + 1, 0, 1)
    if (seasonEnd <= startMs || seasonStart >= endMs) continue
    const job = byYear.get(year)
    seasons.push({ year, status: job?.status ?? "not_collected", job })
  }
  return seasons
}

function SeasonCollectionStatus({
  fromDate,
  toDate,
  jobs,
}: {
  fromDate: string
  toDate: string
  jobs: ChristmasTownCollectionJob[]
}) {
  const seasons = christmasTownSeasonRows(fromDate, toDate, jobs)
  if (!seasons.length) return <p className="christmas-town-muted">No Christmas Town season falls inside this date range.</p>
  return (
    <div className="christmas-town-season-list">
      {seasons.map(season => (
        <div className="christmas-town-season-row" key={season.year}>
          <strong>{season.year} season</strong>
          <span className={"christmas-town-state " + season.status.replace(/[^a-z_]/g, "")}>{season.status.replace(/_/g, " ")}</span>
          <small>{season.job ? season.job.logsCollected.toLocaleString() + " logs · " + season.job.pagesCollected.toLocaleString() + " pages" : "Not collected"}</small>
        </div>
      ))}
    </div>
  )
}

function rewardLines(
  rewardsById: Record<string, number>,
  itemNames: Map<string, string>,
): Array<{ id: string; name: string; quantity: number }> {
  return Object.entries(rewardsById)
    .map(([id, quantity]) => ({ id, name: itemNames.get(id) ?? "Item #" + id, quantity }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const CHRISTMAS_GAME_GLYPHS: Record<string, string> = {
  present_pick: "🎁", spin_the_wheel: "🎡", garland_assemble: "🎀", santa_claws: "🧑‍🎄",
  gingerbread_men: "🍪", word_fixer: "🔤", hangman: "🧩", christmas_wreath: "❄",
  snowball_shooter: "☃", typocalypse: "⌨",
}
function christmasTownGameGlyph(key: string): string { return CHRISTMAS_GAME_GLYPHS[key] ?? "✦" }
function christmasTownOrnamentGlyph(name: string): string {
  const value = name.toLowerCase()
  if (/(tree|pine|fir)/.test(value)) return "🎄"
  if (/(wreath|garland)/.test(value)) return "❇"
  if (/(snow|frost|ice)/.test(value)) return "❄"
  if (/(gift|present|box)/.test(value)) return "🎁"
  if (/(bell|chime)/.test(value)) return "🔔"
  if (/(star|angel)/.test(value)) return "✧"
  if (/(candy|cane|sweet)/.test(value)) return "🍬"
  if (/(santa|snowman)/.test(value)) return "☃"
  return "✦"
}
export function ChristmasTownWorkspace({
  playerName,
  onNavigate,
  apiBase,
  sessionToken,
}: ChristmasTownWorkspaceProps) {
  const [selectedYear, setSelectedYear] = useState("all")
  const availableYears = christmasTownAvailableYears()
  const { from: appliedFromDate, to: appliedToDate } = christmasTownDateRange(selectedYear)
  const [keyStatus, setKeyStatus] = useState<ChristmasTownKeyStatus | null>(null)
  const [archive, setArchive] = useState<ChristmasTownArchivePayload | null>(null)
  const [archiveLoadedRange, setArchiveLoadedRange] = useState("")
  const automaticCollectionKeyRef = useRef("")
  const [busy, setBusy] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [collectBusy, setCollectBusy] = useState(false)
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")

  const loadKeyStatus = async () => {
    const response = await fetch(apiBase + "/api/me/christmas-town/key", {
      headers: { Authorization: "Bearer " + sessionToken },
    })
    const payload = await response.json() as ChristmasTownKeyStatus & { error?: string }
    if (!response.ok) throw new Error(payload.error || "Could not load Christmas Town history permission.")
    setKeyStatus(payload)
  }

  const loadArchive = async (from = appliedFromDate, to = appliedToDate) => {
    setBusy(true)
    setError("")
    try {
      const response = await fetch(
        apiBase + "/api/me/christmas-town/archive?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to),
        { headers: { Authorization: "Bearer " + sessionToken } },
      )
      const payload = await response.json() as ChristmasTownArchivePayload & { error?: string }
      if (!response.ok) throw new Error(payload.error || "Could not load your Christmas Town archive.")
      setArchive(payload)
      setArchiveLoadedRange(from + "|" + to)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your Christmas Town archive.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void loadKeyStatus().catch(caught => setError(caught instanceof Error ? caught.message : "Could not load history permission."))
  }, [apiBase, sessionToken])

  useEffect(() => {
    void loadArchive(appliedFromDate, appliedToDate)
  }, [apiBase, sessionToken, appliedFromDate, appliedToDate])

  const enableHistory = async () => {
    if (!consent || keyBusy) return
    setKeyBusy(true)
    setError("")
    setMessage("")
    try {
      const response = await fetch(apiBase + "/api/me/christmas-town/key", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, consentVersion: "christmas-town-history-v1" }),
      })
      const payload = await response.json() as { error?: string; saved?: boolean; lastFour?: string; accessLevel?: string }
      if (!response.ok) throw new Error(payload.error || "Could not enable Christmas Town history.")
      setConsent(false)
      setMessage("Christmas Town history is enabled with your saved portal API key ending in " + (payload.lastFour ?? "••••") + ".")
      await Promise.all([loadKeyStatus(), loadArchive()])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not enable Christmas Town history.")
    } finally {
      setKeyBusy(false)
    }
  }

  const collectHistory = async (from = appliedFromDate, to = appliedToDate, automatic = false) => {
    if (collectBusy) return
    setCollectBusy(true)
    setError("")
    setMessage("")
    try {
      const response = await fetch(apiBase + "/api/me/christmas-town/collect", {
        method: "POST",
        headers: { Authorization: "Bearer " + sessionToken, "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate: from, toDate: to }),
      })
      const payload = await response.json() as {
        error?: string
        queued?: boolean
        jobs?: Array<{ eventYear: number; status: string; logsCollected: number }>
      }
      if (!response.ok) throw new Error(payload.error || "Could not start Christmas Town collection.")
      const queued = (payload.jobs ?? []).filter(job => job.status === "queued").length
      setMessage(queued
        ? automatic
          ? "Collection automatically started for Christmas Town " + (selectedYear === "all" ? "seasons" : selectedYear) + ". Progress will appear here as Torn logs are processed."
          : "Queued " + queued.toLocaleString() + " Christmas Town season(s) for collection. Progress will appear here as the logs are processed."
        : "The selected Christmas Town seasons are already up to date.")
      await loadArchive(from, to)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start Christmas Town collection.")
    } finally {
      setCollectBusy(false)
    }
  }

  useEffect(() => {
    if (selectedYear === "all" || !keyStatus?.connected || busy || collectBusy || keyBusy ||
        archiveLoadedRange !== appliedFromDate + "|" + appliedToDate || !archive) return
    const year = Number(selectedYear)
    if (!Number.isInteger(year)) return
    const job = archive.collection.find(item => item.eventYear === year)
    const expectedStart = new Date(Date.UTC(year, 11, 1)).toISOString()
    const expectedEnd = new Date(Date.UTC(year + 1, 0, 1)).toISOString()
    if (job?.status === "complete" && job.windowStartAt === expectedStart && job.windowEndAt === expectedEnd) return
    if (job && (job.status === "queued" || job.status === "running")) return
    const requestKey = year + ":" + (keyStatus.key?.consentedAt ?? keyStatus.key?.lastValidatedAt ?? "")
    if (automaticCollectionKeyRef.current === requestKey) return
    automaticCollectionKeyRef.current = requestKey
    // The authenticated endpoint reuses an active/completed job and queues only an
    // incomplete or failed season. All-time remains opt-in to avoid bulk collection.
    void collectHistory(appliedFromDate, appliedToDate, true)
  }, [selectedYear, keyStatus?.connected, keyStatus?.key?.consentedAt,
    archive, busy, collectBusy, keyBusy, archiveLoadedRange, appliedFromDate, appliedToDate])

  const metrics = archive?.metrics ?? null
  const itemNames = useMemo(() => new Map([
    ...Object.entries(metrics?.itemNamesById ?? {}),
    ...(metrics?.items ?? []).map(item => [item.itemId, item.itemName] as [string, string]),
  ]), [metrics?.itemNamesById, metrics?.items])
  const groupedItems = useMemo(() => itemGroups.map(group => ({
    ...group,
    items: (metrics?.items ?? []).filter(item => item.group === group.key),
  })).filter(group => group.items.length > 0), [metrics?.items])
  const estimateLabel = metrics?.estimatedValue === null || !metrics
    ? "—"
    : (metrics.unpricedItems > 0 ? "At least ≈ " : "≈ ") + formatMoney(metrics.estimatedValue)
  const marketFreshness = archive?.market.snapshotAt
    ? (archive.market.status === "stale" ? "Market data may be stale · " : "Oldest market snapshot ") + formatStamp(archive.market.snapshotAt)
    : "Market snapshot unavailable"
  const selectedSeasonRows = useMemo(
    () => christmasTownSeasonRows(appliedFromDate, appliedToDate, archive?.collection ?? []),
    [appliedFromDate, appliedToDate, archive?.collection],
  )
  const allSelectedSeasonsComplete = selectedSeasonRows.length > 0 && selectedSeasonRows.every(season => season.status === "complete")
  const noConfirmedActivity = Boolean(metrics && metrics.logCount === 0 && !allSelectedSeasonsComplete)

  return (
    <main className="module-page christmas-town-module">
      <header className="module-topbar">
        <a className="portal-brand" href="/" onClick={event => { event.preventDefault(); onNavigate("/") }}>
          <span className="portal-brand-mark">NF</span>
          <span><strong>NAUGHTY FAMILY</strong><small>EVENT ARCHIVE</small></span>
        </a>
        <button type="button" onClick={() => onNavigate("/")}>← Return to portal</button>
      </header>

      <section className="module-heading christmas-town-heading">
        <div className="portal-eyebrow"><span /> NAUGHTY SOULS · CHRISTMAS TOWN</div>
        <h1>Christmas <em>Town</em></h1>
        <p>Your personal Christmas Town history, rewards, chest openings, minigames and item values across the event seasons recorded by Torn.</p>
      </section>

      <section className="halloween-year-filter christmas-town-year-filter" aria-label="Christmas Town historical scope">
        <div>
          <small>CHRISTMAS TOWN HISTORY SCOPE</small>
          <strong>{selectedYear === "all" ? "All time" : "Christmas Town " + selectedYear}</strong>
          <span>Showing {appliedFromDate} – {appliedToDate} · UTC</span>
        </div>
        <label htmlFor="christmas-town-year">Display
          <select id="christmas-town-year" value={selectedYear} onChange={event => { automaticCollectionKeyRef.current = ""; setSelectedYear(event.target.value) }} disabled={busy}>
            <option value="all">All time</option>
            {availableYears.map(year => <option key={year} value={String(year)}>{year}</option>)}
          </select>
        </label>
      </section>

      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      {message && <p className="settings-feedback success" role="status">{message}</p>}

      {keyStatus && !keyStatus.previouslyConsented && (
        <section className="christmas-town-permission christmas-town-consent">
          <div>
            <small>INITIAL CHRISTMAS TOWN HISTORY CONSENT</small>
            <h2>Connect your personal event history</h2>
            <p>With your one-time initial permission, the portal will use your saved Torn API key to read the Christmas Town part of your User → Log history for the selected seasons. The key remains encrypted, logs are stored in your personal archive, and this data is not shared in faction reports. No second API key is needed. After initial consent, manage this connection from Account Settings.</p>
            <label className="christmas-town-consent-check">
              <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />
              <span>I consent to collecting and storing my personal Christmas Town event logs for this dashboard.</span>
            </label>
          </div>
          <button type="button" onClick={() => void enableHistory()} disabled={!consent || keyBusy}>{keyBusy ? "Enabling…" : "Enable Christmas Town history"}</button>
        </section>
      )}
      {keyStatus?.previouslyConsented && !keyStatus.connected && (
        <section className="christmas-town-permission">
          <div>
            <small>PERSONAL HISTORY COLLECTION</small>
            <span>Christmas Town collection is currently disabled. Manage or re-enable it in Account Settings.</span>
          </div>
          <button type="button" onClick={() => onNavigate("/settings")}>Open Account Settings</button>
        </section>
      )}

      <section className="christmas-town-collection">
        <div>
          <div className="christmas-town-section-kicker">EVENT SEASON COVERAGE</div>
          <h2>Historical collection</h2>
          <p>Christmas Town logs are collected only during December for each year that overlaps your selected date range. The 1–31 December collection window covers years when the event starts at different times in mid-December.</p>
          {archive && <SeasonCollectionStatus fromDate={appliedFromDate} toDate={appliedToDate} jobs={archive.collection} />}
        </div>
        <div className="christmas-town-collection-actions">
          <button type="button" className="secondary" onClick={() => void loadArchive()} disabled={busy}>Refresh stats ↻</button>
          <button type="button" onClick={() => void collectHistory()} disabled={!keyStatus?.connected || collectBusy}>
            {collectBusy ? "Queueing…" : "Collect selected seasons ↻"}
          </button>
        </div>
      </section>

      {busy && !archive ? <p className="christmas-town-loading">Loading your Christmas Town archive…</p> : noConfirmedActivity ? (
        <section className="christmas-town-panel christmas-town-empty">
          <h2>{selectedSeasonRows.length ? "Collection is needed for this date range" : "No Christmas Town season in this date range"}</h2>
          <p>{selectedSeasonRows.length
            ? "No activity is stored yet for this range, and collection is not complete. Start the seasonal collection above. Until every relevant season is complete, empty counters are not treated as confirmed zeroes."
            : "The selected dates do not overlap a Christmas Town seasonal window. Choose dates that include the December / January event period to see event activity."}</p>
        </section>
      ) : metrics ? (
        <>
          <section className="christmas-town-summary">
            <article><small>DAYS</small><strong>{formatCount(metrics.days)}</strong><span>Across recorded activity</span></article>
            <article><small>ITEMS</small><strong>{formatCount(metrics.totalItems)}</strong><span>{formatCount(metrics.totalPricedItems)} priced · {formatCount(metrics.unpricedItems)} without a quote</span></article>
            <article className="christmas-town-summary-value"><small>ESTIMATED ITEM VALUE</small><strong>{estimateLabel}</strong><span>Priced reward items only</span></article>
            <article><small>VALUE / DAY</small><strong>{formatMoney(metrics.estimatedValuePerDay)}</strong><span>Average across recorded days</span></article>
            <article><small>VALUE / ITEM</small><strong>{formatMoney(metrics.estimatedValuePerItem)}</strong><span>Priceless / unpriced items excluded</span></article>
          </section>
          {!allSelectedSeasonsComplete && <p className="christmas-town-coverage-note">PARTIAL HISTORY · The figures below include only currently collected records. Any zeroes in this range remain provisional until all listed Christmas Town seasons show Complete.</p>}
          <p className="christmas-town-provenance">{marketFreshness}. This estimate uses Torn's globally cached item-market average prices, not live player listings. Missing prices are excluded rather than treated as zero.</p>

          <section className="christmas-town-panel">
            <div className="christmas-town-panel-heading"><div><div className="christmas-town-section-kicker">DAILY GAMES</div><h2>Minigames</h2></div><span>{formatCount(metrics.minigames.reduce((sum, game) => sum + game.count, 0))} recorded plays</span></div>
            <div className="christmas-town-game-grid christmas-town-game-grid-daily">
              {metrics.minigames.filter(game => ["present_pick", "spin_the_wheel"].includes(game.key)).map(game => (
                <article className={"christmas-town-game-tile christmas-town-game-" + game.key} key={game.key}>
                  <span className="christmas-town-game-art" aria-hidden="true">{christmasTownGameGlyph(game.key)}</span>
                  <div className="christmas-town-game-copy"><small>{game.label.toUpperCase()}</small><strong>{formatCount(game.count)}</strong><span>{game.key === "spin_the_wheel" ? "spins" : "picks"}</span></div>
                </article>
              ))}
            </div>
            <div className="christmas-town-panel-heading christmas-town-subheading"><div><div className="christmas-town-section-kicker">OTHER GAMES</div><h3>Season activity</h3></div></div>
            <div className="christmas-town-game-grid">
              {metrics.minigames.filter(game => !["present_pick", "spin_the_wheel"].includes(game.key)).map(game => (
                <article className={"christmas-town-game-tile christmas-town-game-" + game.key} key={game.key}>
                  <span className="christmas-town-game-art" aria-hidden="true">{christmasTownGameGlyph(game.key)}</span>
                  <div className="christmas-town-game-copy"><small>{game.label.toUpperCase()}</small><strong>{formatCount(game.count)}</strong><span>wins / plays</span></div>
                </article>
              ))}
            </div>
          </section>

          <section className="christmas-town-overview-grid">
            <article className="christmas-town-panel">
              <div className="christmas-town-section-kicker">HATS & DECORATION</div><h2>Hats</h2>
              <div className="christmas-town-big-number"><strong>{formatCount(metrics.hatsAdded)}</strong><span>hats added</span></div>
              {Object.entries(metrics.hatNames).length
                ? <div className="christmas-town-name-list">{Object.entries(metrics.hatNames).sort((a,b)=>b[1]-a[1]).map(([name,count])=><div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div>
                : <p className="christmas-town-muted">No named hat additions were identified in the selected logs.</p>}
            </article>
            <article className="christmas-town-panel">
              <div className="christmas-town-section-kicker">SANTA'S GROTTO</div><h2>Santa visits</h2>
              <div className="christmas-town-big-number"><strong>{formatCount(metrics.santaVisits)}</strong><span>visits</span></div>
              <p className="christmas-town-muted">Gift / present events: {formatCount(metrics.gifts)} · Other item finds: {formatCount(metrics.itemFinds)}</p>
            </article>

          </section>

          <section className="christmas-town-collectibles-grid">
            <article className="christmas-town-panel christmas-town-ornament-panel">
              <div className="christmas-town-panel-heading">
                <div><div className="christmas-town-section-kicker">ORNAMENT COLLECTION</div><h2>Decorations added</h2></div>
                <span>{formatCount(metrics.ornamentsAdded)} added</span>
              </div>
              <div className="christmas-town-ornament-summary">
                <strong>{formatCount(metrics.ornamentsAdded)}</strong>
                <div><span>ornaments added</span><small>{formatCount(metrics.ornamentsBought)} bought · {formatCount(metrics.ornamentsOther)} other finds</small></div>
              </div>
              {Object.entries(metrics.ornaments).length
                ? <div className="christmas-town-ornament-grid">
                    {Object.entries(metrics.ornaments).sort((a,b)=>b[1]-a[1]).map(([name,count], index) => (
                      <div className={"christmas-town-ornament-tile christmas-town-ornament-tone-" + (index % 6)} key={name}>
                        <span aria-hidden="true">{christmasTownOrnamentGlyph(name)}</span>
                        <strong>{name}</strong>
                        <small>×{formatCount(count)}</small>
                      </div>
                    ))}
                  </div>
                : <p className="christmas-town-muted">No ornament additions were identified in the selected logs.</p>}
            </article>
            <article className="christmas-town-panel christmas-town-keys-panel">
              <div className="christmas-town-section-kicker">CHEST KEYS</div><h2>Keys found</h2>
              <div className="christmas-town-key-total">
                <strong>{formatCount(metrics.keysFound.bronze + metrics.keysFound.silver + metrics.keysFound.gold)}</strong>
                <span>keys found</span>
              </div>
              <div className="christmas-town-key-list">
                {([
                  ["bronze", "Bronze", "♙"],
                  ["silver", "Silver", "⚿"],
                  ["gold", "Gold", "🗝"],
                ] as const).map(([key, label, glyph]) => (
                  <div className={"christmas-town-key-row christmas-town-key-" + key} key={key}>
                    <span aria-hidden="true">{glyph}</span><strong>{label}</strong><b>{formatCount(metrics.keysFound[key])}</b>
                  </div>
                ))}
              </div>
            </article>
          </section>

          <section className="christmas-town-panel">
            <div className="christmas-town-panel-heading"><div><div className="christmas-town-section-kicker">CHEST REWARDS</div><h2>Chests</h2></div><span>{formatCount(metrics.chests.reduce((sum,chest)=>sum+chest.opened,0))} opened</span></div>
            <div className="christmas-town-chest-grid">
              {metrics.chests.map(chest => (
                <article className="christmas-town-chest-card" key={chest.key}>
                  <div className="christmas-town-chest-heading"><div><small>{chest.label.toUpperCase()}</small><strong>{formatCount(chest.opened)} opened</strong></div><span>{formatCount(chest.items)} items</span></div>
                  <div className="christmas-town-chest-value">{formatMoney(chest.estimatedValue)}</div>
                  <div className="christmas-town-chest-rates"><span>{formatMoney(chest.valuePerChest)} / chest</span><span>{formatMoney(chest.valuePerItem)} / item</span></div>
                  <div className="christmas-town-best-worst">
                    {(["best","worst"] as const).map(kind => {
                      const event = chest[kind]
                      return <div key={kind}>
                        <small>{kind.toUpperCase()}</small>
                        {event ? <>
                          <strong>{formatStamp(event.timestamp)}</strong>
                          <b>{formatMoney(event.estimatedValue)}</b>
                          <ul>{rewardLines(event.rewardsById,itemNames).map(item=><li key={item.id}>{item.name} <span>×{item.quantity}</span></li>)}</ul>
                        </> : <span className="christmas-town-muted">No priced chest event available</span>}
                      </div>
                    })}
                  </div>
                  <p className="christmas-town-footnote">Chest estimates exclude rewards with no usable market average. Ornaments and Christmas Bucks are shown separately where they can be identified.</p>
                </article>
              ))}
            </div>
          </section>

          <section className="christmas-town-overview-grid christmas-town-currency-grid">
            <article className="christmas-town-panel">
              <div className="christmas-town-section-kicker">CHRISTMAS BUCKS</div><h2>Season currency</h2>
              <div className="christmas-town-currency-pair">
                <div><small>GAINED</small><strong>{formatCount(metrics.christmasBucksGained)}</strong></div>
                <div><small>SPENT</small><strong>{formatCount(metrics.christmasBucksSpent)}</strong></div>
              </div>
              <div className="christmas-town-name-list">{Object.entries(metrics.christmasBucksSpentByItem).sort((a,b)=>b[1]-a[1]).map(([name,count])=><div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div>
              {!Object.keys(metrics.christmasBucksSpentByItem).length && <p className="christmas-town-muted">No item purchases were identified in the selected log records.</p>}
            </article>
            <article className="christmas-town-panel">
              <div className="christmas-town-section-kicker">PRIZE COUPONS</div><h2>Coupon exchanges</h2>
              <div className="christmas-town-coupon-summary">
                <div><small>GAINED</small><strong>{formatCount(metrics.prizeCouponsGained)}</strong></div>
                <div><small>EXCHANGED</small><strong>{formatCount(metrics.prizeCouponsSpent)}</strong></div>
                <div><small>EXCHANGES</small><strong>{formatCount(metrics.prizeCouponsExchanged)}</strong></div>
              </div>
              <div className="christmas-town-big-number"><strong>{formatCount(metrics.prizeCouponItems)}</strong><span>items received in logged exchanges</span></div>
              <div className="christmas-town-name-list">{Object.entries(metrics.prizeCouponItemsById).map(([id,count])=><div key={id}><span>{itemNames.get(id) ?? "Item #" + id}</span><strong>{count}</strong></div>)}</div>
            </article>
          </section>

          <section className="christmas-town-panel">
            <div className="christmas-town-panel-heading"><div><div className="christmas-town-section-kicker">CHRISTMAS TOWN POT</div><h2>Pot activity</h2></div><span>{formatCount(metrics.pot.roundsWon)} rounds won</span></div>
            <div className="christmas-town-pot-grid">
              <div><small>ITEMS DEPOSITED</small><strong>{formatCount(metrics.pot.itemsDeposited)}</strong><span>{formatMoney(metrics.pot.depositValue)} estimated deposited value</span></div>
              <div><small>ITEMS WON</small><strong>{formatCount(metrics.pot.itemsWon)}</strong><span>{formatMoney(metrics.pot.wonValue)} estimated won value</span></div>
            </div>
            <div className="christmas-town-pot-lists">
              <div><strong>Deposited items</strong>{rewardLines(metrics.potDepositedById,itemNames).map(item=><span key={item.id}>{item.name} ×{item.quantity}</span>)}</div>
              <div><strong>Won items</strong>{rewardLines(metrics.potWonById,itemNames).map(item=><span key={item.id}>{item.name} ×{item.quantity}</span>)}</div>
            </div>
          </section>

          <section className="christmas-town-panel">
            <div className="christmas-town-panel-heading"><div><div className="christmas-town-section-kicker">ITEM INVENTORY</div><h2>Received items</h2></div><span>{formatCount(metrics.totalItems)} recorded</span></div>
            {groupedItems.length ? <div className="christmas-town-item-groups">
              {groupedItems.map(group => (
                <div className="christmas-town-item-group" key={group.key}>
                  <h3>{group.label}</h3>
                  {group.items.sort((a,b)=>(b.estimatedValue ?? -1)-(a.estimatedValue ?? -1)).map(item => (
                    <div className="christmas-town-item-row" key={item.itemId}>
                      <div><strong>{item.itemName}</strong><small>{item.quantity.toLocaleString()} × {item.unitPrice === null ? "No usable market average" : formatMoney(item.unitPrice)}</small></div>
                      <strong>{formatMoney(item.estimatedValue)}</strong>
                    </div>
                  ))}
                </div>
              ))}
            </div> : <p className="christmas-town-muted">No received item IDs were identified in this date range.</p>}
            <p className="christmas-town-footnote">Market estimates cover item IDs identified in the stored logs. Missing item IDs, ornaments, Christmas Bucks and rewards without a usable market average are not assigned invented prices.</p>
          </section>
        </>
      ) : (
        <section className="christmas-town-panel christmas-town-empty">
          <h2>No Christmas Town records in this range yet</h2>
          <p>Enable your personal history permission, then collect the seasonal logs that overlap the selected dates. A true zero will be shown only after collection coverage is complete.</p>
        </section>
      )}

      <footer className="module-footer"><span>CHRISTMAS TOWN · PERSONAL ARCHIVE</span><span>Signed in as {playerName} · {archive?.metrics.logCount.toLocaleString() ?? "0"} stored relevant logs</span></footer>
    </main>
  )
}
