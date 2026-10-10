import { TornApiClient, TornApiClientError } from "../lib/torn/client"

type D1Result<T = Record<string, unknown>> = { results?: T[]; success?: boolean; meta?: { changes?: number } }
type D1Statement = { bind(...values: (string | number | null)[]): D1Statement; first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<D1Result<T>>; run(): Promise<D1Result> }
type D1Database = { prepare(sql: string): D1Statement }
type WorkerEnv = { ALLOWED_ORIGIN?: string; DB?: D1Database; KEY_ENCRYPTION_SECRET?: string }
type Session = { player_id: string; player_name: string }

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
const DAY = 86400

function jsonResponse(body: unknown, status = 200, origin = "null", extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", vary: "Origin", ...extraHeaders } })
}
function allowedOrigin(request: Request, env: WorkerEnv): string | null {
  const incoming = request.headers.get("Origin")
  if (!incoming) return "null"
  const configured = env.ALLOWED_ORIGIN?.trim()
  if (configured && configured !== "*" && incoming === configured) return incoming
  try {
    const url = new URL(incoming)
    const isDashboard = url.protocol === "https:" && /^(?:[a-z0-9-]+\.)?naughty-company-dashboard\.pages\.dev$/.test(url.hostname)
    const isLocalDev = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.port === "3000"
    return isDashboard || isLocalDev ? incoming : null
  } catch { return null }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function asJson(value: unknown): string { return JSON.stringify(value ?? null) }
function randomToken(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") }
async function sha256(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("") }
async function encryptionKey(env: WorkerEnv): Promise<CryptoKey> {
  if (!env.KEY_ENCRYPTION_SECRET || env.KEY_ENCRYPTION_SECRET.length < 32) throw new Error("Key encryption is not configured.")
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.KEY_ENCRYPTION_SECRET))
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}
async function encryptKey(env: WorkerEnv, value: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(value))
  return { ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))), iv: btoa(String.fromCharCode(...iv)) }
}
async function decryptKey(env: WorkerEnv, ciphertext: string, iv: string): Promise<string> {
  const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, await encryptionKey(env), decode(ciphertext))
  return new TextDecoder().decode(plaintext)
}
function requireDb(env: WorkerEnv): D1Database {
  if (!env.DB) throw new Error("Persistent storage is not configured.")
  return env.DB
}
async function authenticate(request: Request, env: WorkerEnv): Promise<Session | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token || !env.DB) return null
  const hash = await sha256(token)
  return requireDb(env).prepare("SELECT p.player_id, p.player_name FROM sessions s JOIN players p ON p.player_id = s.player_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(hash, Math.floor(Date.now() / 1000)).first<Session>()
}
async function validateTornKey(apiKey: string): Promise<{ id: string; name: string; factionId: string; factionName: string }> {
  if (!apiKey || apiKey.length > 256 || /\s/.test(apiKey)) throw new Error("Enter a valid Torn API key.")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const headers = { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" }
    const profileResponse = await fetch("https://api.torn.com/v2/user/profile", { headers, signal: controller.signal })
    const profilePayload: unknown = await profileResponse.json().catch(() => null)
    if (!profileResponse.ok || (isRecord(profilePayload) && isRecord(profilePayload.error))) {
      const error = isRecord(profilePayload) && isRecord(profilePayload.error) ? profilePayload.error : null
      const code = typeof error?.code === "number" ? error.code : undefined
      const status = code === 2 ? 401 : code === 3 ? 403 : code === 9 ? 429 : profileResponse.status >= 500 ? 502 : 401
      throw Object.assign(new Error(code === 2 ? "That Torn API key is invalid." : code === 3 ? "This Torn API key does not have profile access." : code === 9 ? "Torn rate limit reached. Try again shortly." : "Could not verify this Torn API key."), { status })
    }
    const profile = isRecord(profilePayload) && isRecord(profilePayload.profile) ? profilePayload.profile : null
    const id = profile?.id ?? profile?.player_id
    const name = profile?.name
    if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id)) || Number(id) <= 0 || typeof name !== "string" || !name.trim()) throw Object.assign(new Error("Torn returned an unexpected player profile."), { status: 502 })

    // Validate faction membership server-side before saving the key or creating a session.
    const factionResponse = await fetch("https://api.torn.com/v2/user/faction", { headers, signal: controller.signal })
    const factionPayload: unknown = await factionResponse.json().catch(() => null)
    if (!factionResponse.ok || (isRecord(factionPayload) && isRecord(factionPayload.error))) {
      const error = isRecord(factionPayload) && isRecord(factionPayload.error) ? factionPayload.error : null
      const code = typeof error?.code === "number" ? error.code : undefined
      const status = code === 2 ? 401 : code === 3 ? 403 : code === 9 ? 429 : factionResponse.status >= 500 ? 502 : 502
      throw Object.assign(new Error(code === 3 ? "The API key needs faction access so Naughty Souls membership can be verified. Use a limited-access key that includes faction access." : code === 9 ? "Torn rate limit reached while checking faction membership. Try again shortly." : "We could not verify your Naughty Souls membership with Torn. Please check your key permissions and try again."), { status })
    }
    const faction = isRecord(factionPayload) && isRecord(factionPayload.faction) ? factionPayload.faction : null
    const factionId = faction?.id ?? (isRecord(factionPayload) ? factionPayload.faction_id : undefined)
    const factionName = faction?.name
    if ((typeof factionId !== "number" && typeof factionId !== "string") || !/^\d+$/.test(String(factionId))) {
      throw Object.assign(new Error("ACCESS DENIED: Your Torn account is not a member of Naughty Souls (faction ID 8317). You must belong to Naughty Souls to use this dashboard."), { status: 403 })
    }
    if (String(factionId) !== "8317") {
      throw Object.assign(new Error("ACCESS DENIED: You do not belong to Naughty Souls (faction ID 8317). This dashboard is exclusively for Naughty Souls faction members. Sign-in has been blocked."), { status: 403 })
    }
    return { id: String(id), name: name.trim().slice(0, 100), factionId: String(factionId), factionName: typeof factionName === "string" ? factionName.trim().slice(0, 100) : "Naughty Souls" }
  } finally { clearTimeout(timeout) }
}
async function saveKey(env: WorkerEnv, playerId: string, apiKey: string): Promise<void> {
  const encrypted = await encryptKey(env, apiKey)
  const now = new Date().toISOString()
  await requireDb(env).prepare("INSERT INTO api_keys (player_id, ciphertext, iv, last_four, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, updated_at = excluded.updated_at").bind(playerId, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), now, now).run()
}
async function savedKey(env: WorkerEnv, playerId: string): Promise<string | null> {
  const row = await requireDb(env).prepare("SELECT ciphertext, iv FROM api_keys WHERE player_id = ?").bind(playerId).first<{ ciphertext: string; iv: string }>()
  return row ? decryptKey(env, row.ciphertext, row.iv) : null
}
async function saveCompanyKey(env: WorkerEnv, playerId: string, apiKey: string): Promise<void> {
  const encrypted = await encryptKey(env, apiKey)
  const now = new Date().toISOString()
  await requireDb(env).prepare("INSERT INTO company_keys (player_id, ciphertext, iv, last_four, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, updated_at = excluded.updated_at").bind(playerId, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), now, now).run()
}
async function savedCompanyKey(env: WorkerEnv, playerId: string): Promise<string | null> {
  const row = await requireDb(env).prepare("SELECT ciphertext, iv FROM company_keys WHERE player_id = ?").bind(playerId).first<{ ciphertext: string; iv: string }>()
  return row ? decryptKey(env, row.ciphertext, row.iv) : null
}
async function saveCompanyApiKey(env: WorkerEnv, playerId: string, companyId: number, apiKey: string, profile: unknown): Promise<void> {
  const encrypted = await encryptKey(env, apiKey)
  const root = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : isRecord(profile) ? profile : {}
  const type = isRecord(root.type) ? root.type : {}
  const now = new Date().toISOString()
  await requireDb(env).prepare("INSERT INTO company_api_keys (player_id, company_id, ciphertext, iv, last_four, company_name, company_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, company_name = excluded.company_name, company_type = excluded.company_type, updated_at = excluded.updated_at").bind(playerId, String(companyId), encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), typeof root.name === "string" ? root.name : `Company #${companyId}`, typeof type.name === "string" ? type.name : null, now, now).run()
}
async function savedCompanyApiKey(env: WorkerEnv, playerId: string, companyId: string): Promise<string | null> {
  const row = await requireDb(env).prepare("SELECT ciphertext, iv FROM company_api_keys WHERE player_id = ? AND company_id = ?").bind(playerId, companyId).first<{ ciphertext: string; iv: string }>()
  return row ? decryptKey(env, row.ciphertext, row.iv) : null
}
async function companyKeyMeta(env: WorkerEnv, playerId: string): Promise<{ saved: boolean; lastFour?: string; updatedAt?: string }> {
  const legacy = await requireDb(env).prepare("SELECT last_four, updated_at FROM company_keys WHERE player_id = ?").bind(playerId).first<{ last_four: string; updated_at: string }>()
  const perCompany = await requireDb(env).prepare("SELECT last_four, updated_at FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC LIMIT 1").bind(playerId).first<{ last_four: string; updated_at: string }>()
  const row = perCompany ?? legacy
  return row ? { saved: true, lastFour: row.last_four, updatedAt: row.updated_at } : { saved: false }
}
async function validateCompanyKey(apiKey: string): Promise<{ companyId: number; profile: unknown; employees: unknown }> {
  const client = new TornApiClient({ apiKey })
  const { profile, employees } = await client.getCompanySelections()
  const companyId = companyIdFromPayload(profile)
  if (!companyId) throw Object.assign(new Error("That key did not return a valid company profile. Use a key with company profile and employee access."), { status: 403 })
  return { companyId, profile, employees }
}
async function inspectDirectorKey(apiKey: string, playerId: string): Promise<{ isDirector: boolean; profile?: unknown }> {
  try {
    const client = new TornApiClient({ apiKey })
    const jobPayload = await client.getUserJob()
    const job = isRecord(jobPayload) && isRecord(jobPayload.job) ? jobPayload.job : {}
    const position = typeof job.position === "string" ? job.position.trim().toLowerCase() : ""
    const jobCompanyId = job.id
    if (position !== "director" || (typeof jobCompanyId !== "number" && !(typeof jobCompanyId === "string" && /^\d+$/.test(jobCompanyId)))) {
      return { isDirector: false }
    }
    // /user/job is the authoritative director/permission signal. Confirm the
    // same company can be read using the combined profile, employees and stock endpoint.
    const selections = await client.getCompanySelections()
    const companyId = companyIdFromPayload(selections.profile)
    if (!companyId || String(companyId) !== String(jobCompanyId)) return { isDirector: false }
    return { isDirector: true, profile: selections.profile }
  } catch {
    return { isDirector: false }
  }
}
function companyIdFromPayload(payload: unknown): number | null {
  if (!isRecord(payload)) return null
  const company = isRecord(payload.company) ? payload.company : isRecord(payload.profile) ? payload.profile : payload
  const candidates = [company.id, company.company_id, company.companyId, company.ID, payload.company_id, payload.companyId]
  for (const candidate of candidates) {
    const id = typeof candidate === "number" ? candidate : typeof candidate === "string" && /^\d+$/.test(candidate) ? Number(candidate) : NaN
    if (Number.isSafeInteger(id) && id > 0) return id
  }
  return null
}

function tornError(error: unknown, origin: string): Response {
  if (error instanceof TornApiClientError) return jsonResponse({ error: error.message }, error.status, origin, error.retryAfter ? { "retry-after": error.retryAfter } : {})
  const status = isRecord(error) && typeof error.status === "number" ? error.status : 500
  return jsonResponse({ error: error instanceof Error ? error.message : "Unexpected server error." }, status, origin)
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = "", quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = "" }
    else if (char === '\n') { row.push(field.replace(/\r$/, "")); if (row.some((cell) => cell !== "")) rows.push(row); row = []; field = "" }
    else field += char
  }
  if (field !== "" || row.length) { row.push(field.replace(/\r$/, "")); if (row.some((cell) => cell !== "")) rows.push(row) }
  return rows
}
function normalizedColumn(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, "") }
function numberField(row: Record<string, string>, ...names: string[]): number | null {
  for (const name of names) {
    const value = row[normalizedColumn(name)]
    if (value !== undefined && value.trim() !== "") {
      const number = Number(value.replace(/[$,]/g, ""))
      if (Number.isFinite(number)) return number
    }
  }
  return null
}
async function fetchGlobalCompanyRankings(apiKey: string): Promise<{ companies: Record<string, unknown>[]; snapshotFetchedAt: string }> {
  const headers = { Authorization: `ApiKey ${apiKey}`, Accept: "text/csv, text/plain, application/json" }
  const response = await fetch("https://api.torn.com/v2/company/snapshot", { headers, signal: AbortSignal.timeout(20000) })
  const body = await response.text()
  if (!response.ok || body.trimStart().startsWith("{")) {
    let message = "Torn could not provide the all-company snapshot."
    try { const payload = JSON.parse(body); if (isRecord(payload) && isRecord(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message } catch { /* CSV response */ }
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : response.status >= 500 ? 502 : 502 })
  }
  const csv = parseCsv(body)
  if (csv.length < 2) throw Object.assign(new Error("Torn returned an empty company snapshot."), { status: 502 })
  const typeNames = new Map<number, string>()
  try {
    const typeResponse = await fetch("https://api.torn.com/v2/torn/companies", { headers, signal: AbortSignal.timeout(10000) })
    if (typeResponse.ok) {
      const typePayload: unknown = await typeResponse.json()
      const root = isRecord(typePayload) && isRecord(typePayload.companies) ? typePayload.companies : isRecord(typePayload) && isRecord(typePayload.company_types) ? typePayload.company_types : typePayload
      const entries = Array.isArray(root) ? root : isRecord(root) ? Object.values(root) : []
      for (const entry of entries) {
        if (!isRecord(entry)) continue
        const id = entry.id ?? entry.ID ?? entry.company_type
        const name = entry.name ?? entry.title ?? entry.type_name
        if ((typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) && typeof name === "string") typeNames.set(Number(id), name)
      }
    }
  } catch { /* The snapshot remains useful even if company-type metadata is unavailable. */ }
  const headersRow = csv[0].map(normalizedColumn)
  const records = csv.slice(1).map((cells) => Object.fromEntries(headersRow.map((header, index) => [header, cells[index] ?? ""])))
  const companies = records.flatMap((row) => {
    const companyId = numberField(row, "id", "company_id", "companyId", "ID")
    if (!companyId) return []
    const typeId = numberField(row, "company_type_id", "company_type", "companyType", "type_id", "type")
    const weeklyIncome = numberField(row, "weekly_income", "weeklyIncome")
    const dailyIncome = numberField(row, "daily_income", "dailyIncome")
    const rating = numberField(row, "rating", "stars", "star_rating")
    return [{ companyId: String(companyId), companyName: row.name || row.companyname || `Company #${companyId}`, companyType: row.companytypename || row.typename || (typeId === null ? "Unknown" : typeNames.get(typeId) || `Type #${typeId}`), companyTypeId: typeId, starRating: rating, weeklyIncome, dailyIncome, averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7, directorName: "", playerId: "torn-global", fetchedAt: new Date().toISOString() }]
  }).sort((a, b) => (Number(b.weeklyIncome ?? -1) - Number(a.weeklyIncome ?? -1)))
  return { companies, snapshotFetchedAt: new Date().toISOString() }
}
async function refreshGlobalRankingCache(env: WorkerEnv, apiKey?: string): Promise<void> {
  if (!env.DB) return
  const db = requireDb(env)
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run()
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_refresh_lock (lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1), lease_until INTEGER NOT NULL DEFAULT 0)").run()
  await db.prepare("INSERT INTO global_rankings_refresh_lock (lock_id, lease_until) VALUES (1, 0) ON CONFLICT(lock_id) DO NOTHING").run()

  const cached = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ fetchedAt: string }>()
  const nowMs = Date.now()
  const cacheAge = cached?.fetchedAt ? nowMs - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY
  const maxAgeMs = 24 * 60 * 60 * 1000
  if (Number.isFinite(cacheAge) && cacheAge >= 0 && cacheAge < maxAgeMs) return

  const nowSeconds = Math.floor(nowMs / 1000)
  const leaseUntil = nowSeconds + 120
  const claim = await db.prepare("UPDATE global_rankings_refresh_lock SET lease_until = ? WHERE lock_id = 1 AND lease_until < ?").bind(leaseUntil, nowSeconds).run()
  if (claim.meta?.changes === 0) return

  try {
    // Another request may have refreshed the shared snapshot while this request waited for the lease.
    const latest = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ fetchedAt: string }>()
    const latestAge = latest?.fetchedAt ? Date.now() - Date.parse(latest.fetchedAt) : Number.POSITIVE_INFINITY
    if (Number.isFinite(latestAge) && latestAge >= 0 && latestAge < maxAgeMs) return

    let key = apiKey
    if (!key) {
      const row = await db.prepare("SELECT player_id FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string }>()
      if (row) key = (await savedKey(env, row.player_id)) ?? undefined
    }
    if (!key) return
    const snapshot = await fetchGlobalCompanyRankings(key)
    await db.prepare("INSERT INTO global_rankings_cache (cache_id, companies_json, fetched_at) VALUES (1, ?, ?) ON CONFLICT(cache_id) DO UPDATE SET companies_json = excluded.companies_json, fetched_at = excluded.fetched_at").bind(asJson(snapshot.companies), snapshot.snapshotFetchedAt).run()
  } finally {
    await db.prepare("UPDATE global_rankings_refresh_lock SET lease_until = 0 WHERE lock_id = 1 AND lease_until = ?").bind(leaseUntil).run().catch(() => undefined)
  }
}

function companyProfileRoot(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {}
  if (isRecord(payload.company)) return payload.company
  if (isRecord(payload.profile)) return isRecord(payload.profile.profile) ? payload.profile.profile : payload.profile
  return payload
}
function positiveId(value: unknown): string | null {
  if ((typeof value === "number" || typeof value === "string") && /^\d+$/.test(String(value)) && Number(value) > 0) return String(value)
  return null
}
async function persistFactionDirectorSnapshot(env: WorkerEnv, profile: unknown, stock: unknown = null): Promise<void> {
  if (!env.DB) return
  const root = companyProfileRoot(profile)
  const director = isRecord(root.director) ? root.director : {}
  const playerId = positiveId(director.id ?? director.player_id)
  const companyId = positiveId(root.id ?? root.company_id)
  if (!playerId || !companyId) return
  const type = isRecord(root.type) ? root.type : {}
  const name = typeof root.name === "string" ? root.name : `Company #${companyId}`
  const typeName = typeof type.name === "string" ? type.name : null
  const typeId = typeof type.id === "number" ? type.id : null
  const rating = typeof root.rating === "number" ? root.rating : null
  const income = isRecord(root.income) ? root.income : {}
  const dailyIncome = typeof income.daily === "number" ? income.daily : null
  const weeklyIncome = typeof income.weekly === "number" ? income.weekly : null
  const now = new Date().toISOString()
  const day = now.slice(0, 10)
  const db = requireDb(env)
  await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, company_id, company_name, company_type, company_type_id, company_rating, daily_income, weekly_income, profile_json, updated_at) VALUES (?, ?, '8317', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET is_director = 1, company_id = excluded.company_id, company_name = excluded.company_name, company_type = excluded.company_type, company_type_id = excluded.company_type_id, company_rating = excluded.company_rating, daily_income = excluded.daily_income, weekly_income = excluded.weekly_income, profile_json = excluded.profile_json, updated_at = excluded.updated_at")
    .bind(playerId, typeof director.name === "string" ? director.name : `Player #${playerId}`, now, companyId, name, typeName, typeId, rating, dailyIncome, weeklyIncome, asJson(profile), now).run()
  await db.prepare("INSERT INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id, snapshot_day) DO NOTHING")
    .bind(playerId, companyId, day, asJson(profile), stock === null || stock === undefined ? null : asJson(stock), now).run()
}
async function syncFactionDirectorDirectory(env: WorkerEnv, apiKey: string, limit = 20): Promise<{ processed: number; pending: number; directors: Record<string, unknown>[] }> {
  const client = new TornApiClient({ apiKey })
  const memberPayload = await client.getFactionMembers()
  const rawMembers = Array.isArray(memberPayload.members) ? memberPayload.members : isRecord(memberPayload.members) ? Object.values(memberPayload.members) : []
  const db = requireDb(env)
  const now = Date.now()
  let processed = 0
  let pending = 0
  for (const item of rawMembers) {
    if (!isRecord(item)) continue
    const id = positiveId(item.id ?? item.user_id)
    if (!id) continue
    const name = typeof item.name === "string" ? item.name : `Player #${id}`
    const cached = await db.prepare("SELECT checked_at FROM faction_member_cache WHERE player_id = ?").bind(id).first<{ checked_at: string | null }>()
    const checked = cached?.checked_at ? Date.parse(cached.checked_at) : 0
    if (checked && now - checked < 12 * 60 * 60 * 1000) continue
    if (processed >= limit) { pending += 1; continue }
    processed += 1
    const checkedAt = new Date().toISOString()
    try {
      const jobPayload = await client.getUserJobFor(id)
      const job = isRecord(jobPayload.job) ? jobPayload.job : {}
      const position = typeof job.position === "string" ? job.position.trim().toLowerCase() : ""
      const isDirector = position === "director" && Boolean(positiveId(job.id ?? job.company_id))
      if (!isDirector) {
        await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, job_json, updated_at) VALUES (?, ?, '8317', ?, 0, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, faction_id = excluded.faction_id, checked_at = excluded.checked_at, is_director = 0, company_id = NULL, company_name = NULL, company_type = NULL, company_type_id = NULL, company_rating = NULL, daily_income = NULL, weekly_income = NULL, job_json = excluded.job_json, profile_json = NULL, updated_at = excluded.updated_at")
          .bind(id, name, checkedAt, asJson(jobPayload), checkedAt).run()
        continue
      }
      const companyId = positiveId(job.id ?? job.company_id)!
      let profile: unknown = null
      try { profile = await client.getCompanyProfileById(companyId) } catch { /* Keep job-derived company identity if profile access is temporarily unavailable. */ }
      const root = companyProfileRoot(profile)
      const type = isRecord(root.type) ? root.type : {}
      const jobTypeId = typeof job.type_id === "number" ? job.type_id : null
      const companyName = typeof root.name === "string" ? root.name : typeof job.name === "string" ? job.name : `Company #${companyId}`
      const companyType = typeof type.name === "string" ? type.name : null
      const companyTypeId = typeof type.id === "number" ? type.id : jobTypeId
      const rating = typeof root.rating === "number" ? root.rating : null
      const income = isRecord(root.income) ? root.income : {}
      const dailyIncome = typeof income.daily === "number" ? income.daily : null
      const weeklyIncome = typeof income.weekly === "number" ? income.weekly : null
      await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, company_id, company_name, company_type, company_type_id, company_rating, daily_income, weekly_income, job_json, profile_json, updated_at) VALUES (?, ?, '8317', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, faction_id = excluded.faction_id, checked_at = excluded.checked_at, is_director = 1, company_id = excluded.company_id, company_name = excluded.company_name, company_type = excluded.company_type, company_type_id = excluded.company_type_id, company_rating = excluded.company_rating, daily_income = excluded.daily_income, weekly_income = excluded.weekly_income, job_json = excluded.job_json, profile_json = COALESCE(excluded.profile_json, faction_member_cache.profile_json), updated_at = excluded.updated_at")
        .bind(id, name, checkedAt, companyId, companyName, companyType, companyTypeId, rating, dailyIncome, weeklyIncome, asJson(jobPayload), profile === null ? null : asJson(profile), checkedAt).run()
      if (profile) await persistFactionDirectorSnapshot(env, profile)
    } catch {
      await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, updated_at) VALUES (?, ?, '8317', ?, 0, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, checked_at = excluded.checked_at, updated_at = excluded.updated_at")
        .bind(id, name, checkedAt, checkedAt).run()
    }
  }
  const rows = await db.prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 ORDER BY company_type ASC, weekly_income DESC").all()
  return { processed, pending: Math.max(pending, 0), directors: rows.results ?? [] }
}

async function captureWeeklyFactionStarCounts(env: WorkerEnv, capturedAt = new Date().toISOString()): Promise<void> {
  if (!env.DB) return
  const db = requireDb(env)
  const captured = new Date(capturedAt)
  const weekKey = captured.toISOString().slice(0, 10)
  await db.prepare("CREATE TABLE IF NOT EXISTS faction_star_weekly_counts (week_key TEXT NOT NULL, star_rating INTEGER NOT NULL, company_count INTEGER NOT NULL, captured_at TEXT NOT NULL, PRIMARY KEY (week_key, star_rating))").run()
  const counts = await db.prepare("SELECT company_rating AS starRating, COUNT(DISTINCT company_id) AS companyCount FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 AND company_id IS NOT NULL AND company_rating IS NOT NULL GROUP BY company_rating ORDER BY company_rating ASC").all<{ starRating: number; companyCount: number }>()
  for (const row of counts.results ?? []) {
    if (!Number.isInteger(row.starRating) || row.starRating < 0) continue
    await db.prepare("INSERT INTO faction_star_weekly_counts (week_key, star_rating, company_count, captured_at) VALUES (?, ?, ?, ?) ON CONFLICT(week_key, star_rating) DO NOTHING")
      .bind(weekKey, row.starRating, row.companyCount, capturedAt).run()
  }
}
async function getWeeklyFactionStarCounts(env: WorkerEnv): Promise<{ weeklyStarCounts: { starRating: number; companyCount: number }[]; weeklyStarCountsCapturedAt: string }> {
  const db = requireDb(env)
  await db.prepare("CREATE TABLE IF NOT EXISTS faction_star_weekly_counts (week_key TEXT NOT NULL, star_rating INTEGER NOT NULL, company_count INTEGER NOT NULL, captured_at TEXT NOT NULL, PRIMARY KEY (week_key, star_rating))").run()
  const latest = await db.prepare("SELECT week_key AS weekKey, MAX(captured_at) AS capturedAt FROM faction_star_weekly_counts GROUP BY week_key ORDER BY week_key DESC LIMIT 1").first<{ weekKey: string; capturedAt: string }>()
  if (!latest) return { weeklyStarCounts: [], weeklyStarCountsCapturedAt: "" }
  const rows = await db.prepare("SELECT star_rating AS starRating, company_count AS companyCount FROM faction_star_weekly_counts WHERE week_key = ? ORDER BY star_rating ASC").bind(latest.weekKey).all<{ starRating: number; companyCount: number }>()
  return { weeklyStarCounts: rows.results ?? [], weeklyStarCountsCapturedAt: latest.capturedAt }
}

async function refreshFactionDirectoryFromAnyKey(env: WorkerEnv, limit = 35): Promise<void> {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return
  const row = await requireDb(env).prepare("SELECT player_id, ciphertext, iv FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string; ciphertext: string; iv: string }>()
  if (!row) return
  try {
    const apiKey = await decryptKey(env, row.ciphertext, row.iv)
    await syncFactionDirectorDirectory(env, apiKey, limit)
  } catch { /* Keep scheduled sync resilient to a revoked key or temporary Torn failure. */ }
}

async function refreshRankingProfiles(env: WorkerEnv): Promise<void> {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return
  const db = requireDb(env)
  const perCompany = await db.prepare("SELECT player_id, company_id, ciphertext, iv FROM company_api_keys ORDER BY updated_at ASC").all<{ player_id: string; company_id: string; ciphertext: string; iv: string }>()
  const keys = perCompany.results ?? []
  const keyedPlayers = new Set(keys.map((row) => row.player_id))
  const legacy = await db.prepare("SELECT player_id, ciphertext, iv FROM company_keys ORDER BY updated_at ASC").all<{ player_id: string; ciphertext: string; iv: string }>()
  const work = [...keys, ...(legacy.results ?? []).filter((row) => !keyedPlayers.has(row.player_id)).map((row) => ({ ...row, company_id: "" }))]
  for (const keyRow of work) {
    try {
      const apiKey = await decryptKey(env, keyRow.ciphertext, keyRow.iv)
      const client = new TornApiClient({ apiKey })
      const { profile, employees: employeePayload, stock } = await client.getCompanySelections()
      const companyId = companyIdFromPayload(profile)
      if (!companyId || (keyRow.company_id && String(companyId) !== keyRow.company_id)) continue
      const root = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : isRecord(profile) ? profile : {}
      const type = isRecord(root.type) ? root.type : {}
      const existing = await db.prepare("SELECT employees_json FROM companies WHERE player_id = ? AND company_id = ?").bind(keyRow.player_id, String(companyId)).first<{ employees_json: string }>()
      const employees = employeePayload === null ? existing?.employees_json ?? "{}" : asJson(employeePayload)
      const now = new Date().toISOString()
      await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(keyRow.player_id, String(companyId), String(root.name ?? `Company #${companyId}`), typeof type.name === "string" ? type.name : null, asJson(profile), employees, now).run()
      await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(keyRow.player_id, String(companyId), asJson(profile), employees, now).run()
      await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(keyRow.player_id, String(companyId), asJson(stock), now).run()
      await persistFactionDirectorSnapshot(env, profile, stock)
    } catch { /* One stale key or Torn API error must not stop the remaining companies. */ }
  }
}

export default {
  async scheduled(controller: { scheduledTime: number; cron: string }, env: WorkerEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    const isWeeklyLock = controller.cron === "10 18 * * SUN"
    ctx.waitUntil(Promise.all([refreshRankingProfiles(env), refreshFactionDirectoryFromAnyKey(env, isWeeklyLock ? 250 : 35), refreshGlobalRankingCache(env).catch(() => undefined)]).then(async () => {
      if (isWeeklyLock) await captureWeeklyFactionStarCounts(env, new Date(controller.scheduledTime).toISOString())
    }))
  },
  async fetch(request: Request, env: WorkerEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const origin = allowedOrigin(request, env)
    if (!origin) return jsonResponse({ error: "Origin not allowed." }, 403)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "86400", vary: "Origin" } })
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") return jsonResponse({ ok: true, service: "naughty-company-api" }, 200, origin)
    if (url.pathname === "/api/auth/sign-in" && request.method === "POST") {
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        const secondaryCompanyKey = isRecord(body) && typeof body.secondaryCompanyKey === "string" ? body.secondaryCompanyKey.trim() : ""
        if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 400, origin)
        const player = await validateTornKey(apiKey)
        const directorCheck = await inspectDirectorKey(apiKey, player.id)
        let loginKeyHasCompanyAccess = false
        try { await validateCompanyKey(apiKey); loginKeyHasCompanyAccess = true } catch { /* A separate company key may be needed. */ }
        const db = requireDb(env)
        const now = new Date().toISOString()
        await db.prepare("INSERT INTO players (player_id, player_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, updated_at = excluded.updated_at").bind(player.id, player.name, now, now).run()
        await saveKey(env, player.id, apiKey)
        try { await refreshGlobalRankingCache(env, apiKey) } catch { /* Daily schedule retries the cache warm-up. */ }
        // Prefer the login key whenever it actually has company profile + employee access.
        if (loginKeyHasCompanyAccess || directorCheck.isDirector) {
          await saveCompanyKey(env, player.id, apiKey)
          try { const validated = await validateCompanyKey(apiKey); await saveCompanyApiKey(env, player.id, validated.companyId, apiKey, validated.profile) } catch { /* Keep the legacy director key record; company refresh will report missing endpoint access. */ }
        } else if (secondaryCompanyKey) {
          await validateCompanyKey(secondaryCompanyKey)
          await saveCompanyKey(env, player.id, secondaryCompanyKey)
        }
        const companyKey = await companyKeyMeta(env, player.id)
        const token = randomToken()
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * DAY
        await db.prepare("INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), player.id, expiresAt, now).run()
        const meta = await db.prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(player.id).first<{ last_four: string; updated_at: string }>()
        return jsonResponse({ token, expiresAt, player, key: { saved: true, lastFour: meta?.last_four, updatedAt: meta?.updated_at }, company: { isDirector: directorCheck.isDirector, key: companyKey, needsSecondaryKey: !directorCheck.isDirector && !companyKey.saved } }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const key = await requireDb(env).prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(session.player_id).first<{ last_four: string; updated_at: string }>()
      const companyKey = await companyKeyMeta(env, session.player_id)
      const cachedDirector = await requireDb(env).prepare("SELECT is_director FROM faction_member_cache WHERE player_id = ?").bind(session.player_id).first<{ is_director: number }>()
      const isDirector = cachedDirector?.is_director === 1
      return jsonResponse({ player: { id: session.player_id, name: session.player_name }, key: key ? { saved: true, lastFour: key.last_four, updatedAt: key.updated_at } : { saved: false }, company: { isDirector, key: companyKey, needsSecondaryKey: !isDirector && !companyKey.saved } }, 200, origin)
    }
    if (url.pathname === "/api/auth/key" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 400, origin)
        const player = await validateTornKey(apiKey)
        if (player.id !== session.player_id) return jsonResponse({ error: "That key belongs to a different Torn player. Sign out and sign in as that player to switch accounts." }, 403, origin)
        await saveKey(env, player.id, apiKey)
        return jsonResponse({ saved: true, lastFour: apiKey.slice(-4), updatedAt: new Date().toISOString() }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/auth/company-key" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        if (!apiKey) return jsonResponse({ error: "A secondary company API key is required." }, 400, origin)
        const validated = await validateCompanyKey(apiKey)
        await saveCompanyApiKey(env, session.player_id, validated.companyId, apiKey, validated.profile)
        const root = isRecord(validated.profile) && isRecord(validated.profile.company) ? validated.profile.company : isRecord(validated.profile) && isRecord(validated.profile.profile) ? validated.profile.profile : {}
        const type = isRecord(root.type) ? root.type : {}
        return jsonResponse({ saved: true, companyId: validated.companyId, companyName: typeof root.name === "string" ? root.name : `Company #${validated.companyId}`, companyType: typeof type.name === "string" ? type.name : null }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/auth/key" && request.method === "DELETE") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      await requireDb(env).prepare("DELETE FROM api_keys WHERE player_id = ?").bind(session.player_id).run()
      await requireDb(env).prepare("DELETE FROM company_keys WHERE player_id = ?").bind(session.player_id).run()
      await requireDb(env).prepare("DELETE FROM company_api_keys WHERE player_id = ?").bind(session.player_id).run()
      return jsonResponse({ deleted: true, companyDataRetained: true }, 200, origin)
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
      if (token && env.DB) await requireDb(env).prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run()
      return jsonResponse({ signedOut: true }, 200, origin)
    }
    if (url.pathname === "/api/dashboard-members" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const rows = await requireDb(env).prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, (SELECT c.company_name FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyName, (SELECT c.company_type FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyType, (SELECT c.profile_json FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS profileJson, (SELECT f.company_type_id FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyTypeId, (SELECT f.company_name FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyName, (SELECT f.company_type FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyType FROM players p ORDER BY p.player_name COLLATE NOCASE").all<Record<string, unknown>>()
      const members = (rows.results ?? []).map((row) => {
        let profile: unknown = null
        try { profile = typeof row.profileJson === "string" ? JSON.parse(row.profileJson) : row.profileJson } catch { profile = null }
        const root = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : isRecord(profile) ? profile : {}
        const type = isRecord(root.type) ? root.type : {}
        const typeId = type.id ?? root.company_type_id ?? root.type_id ?? row.cachedCompanyTypeId ?? null
        return {
          playerId: String(row.playerId),
          playerName: String(row.playerName ?? "Dashboard member"),
          companyName: row.companyName == null ? (row.cachedCompanyName == null ? null : String(row.cachedCompanyName)) : String(row.companyName),
          companyType: row.companyType == null ? (row.cachedCompanyType == null ? null : String(row.cachedCompanyType)) : String(row.companyType),
          companyTypeId: typeof typeId === "number" || typeof typeId === "string" ? typeId : null,
        }
      })
      return jsonResponse({ members, updatedAt: new Date().toISOString() }, 200, origin)
    }
    if (url.pathname === "/api/me/data-sharing" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const db = requireDb(env)
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
      if (request.method === "GET") {
        const rows = await db.prepare("SELECT p.player_id AS playerId, p.player_name AS directorName, (SELECT c.company_name FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyName, (SELECT c.company_type FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyType, COALESCE(r.share_financial_data, 0) AS shareFinancialData, COALESCE(r.share_employee_data, 0) AS shareEmployeeData, COALESCE(r.share_trend_data, 0) AS shareTrendData FROM players p LEFT JOIN company_sharing_recipients r ON r.recipient_player_id = p.player_id AND r.owner_player_id = ? WHERE p.player_id != ? ORDER BY p.player_name COLLATE NOCASE").bind(session.player_id, session.player_id).all<Record<string, unknown>>()
        const recipients = (rows.results ?? []).map((row) => ({ playerId: String(row.playerId), directorName: String(row.directorName ?? "Dashboard member"), companyName: row.companyName == null ? null : String(row.companyName), companyType: row.companyType == null ? null : String(row.companyType), shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1 }))
        return jsonResponse({ recipients, updatedAt: new Date().toISOString() }, 200, origin)
      }
      const body: unknown = await request.json().catch(() => null)
      const supplied = isRecord(body) ? body : {}
      const recipientId = positiveId(supplied.recipientId)
      if (!recipientId || recipientId === session.player_id) return jsonResponse({ error: "Select another dashboard member to manage sharing." }, 400, origin)
      const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(recipientId).first<{ player_id: string }>()
      if (!target) return jsonResponse({ error: "That member does not have a dashboard account." }, 404, origin)
      const permissions = { shareFinancialData: supplied.shareFinancialData === true, shareEmployeeData: supplied.shareEmployeeData === true, shareTrendData: supplied.shareTrendData === true }
      const now = new Date().toISOString()
      await db.prepare("INSERT INTO company_sharing_recipients (owner_player_id, recipient_player_id, share_financial_data, share_employee_data, share_trend_data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id, recipient_player_id) DO UPDATE SET share_financial_data = excluded.share_financial_data, share_employee_data = excluded.share_employee_data, share_trend_data = excluded.share_trend_data, updated_at = excluded.updated_at").bind(session.player_id, recipientId, Number(permissions.shareFinancialData), Number(permissions.shareEmployeeData), Number(permissions.shareTrendData), now).run()
      return jsonResponse({ recipient: { playerId: recipientId, ...permissions }, updatedAt: now }, 200, origin)
    }
    if (url.pathname === "/api/faction/shared-company-data" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const db = requireDb(env)
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
      const rows = await db.prepare("SELECT c.player_id AS playerId, p.player_name AS directorName, c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType, c.profile_json AS profileJson, c.employees_json AS employeesJson, c.fetched_at AS fetchedAt, f.stock_json AS stockJson, s.share_financial_data AS shareFinancialData, s.share_employee_data AS shareEmployeeData, s.share_trend_data AS shareTrendData FROM company_sharing_recipients s JOIN companies c ON c.player_id = s.owner_player_id JOIN players p ON p.player_id = c.player_id LEFT JOIN company_financials f ON f.player_id = c.player_id AND f.company_id = c.company_id WHERE s.recipient_player_id = ? AND (s.share_financial_data = 1 OR s.share_employee_data = 1) ORDER BY c.company_type, c.company_name").bind(session.player_id).all<Record<string, unknown>>()
      const shared = (rows.results ?? []).flatMap((row) => {
        try {
          const profilePayload = JSON.parse(String(row.profileJson)) as unknown
          const profile = companyProfileRoot(profilePayload)
          const companyType = isRecord(profile.type) && typeof profile.type.name === "string" ? profile.type.name : String(row.companyType ?? "Unknown")
          const rowTypeValue = isRecord(profile.type) ? profile.type.id : null
          const rowTypeId = typeof rowTypeValue === "number" ? rowTypeValue : typeof rowTypeValue === "string" && /^\d+$/.test(rowTypeValue) ? Number(rowTypeValue) : null
          const result: Record<string, unknown> = {
            playerId: String(row.playerId), directorName: String(row.directorName ?? "Faction member"),
            companyId: String(row.companyId), companyName: String(profile.name ?? row.companyName ?? `Company #${row.companyId}`),
            companyType, companyTypeId: rowTypeId, fetchedAt: String(row.fetchedAt),
            shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1,
          }
          if (row.shareFinancialData === 1) {
            const adBudgetKeys = ["advertisement_budget", "advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"]
            const findAdBudget = (value: unknown, depth: number): number | null => {
              if (!isRecord(value) || depth > 5) return null
              for (const key of adBudgetKeys) if (typeof value[key] === "number" && Number.isFinite(value[key])) return value[key] as number
              for (const child of Object.values(value)) { const found = findAdBudget(child, depth + 1); if (found !== null) return found }
              return null
            }
            const adBudget = findAdBudget(profile, 0)
            if (adBudget !== null) result.adBudget = adBudget
            if (row.stockJson) {
              const stockPayload = JSON.parse(String(row.stockJson)) as unknown
              const stockRoot = isRecord(stockPayload) && Array.isArray(stockPayload.stock) ? stockPayload.stock : Array.isArray(stockPayload) ? stockPayload : isRecord(stockPayload) && isRecord(stockPayload.stock) ? Object.values(stockPayload.stock) : []
              result.stock = stockRoot.filter(isRecord).map((item) => {
                const sharedItem: Record<string, unknown> = {}
                if (typeof item.name === "string") sharedItem.name = item.name
                for (const key of ["in_stock", "quantity", "amount"]) if (typeof item[key] === "number" && Number.isFinite(item[key])) { sharedItem.quantity = item[key]; break }
                for (const key of ["price", "sell_price", "selling_price", "price_per_unit", "cost", "unit_cost", "cost_per_unit"]) if (typeof item[key] === "number" && Number.isFinite(item[key])) { sharedItem.unitPrice = item[key]; break }
                return sharedItem
              })
            }
          }
          if (row.shareEmployeeData === 1) {
            const employeesPayload = JSON.parse(String(row.employeesJson)) as unknown
            const employeeRoot = isRecord(employeesPayload) && Array.isArray(employeesPayload.employees) ? employeesPayload.employees : Array.isArray(employeesPayload) ? employeesPayload : isRecord(employeesPayload) && isRecord(employeesPayload.employees) ? Object.values(employeesPayload.employees) : []
            result.employees = employeeRoot.filter(isRecord).map((employee) => {
              const item: Record<string, unknown> = {}
              if (typeof employee.name === "string") item.name = employee.name
              const position = isRecord(employee.position) ? employee.position.name : employee.position_name ?? employee.position
              if (typeof position === "string") item.position = position
              const stats = isRecord(employee.stats) ? employee.stats : {}
              const normalizedStats: Record<string, number> = {}
              const statFields: Array<[string, string]> = [["MAN", "manual_labor"], ["INT", "intelligence"], ["END", "endurance"]]
              for (const [shortName, sourceName] of statFields) if (typeof stats[sourceName] === "number" && Number.isFinite(stats[sourceName])) normalizedStats[shortName] = stats[sourceName] as number
              if (Object.keys(normalizedStats).length) item.stats = normalizedStats
              const effectiveness = isRecord(employee.effectiveness) ? employee.effectiveness.total : employee.effectiveness
              const totalEffectiveness = [effectiveness, employee.effectiveness_total, employee.total_effectiveness].find((value) => typeof value === "number" && Number.isFinite(value))
              if (typeof totalEffectiveness === "number") item.effectiveness = totalEffectiveness
              const wage = [employee.wage, employee.salary].find((value) => typeof value === "number" && Number.isFinite(value))
              if (typeof wage === "number") item.wage = wage
              return item
            })
          }
          return [result]
        } catch { return [] }
      })
      return jsonResponse({ companies: shared, generatedAt: new Date().toISOString(), scope: "explicitly shared with this dashboard user" }, 200, origin)
    }
    if (url.pathname === "/api/rankings" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (url.searchParams.get("scope") === "global") {
        // Refresh a stale shared snapshot on demand. The server-side 24-hour cache
        // and database lease ensure concurrent dashboard users do not fan out to Torn.
        try {
          const userKey = await savedKey(env, session.player_id).catch(() => null)
          await refreshGlobalRankingCache(env, userKey ?? undefined)
        } catch { /* Serve the last saved ranking snapshot if Torn is temporarily unavailable. */ }
        const db = requireDb(env)
        await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run()
        const cached = await db.prepare("SELECT companies_json AS companiesJson, fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ companiesJson: string; fetchedAt: string }>()
        const snapshotCompanies = cached ? JSON.parse(cached.companiesJson) as Record<string, unknown>[] : []
        const requestedType = (url.searchParams.get("type") ?? "").trim().toLocaleLowerCase()
        const requestedTypeIdRaw = url.searchParams.get("typeId")
        const requestedTypeId = requestedTypeIdRaw && /^\d+$/.test(requestedTypeIdRaw) ? Number(requestedTypeIdRaw) : null
        const companies = requestedTypeId !== null
          ? snapshotCompanies.filter((company) => Number(company.companyTypeId) === requestedTypeId)
          : requestedType ? snapshotCompanies.filter((company) => String(company.companyType ?? "").trim().toLocaleLowerCase() === requestedType) : snapshotCompanies
        return jsonResponse({ companies, generatedAt: cached?.fetchedAt ?? "", source: "Daily cached Torn API v2 company snapshot", scope: "all-torn", companyType: requestedType || null, companyTypeId: requestedTypeId, incomeDataUpdatesAt: "18:10 UTC daily", starRatingUpdatesAt: "18:10 UTC Sundays", cacheAvailable: Boolean(cached) }, 200, origin, { "cache-control": "private, max-age=300" })
      }
      // Faction view is intentionally private to the signed-in dashboard user.
      // Do not scan/render every connected user's companies here.
      const rows = await requireDb(env).prepare("SELECT c.player_id, c.company_id, c.company_name, c.company_type, c.profile_json, c.fetched_at, p.player_name FROM companies c JOIN players p ON p.player_id = c.player_id WHERE c.player_id = ? ORDER BY c.fetched_at DESC").bind(session.player_id).all()
      const companies = (rows.results ?? []).flatMap((row) => {
        try {
          const profile = JSON.parse(String(row.profile_json)) as unknown
          const root = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : isRecord(profile) ? profile : {}
          const income = isRecord(root.income) ? root.income : {}
          const type = isRecord(root.type) ? root.type : {}
          const weeklyIncome = typeof income.weekly === "number" && Number.isFinite(income.weekly) ? income.weekly : null
          const dailyIncome = typeof income.daily === "number" && Number.isFinite(income.daily) ? income.daily : null
          const rating = typeof root.rating === "number" && Number.isFinite(root.rating) ? root.rating : null
          return [{ companyId: String(row.company_id), companyName: String(root.name ?? row.company_name ?? `Company #${row.company_id}`), companyType: String(type.name ?? row.company_type ?? "Unknown"), companyTypeId: type.id ?? null, starRating: rating, weeklyIncome, dailyIncome, averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7, directorName: String(row.player_name ?? "Unknown director"), playerId: String(row.player_id), fetchedAt: String(row.fetched_at) }]
        } catch { return [] }
      }).sort((a, b) => (b.weeklyIncome ?? -1) - (a.weeklyIncome ?? -1))
      return jsonResponse({ companies, generatedAt: new Date().toISOString(), source: "Dashboard-connected Naughty Souls companies", scope: "faction", incomeDataUpdatesAt: "18:10 UTC daily", starRatingUpdatesAt: "18:10 UTC Sundays" }, 200, origin)
    }
    if (url.pathname === "/api/faction/directors" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      try {
        if (request.method === "POST") {
          const userKey = await savedKey(env, session.player_id).catch(() => null)
          if (!userKey) return jsonResponse({ error: "Save a Torn API key to refresh the faction directory." }, 400, origin)
          const synced = await syncFactionDirectorDirectory(env, userKey, 20)
          const weeklyCounts = await getWeeklyFactionStarCounts(env)
          return jsonResponse({ ...synced, syncing: false, ...weeklyCounts, generatedAt: new Date().toISOString(), source: "Live Torn API directory refresh" }, 200, origin)
        }
        const rows = await requireDb(env).prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 ORDER BY company_type ASC, weekly_income DESC").all<Record<string, unknown>>()
        const weeklyCounts = await getWeeklyFactionStarCounts(env)
        const directors = rows.results ?? []
        const generatedAt = directors.map((director) => String(director.fetchedAt ?? "")).filter(Boolean).sort().at(-1) || weeklyCounts.weeklyStarCountsCapturedAt || ""
        return jsonResponse({ directors, processed: 0, pending: 0, syncing: false, ...weeklyCounts, generatedAt, source: "Daily cached Torn API snapshots" }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/faction/compare" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const playerId = positiveId(url.searchParams.get("playerId"))
      if (!playerId) return jsonResponse({ error: "Select a valid faction director to compare." }, 400, origin)
      const db = requireDb(env)
      const director = await db.prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE player_id = ? AND faction_id = '8317' AND is_director = 1").bind(playerId).first<Record<string, unknown>>()
      if (!director) return jsonResponse({ error: "That faction member has not been confirmed as a company director yet. Refresh the faction directory and try again." }, 404, origin)
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
      let mayShareStock = playerId === session.player_id
      let mayShareTrends = playerId === session.player_id
      if (!mayShareStock || !mayShareTrends) {
        const sharing = await db.prepare("SELECT share_financial_data AS shareFinancialData, share_trend_data AS shareTrendData FROM company_sharing_recipients WHERE owner_player_id = ? AND recipient_player_id = ?").bind(playerId, session.player_id).first<{ shareFinancialData: number; shareTrendData: number }>()
        mayShareStock = sharing?.shareFinancialData === 1
        mayShareTrends = sharing?.shareTrendData === 1
      }
      const snapshots = await db.prepare("SELECT snapshot_day AS day, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? AND company_id = ? ORDER BY snapshot_day ASC LIMIT 120").bind(playerId, String(director.companyId)).all<{ day: string; profileJson: string; stockJson: string | null; fetchedAt: string }>()
      const history = (snapshots.results ?? []).map((row) => {
        let root: Record<string, unknown> = {}
        let stock: unknown = null
        try { root = companyProfileRoot(JSON.parse(row.profileJson)) } catch { /* Ignore a corrupt historical snapshot. */ }
        try { stock = mayShareStock && row.stockJson ? JSON.parse(row.stockJson) : null } catch { /* Stock history is optional. */ }
        const income = isRecord(root.income) ? root.income : {}
        const profit = isRecord(root.profit) ? root.profit : {}
        const dailyProfit = [profit.daily, root.daily_profit, root.dailyProfit, root.profit_daily].find((value) => typeof value === "number" && Number.isFinite(value)) as number | undefined
        const stockRows = Array.isArray(stock) ? stock : isRecord(stock) && Array.isArray(stock.stock) ? stock.stock : []
        const stockQuantity = stockRows.reduce((sum, item) => { if (!isRecord(item)) return sum; const quantity = [item.in_stock, item.quantity, item.amount].find((value) => typeof value === "number" && Number.isFinite(value)) as number | undefined; return sum + (quantity ?? 0) }, 0)
        return { day: row.day, dailyIncome: typeof income.daily === "number" ? income.daily : null, weeklyIncome: typeof income.weekly === "number" ? income.weekly : null, dailyProfit: mayShareTrends ? dailyProfit ?? null : null, stockQuantity: stock === null ? null : stockQuantity, stock }
      })
      return jsonResponse({ director, history, stockHistoryAvailable: mayShareStock && history.some((row) => row.stock !== null), generatedAt: new Date().toISOString() }, 200, origin)
    }
    if (url.pathname === "/api/me/data-backup" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const db = requireDb(env)
      await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
      const parseStored = (value: unknown): unknown => { try { return JSON.parse(String(value)) as unknown } catch { return null } }
      const allowedPages = new Set(["company", "employees", "charts", "rankings", "references", "settings"])
      const upsertPageData = async (pageKey: string, value: unknown) => {
        const now = new Date().toISOString()
        await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(session.player_id, pageKey, asJson(value), now).run()
      }
      const restoreCompanies = async (value: unknown) => {
        if (!Array.isArray(value)) return
        for (const item of value.slice(0, 100)) {
          if (!isRecord(item)) continue
          const companyId = positiveId(item.companyId ?? item.company_id)
          if (!companyId) continue
          const existing = await db.prepare("SELECT company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? AND company_id = ?").bind(session.player_id, companyId).first<Record<string, unknown>>()
          const profile = item.profile !== undefined ? item.profile : existing ? parseStored(existing.profileJson) : null
          const employees = item.employees !== undefined ? item.employees : existing ? parseStored(existing.employeesJson) : []
          if (profile === null) continue
          const profileRoot = companyProfileRoot(profile)
          const companyName = typeof item.companyName === "string" ? item.companyName : typeof profileRoot.name === "string" ? profileRoot.name : String(existing?.companyName ?? `Company #${companyId}`)
          const companyType = typeof item.companyType === "string" ? item.companyType : isRecord(profileRoot.type) && typeof profileRoot.type.name === "string" ? profileRoot.type.name : existing?.companyType == null ? null : String(existing.companyType)
          const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : String(existing?.fetchedAt ?? new Date().toISOString())
          await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(session.player_id, companyId, companyName, companyType, asJson(profile), asJson(employees), fetchedAt).run()
        }
      }
      const restoreFinancials = async (value: unknown) => {
        if (!Array.isArray(value)) return
        for (const item of value.slice(0, 100)) {
          if (!isRecord(item)) continue
          const companyId = positiveId(item.companyId ?? item.company_id)
          if (!companyId || item.stock === undefined) continue
          const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : new Date().toISOString()
          await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(session.player_id, companyId, asJson(item.stock), fetchedAt).run()
        }
      }
      const restoreSharing = async (value: unknown) => {
        if (!Array.isArray(value)) return
        await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
        for (const item of value.slice(0, 1000)) {
          if (!isRecord(item)) continue
          const recipientId = positiveId(item.recipientId ?? item.recipient_id ?? item.playerId)
          if (!recipientId || recipientId === session.player_id) continue
          const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(recipientId).first<{ player_id: string }>()
          if (!target) continue
          await db.prepare("INSERT INTO company_sharing_recipients (owner_player_id, recipient_player_id, share_financial_data, share_employee_data, share_trend_data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id, recipient_player_id) DO UPDATE SET share_financial_data = excluded.share_financial_data, share_employee_data = excluded.share_employee_data, share_trend_data = excluded.share_trend_data, updated_at = excluded.updated_at").bind(session.player_id, recipientId, Number(item.shareFinancialData === true || item.share_financial_data === 1), Number(item.shareEmployeeData === true || item.share_employee_data === 1), Number(item.shareTrendData === true || item.share_trend_data === 1), new Date().toISOString()).run()
        }
      }
      if (request.method === "GET") {
        const [companyRows, financialRows, snapshotRows, directorSnapshotRows, pageRows, sharingRows] = await Promise.all([
          db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all<Record<string, unknown>>(),
          db.prepare("SELECT company_id AS companyId, stock_json AS stockJson, fetched_at AS fetchedAt FROM company_financials WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all<Record<string, unknown>>(),
          db.prepare("SELECT company_id AS companyId, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? ORDER BY fetched_at ASC").bind(session.player_id).all<Record<string, unknown>>(),
          db.prepare("SELECT company_id AS companyId, snapshot_day AS snapshotDay, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? ORDER BY snapshot_day ASC").bind(session.player_id).all<Record<string, unknown>>(),
          db.prepare("SELECT page_key AS pageKey, data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ?").bind(session.player_id).all<Record<string, unknown>>(),
          db.prepare("SELECT recipient_player_id AS recipientId, share_financial_data AS shareFinancialData, share_employee_data AS shareEmployeeData, share_trend_data AS shareTrendData, updated_at AS updatedAt FROM company_sharing_recipients WHERE owner_player_id = ? ORDER BY recipient_player_id").bind(session.player_id).all<Record<string, unknown>>(),
        ])
        const companies = (companyRows.results ?? []).map((row) => ({ companyId: String(row.companyId), companyName: row.companyName == null ? null : String(row.companyName), companyType: row.companyType == null ? null : String(row.companyType), profile: parseStored(row.profileJson), employees: parseStored(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }))
        const financials = (financialRows.results ?? []).map((row) => ({ companyId: String(row.companyId), stock: parseStored(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }))
        const companySnapshots = (snapshotRows.results ?? []).map((row) => ({ companyId: String(row.companyId), profile: parseStored(row.profileJson), employees: parseStored(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }))
        const directorSnapshots = (directorSnapshotRows.results ?? []).map((row) => ({ playerId: session.player_id, companyId: String(row.companyId), snapshotDay: String(row.snapshotDay), profile: parseStored(row.profileJson), stock: parseStored(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }))
        const pageData = (pageRows.results ?? []).map((row) => ({ pageKey: String(row.pageKey), data: parseStored(row.dataJson), updatedAt: String(row.updatedAt ?? "") }))
        const sharingPreferences = (sharingRows.results ?? []).map((row) => ({ recipientId: String(row.recipientId), shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1, updatedAt: String(row.updatedAt ?? "") }))
        const charts = pageData.find((row) => row.pageKey === "charts")?.data ?? null
        const rankings = pageData.find((row) => row.pageKey === "rankings")?.data ?? {}
        const references = pageData.find((row) => row.pageKey === "references")?.data ?? {}
        const settings = pageData.find((row) => row.pageKey === "settings")?.data ?? {}
        const backup = {
          format: "naughty-company-dashboard-backup", version: 1, exportedAt: new Date().toISOString(), player: { id: session.player_id, name: session.player_name },
          pages: {
            company: { companies, financials }, employees: { companies }, charts: { history: charts, companySnapshots, directorSnapshots },
            rankings, references, settings: { sharingPreferences, preferences: settings },
          },
          storage: { companies, financials, companySnapshots, directorSnapshots, pageData, sharingPreferences },
          excluded: ["Torn API keys and session tokens are intentionally never exported."],
        }
        return jsonResponse(backup, 200, origin, { "cache-control": "no-store" })
      }
      const rawBody = await request.text()
      if (rawBody.length > 10_000_000) return jsonResponse({ error: "The JSON backup is too large. Keep imports under 10 MB." }, 413, origin)
      let parsed: unknown
      try { parsed = JSON.parse(rawBody) as unknown } catch { return jsonResponse({ error: "Upload a valid JSON file." }, 400, origin) }
      if (!isRecord(parsed)) return jsonResponse({ error: "The JSON backup must contain an object at its root." }, 400, origin)
      const master = parsed.format === "naughty-company-dashboard-backup" && parsed.version === 1
      const pageKey = master ? "master" : typeof parsed.pageKey === "string" ? parsed.pageKey : typeof parsed.page === "string" ? parsed.page : "charts"
      if (!master && pageKey !== "master" && !allowedPages.has(pageKey)) return jsonResponse({ error: "Unknown dashboard page in this JSON backup." }, 400, origin)
      if (master) {
        const owner = isRecord(parsed.player) ? String(parsed.player.id ?? "") : ""
        if (!owner || owner !== session.player_id) return jsonResponse({ error: "This master backup belongs to a different dashboard account or has no account owner. Sign in to the matching account before restoring it." }, 403, origin)
        const storage = isRecord(parsed.storage) ? parsed.storage : {}
        const pages = isRecord(parsed.pages) ? parsed.pages : {}
        const chartPage = isRecord(pages.charts) ? pages.charts : {}
        const chartHistory = chartPage.history
        await restoreCompanies(storage.companies)
        await restoreFinancials(storage.financials)
        if (Array.isArray(storage.companySnapshots)) {
          for (const item of storage.companySnapshots.slice(0, 10000)) {
            if (!isRecord(item)) continue
            const companyId = positiveId(item.companyId)
            if (!companyId || item.profile === undefined) continue
            const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : new Date().toISOString()
            const exists = await db.prepare("SELECT snapshot_id FROM company_snapshots WHERE player_id = ? AND company_id = ? AND fetched_at = ? LIMIT 1").bind(session.player_id, companyId, fetchedAt).first<{ snapshot_id: number }>()
            if (!exists) await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(session.player_id, companyId, asJson(item.profile), asJson(item.employees ?? []), fetchedAt).run()
          }
        }
        if (Array.isArray(storage.directorSnapshots)) {
          for (const item of storage.directorSnapshots.slice(0, 10000)) {
            if (!isRecord(item) || (item.playerId != null && String(item.playerId) !== session.player_id)) continue
            const companyId = positiveId(item.companyId)
            const day = typeof item.snapshotDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.snapshotDay) ? item.snapshotDay : null
            if (!companyId || !day || item.profile === undefined) continue
            const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : new Date().toISOString()
            await db.prepare("INSERT OR IGNORE INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").bind(session.player_id, companyId, day, asJson(item.profile), item.stock === undefined ? null : asJson(item.stock), fetchedAt).run()
          }
        }
        const pageData = Array.isArray(storage.pageData) ? storage.pageData : []
        for (const item of pageData.slice(0, 20)) if (isRecord(item) && typeof item.pageKey === "string" && allowedPages.has(item.pageKey)) await upsertPageData(item.pageKey, item.data)
        for (const key of ["rankings", "references", "settings"] as const) if (pages[key] !== undefined) await upsertPageData(key, pages[key])
        if (chartHistory !== undefined && chartHistory !== null) await upsertPageData("charts", chartHistory)
        const settingsPage = isRecord(pages.settings) ? pages.settings : {}
        await restoreSharing(storage.sharingPreferences ?? settingsPage.sharingPreferences)
        await restoreSharing(settingsPage.sharingPreferences)
        return jsonResponse({ imported: true, scope: "master", companies: Array.isArray(storage.companies) ? storage.companies.length : 0, message: "Your personal dashboard records were restored. API keys and sessions were left untouched." }, 200, origin)
      }
      const data = isRecord(parsed.data) ? parsed.data : parsed
      if (pageKey === "charts") {
        const companies = isRecord(data) && Array.isArray(data.companies) ? data.companies : null
        if (!companies || !companies.every((company) => isRecord(company) && (typeof company.companyId === "string" || typeof company.companyId === "number") && Array.isArray(company.history))) return jsonResponse({ error: "Chart imports must use the earlier history JSON format with a companies array and a history array for each company." }, 400, origin)
        await upsertPageData("charts", data)
      } else if (pageKey === "company" || pageKey === "employees") {
        if (!isRecord(data) || !Array.isArray(data.companies)) return jsonResponse({ error: "This page import must be a dashboard page JSON export containing a companies array." }, 400, origin)
        await restoreCompanies(data.companies)
        if (pageKey === "company") await restoreFinancials(data.financials)
      } else if (pageKey === "settings") {
        if (!isRecord(data)) return jsonResponse({ error: "Settings import must be a JSON object." }, 400, origin)
        if (Array.isArray(data.sharingPreferences)) await restoreSharing(data.sharingPreferences)
        await upsertPageData("settings", data)
      } else {
        await upsertPageData(pageKey, data)
      }
      return jsonResponse({ imported: true, page: pageKey, message: `Imported ${pageKey} JSON data.` }, 200, origin)
    }
    if (url.pathname === "/api/me/companies" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const rows = await requireDb(env).prepare("SELECT company_id, company_name, company_type, fetched_at FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all<Record<string, unknown>>()
      const keys = await requireDb(env).prepare("SELECT company_id, company_name, company_type, updated_at FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC").bind(session.player_id).all<Record<string, unknown>>()
      const merged = new Map<string, Record<string, unknown>>()
      for (const row of rows.results ?? []) merged.set(String(row.company_id), row)
      for (const row of keys.results ?? []) { const id = String(row.company_id); const current = merged.get(id); merged.set(id, { company_id: id, company_name: current?.company_name ?? row.company_name, company_type: current?.company_type ?? row.company_type, fetched_at: current?.fetched_at ?? row.updated_at, has_api_key: true }) }
      return jsonResponse({ companies: Array.from(merged.values()).sort((a, b) => String(b.fetched_at ?? "").localeCompare(String(a.fetched_at ?? ""))) }, 200, origin)
    }
    const savedMatch = url.pathname.match(/^\/api\/me\/companies\/(\d+)$/)
    if (savedMatch && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const id = Number(savedMatch[1])
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "Invalid company ID." }, 400, origin)
      const row = await requireDb(env).prepare("SELECT company_id, company_name, company_type, profile_json, employees_json, fetched_at FROM companies WHERE player_id = ? AND company_id = ?").bind(session.player_id, String(id)).first<Record<string, unknown>>()
      if (!row) return jsonResponse({ error: "No saved data for this company yet. Refresh it from the saved company key first." }, 404, origin)
      const financials = await requireDb(env).prepare("SELECT stock_json FROM company_financials WHERE player_id = ? AND company_id = ?").bind(session.player_id, String(id)).first<{ stock_json: string }>()
      const snapshots = await requireDb(env).prepare("SELECT profile_json, fetched_at FROM company_snapshots WHERE player_id = ? AND company_id = ? AND fetched_at >= ? ORDER BY fetched_at ASC").bind(session.player_id, String(id), new Date(Date.now() - 40 * DAY * 1000).toISOString()).all<{ profile_json: string; fetched_at: string }>()
      const incomeHistory = (snapshots.results ?? []).map((snapshot) => {
        const saved = JSON.parse(snapshot.profile_json) as Record<string, unknown>
        const profile = isRecord(saved.company) ? saved.company : isRecord(saved.profile) ? saved.profile : saved
        const income = isRecord(profile.income) ? profile.income : {}
        return { fetchedAt: snapshot.fetched_at, dailyIncome: typeof income.daily === "number" && Number.isFinite(income.daily) ? income.daily : null }
      }).filter((snapshot) => snapshot.dailyIncome !== null)
      return jsonResponse({ companyId: row.company_id, companyName: row.company_name, companyType: row.company_type, profile: JSON.parse(String(row.profile_json)), employees: JSON.parse(String(row.employees_json)), stock: financials ? JSON.parse(financials.stock_json) : null, incomeHistory, fetchedAt: row.fetched_at }, 200, origin)
    }
    if (url.pathname === "/api/company/refresh" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      try {
        const refreshBody: unknown = await request.json().catch(() => null)
        const requestedId = isRecord(refreshBody) && (typeof refreshBody.companyId === "string" || typeof refreshBody.companyId === "number") ? String(refreshBody.companyId) : ""
        let apiKey = requestedId ? await savedCompanyApiKey(env, session.player_id, requestedId) : null
        if (!apiKey && !requestedId) apiKey = await savedCompanyKey(env, session.player_id)
        if (!apiKey) return jsonResponse({ error: requestedId ? "No saved API key for that company. Add its authorized company key first." : "No saved company API key is available. Add an authorized company key first." }, 409, origin)
        const client = new TornApiClient({ apiKey })
        const { profile, employees, stock } = await client.getCompanySelections()
        const companyId = companyIdFromPayload(profile)
        if (!companyId) return jsonResponse({ error: "Torn did not return a valid company ID for this API key's company profile." }, 502, origin)
        if (requestedId && String(companyId) !== requestedId) return jsonResponse({ error: "The saved key returned a different company ID than expected. No company data was changed." }, 409, origin)
        const profileObj = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : {}
        const companyName = typeof profileObj.name === "string" ? profileObj.name : `Company #${companyId}`
        const type = profileObj.type
        const companyType = isRecord(type) && typeof type.name === "string" ? type.name : null
        const now = new Date().toISOString()
        const db = requireDb(env)
        await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(session.player_id, String(companyId), companyName, companyType, asJson(profile), asJson(employees), now).run()
        await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(session.player_id, String(companyId), asJson(profile), asJson(employees), now).run()
        await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(session.player_id, String(companyId), asJson(stock), now).run()
        await persistFactionDirectorSnapshot(env, profile, stock)
        await saveCompanyApiKey(env, session.player_id, companyId, apiKey, profile)
        return jsonResponse({ companyId, companyName, companyType, profile, employees, stock, fetchedAt: now }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    // Compatibility routes use the same key-scoped endpoints; path IDs are ignored intentionally.
    const legacyRoute = url.pathname.match(/^\/api\/company\/(?:\d+\/)?(profile|employees|stock)$/)
    if (legacyRoute && request.method === "GET") {
      const apiKey = request.headers.get("Authorization")?.match(/^ApiKey\s+(.+)$/i)?.[1]?.trim() ?? ""
      if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 401, origin)
      try {
        const client = new TornApiClient({ apiKey })
        const data = legacyRoute[1] === "profile" ? await client.getCompanyProfile() : legacyRoute[1] === "employees" ? await client.getCompanyEmployees() : await client.getCompanyStock()
        return jsonResponse(data, 200, origin, { "cache-control": "private, no-store" })
      } catch (error) { return tornError(error, origin) }
    }
    return jsonResponse({ error: "Route not found." }, 404, origin)
  },
}
