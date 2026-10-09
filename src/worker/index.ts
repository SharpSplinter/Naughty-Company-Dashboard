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
    const typeId = numberField(row, "company_type", "companyType", "type", "type_id")
    const weeklyIncome = numberField(row, "weekly_income", "weeklyIncome")
    const dailyIncome = numberField(row, "daily_income", "dailyIncome")
    const rating = numberField(row, "rating", "stars", "star_rating")
    return [{ companyId: String(companyId), companyName: row.name || row.companyname || `Company #${companyId}`, companyType: row.companytypename || row.typename || (typeId === null ? "Unknown" : typeNames.get(typeId) || `Type #${typeId}`), companyTypeId: typeId, starRating: rating, weeklyIncome, dailyIncome, averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7, directorName: "", playerId: "torn-global", fetchedAt: new Date().toISOString() }]
  }).sort((a, b) => (Number(b.weeklyIncome ?? -1) - Number(a.weeklyIncome ?? -1)))
  return { companies, snapshotFetchedAt: new Date().toISOString() }
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
  await db.prepare("INSERT INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id, snapshot_day) DO UPDATE SET profile_json = excluded.profile_json, stock_json = COALESCE(excluded.stock_json, faction_director_snapshots.stock_json), fetched_at = excluded.fetched_at")
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

async function refreshFactionDirectoryFromAnyKey(env: WorkerEnv): Promise<void> {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return
  const row = await requireDb(env).prepare("SELECT player_id, ciphertext, iv FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string; ciphertext: string; iv: string }>()
  if (!row) return
  try {
    const apiKey = await decryptKey(env, row.ciphertext, row.iv)
    await syncFactionDirectorDirectory(env, apiKey, 35)
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
  async scheduled(_controller: { scheduledTime: number; cron: string }, env: WorkerEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(Promise.all([refreshRankingProfiles(env), refreshFactionDirectoryFromAnyKey(env)]))
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
      const loginKey = await savedKey(env, session.player_id)
      const directorCheck = loginKey ? await inspectDirectorKey(loginKey, session.player_id) : { isDirector: false }
      let loginKeyHasCompanyAccess = false
      if (loginKey) {
        try { await validateCompanyKey(loginKey); loginKeyHasCompanyAccess = true } catch { /* Keep an existing company key if login access is insufficient. */ }
      }
      // Repair older sessions and promote the login key whenever it can read company data.
      if (loginKey && (loginKeyHasCompanyAccess || directorCheck.isDirector)) {
        await saveCompanyKey(env, session.player_id, loginKey)
        try { const validated = await validateCompanyKey(loginKey); await saveCompanyApiKey(env, session.player_id, validated.companyId, loginKey, validated.profile) } catch { /* Retain an existing company-specific key if this key lacks endpoint access. */ }
      }
      const companyKey = await companyKeyMeta(env, session.player_id)
      return jsonResponse({ player: { id: session.player_id, name: session.player_name }, key: key ? { saved: true, lastFour: key.last_four, updatedAt: key.updated_at } : { saved: false }, company: { isDirector: directorCheck.isDirector, key: companyKey, needsSecondaryKey: !directorCheck.isDirector && !companyKey.saved } }, 200, origin)
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
    if (url.pathname === "/api/rankings" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (url.searchParams.get("scope") === "global") {
        const apiKey = await savedKey(env, session.player_id)
        if (!apiKey) return jsonResponse({ error: "A saved Torn login key is required to load the global company snapshot. Sign in again and save your key." }, 409, origin)
        try {
          const snapshot = await fetchGlobalCompanyRankings(apiKey)
          const requestedType = (url.searchParams.get("type") ?? "").trim().toLocaleLowerCase()
          const companies = requestedType ? snapshot.companies.filter((company) => String(company.companyType ?? "").trim().toLocaleLowerCase() === requestedType) : []
          return jsonResponse({ companies, generatedAt: snapshot.snapshotFetchedAt, source: "Torn API v2 company snapshot", scope: "all-torn", companyType: requestedType || null, incomeDataUpdatesAt: "18:00 UTC daily", starRatingUpdatesAt: "18:00 UTC Sundays" }, 200, origin, { "cache-control": "private, max-age=300" })
        } catch (error) { return tornError(error, origin) }
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
      return jsonResponse({ companies, generatedAt: new Date().toISOString(), source: "Dashboard-connected Naughty Souls companies", scope: "faction", incomeDataUpdatesAt: "18:00 UTC daily", starRatingUpdatesAt: "18:00 UTC Sundays" }, 200, origin)
    }
    if (url.pathname === "/api/faction/directors" && (request.method === "GET" || request.method === "POST")) {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const apiKey = await savedKey(env, session.player_id)
      if (!apiKey) return jsonResponse({ error: "A saved Torn login key is required to discover faction members." }, 409, origin)
      try {
        if (request.method === "GET") {
          const rows = await requireDb(env).prepare("SELECT player_id AS playerId, player_name AS directorName, company_id AS companyId, company_name AS companyName, company_type AS companyType, company_type_id AS companyTypeId, company_rating AS starRating, daily_income AS dailyIncome, weekly_income AS weeklyIncome, updated_at AS fetchedAt FROM faction_member_cache WHERE faction_id = '8317' AND is_director = 1 ORDER BY company_type ASC, weekly_income DESC").all()
          ctx.waitUntil(syncFactionDirectorDirectory(env, apiKey, 20).catch(() => undefined))
          return jsonResponse({ directors: rows.results ?? [], processed: 0, pending: 0, syncing: true, generatedAt: new Date().toISOString(), source: "Torn API v2 faction/members, user/{id}/job, company/{id}/profile" }, 200, origin)
        }
        const synced = await syncFactionDirectorDirectory(env, apiKey, 20)
        return jsonResponse({ ...synced, syncing: false, generatedAt: new Date().toISOString(), source: "Torn API v2 faction/members, user/{id}/job, company/{id}/profile" }, 200, origin)
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
      const snapshots = await db.prepare("SELECT snapshot_day AS day, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? AND company_id = ? ORDER BY snapshot_day ASC LIMIT 120").bind(playerId, String(director.companyId)).all<{ day: string; profileJson: string; stockJson: string | null; fetchedAt: string }>()
      const history = (snapshots.results ?? []).map((row) => {
        let root: Record<string, unknown> = {}
        let stock: unknown = null
        try { root = companyProfileRoot(JSON.parse(row.profileJson)) } catch { /* Ignore a corrupt historical snapshot. */ }
        try { stock = row.stockJson ? JSON.parse(row.stockJson) : null } catch { /* Stock history is optional. */ }
        const income = isRecord(root.income) ? root.income : {}
        return { day: row.day, dailyIncome: typeof income.daily === "number" ? income.daily : null, weeklyIncome: typeof income.weekly === "number" ? income.weekly : null, stock }
      })
      return jsonResponse({ director, history, stockHistoryAvailable: history.some((row) => row.stock !== null), generatedAt: new Date().toISOString() }, 200, origin)
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
