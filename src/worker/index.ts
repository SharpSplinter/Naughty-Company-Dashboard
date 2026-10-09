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
async function validateTornKey(apiKey: string): Promise<{ id: string; name: string }> {
  if (!apiKey || apiKey.length > 256 || /\s/.test(apiKey)) throw new Error("Enter a valid Torn API key.")
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch("https://api.torn.com/v2/user/profile", { headers: { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" }, signal: controller.signal })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok || (isRecord(payload) && isRecord(payload.error))) {
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
      const code = typeof error?.code === "number" ? error.code : undefined
      const status = code === 2 ? 401 : code === 3 ? 403 : code === 9 ? 429 : response.status >= 500 ? 502 : 401
      throw Object.assign(new Error(code === 2 ? "That Torn API key is invalid." : code === 3 ? "This Torn API key does not have profile access." : code === 9 ? "Torn rate limit reached. Try again shortly." : "Could not verify this Torn API key."), { status })
    }
    const profile = isRecord(payload) && isRecord(payload.profile) ? payload.profile : null
    const id = profile?.id ?? profile?.player_id
    const name = profile?.name
    if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id)) || Number(id) <= 0 || typeof name !== "string" || !name.trim()) throw Object.assign(new Error("Torn returned an unexpected player profile."), { status: 502 })
    return { id: String(id), name: name.trim().slice(0, 100) }
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
function companyIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/api\/company\/(\d+)(?:\/(profile|employees|refresh))?$/)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
function tornError(error: unknown, origin: string): Response {
  if (error instanceof TornApiClientError) return jsonResponse({ error: error.message }, error.status, origin, error.retryAfter ? { "retry-after": error.retryAfter } : {})
  const status = isRecord(error) && typeof error.status === "number" ? error.status : 500
  return jsonResponse({ error: error instanceof Error ? error.message : "Unexpected server error." }, status, origin)
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const origin = allowedOrigin(request, env)
    if (!origin) return jsonResponse({ error: "Origin not allowed." }, 403)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type", "access-control-max-age": "86400", vary: "Origin" } })
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") return jsonResponse({ ok: true, service: "naughty-company-api" }, 200, origin)
    if (url.pathname === "/api/auth/sign-in" && request.method === "POST") {
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 400, origin)
        const player = await validateTornKey(apiKey)
        const db = requireDb(env)
        const now = new Date().toISOString()
        await db.prepare("INSERT INTO players (player_id, player_name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, updated_at = excluded.updated_at").bind(player.id, player.name, now, now).run()
        await saveKey(env, player.id, apiKey)
        const token = randomToken()
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * DAY
        await db.prepare("INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), player.id, expiresAt, now).run()
        const meta = await db.prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(player.id).first<{ last_four: string; updated_at: string }>()
        return jsonResponse({ token, expiresAt, player, key: { saved: true, lastFour: meta?.last_four, updatedAt: meta?.updated_at } }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const key = await requireDb(env).prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(session.player_id).first<{ last_four: string; updated_at: string }>()
      return jsonResponse({ player: { id: session.player_id, name: session.player_name }, key: key ? { saved: true, lastFour: key.last_four, updatedAt: key.updated_at } : { saved: false } }, 200, origin)
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
    if (url.pathname === "/api/auth/key" && request.method === "DELETE") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      await requireDb(env).prepare("DELETE FROM api_keys WHERE player_id = ?").bind(session.player_id).run()
      return jsonResponse({ deleted: true, companyDataRetained: true }, 200, origin)
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
      if (token && env.DB) await requireDb(env).prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run()
      return jsonResponse({ signedOut: true }, 200, origin)
    }
    if (url.pathname === "/api/me/companies" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const rows = await requireDb(env).prepare("SELECT company_id, company_name, company_type, fetched_at FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(session.player_id).all()
      return jsonResponse({ companies: rows.results ?? [] }, 200, origin)
    }
    const savedMatch = url.pathname.match(/^\/api\/me\/companies\/(\d+)$/)
    if (savedMatch && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const id = Number(savedMatch[1])
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "Invalid company ID." }, 400, origin)
      const row = await requireDb(env).prepare("SELECT company_id, company_name, company_type, profile_json, employees_json, fetched_at FROM companies WHERE player_id = ? AND company_id = ?").bind(session.player_id, String(id)).first<Record<string, unknown>>()
      if (!row) return jsonResponse({ error: "No saved data for this company yet." }, 404, origin)
      return jsonResponse({ companyId: row.company_id, companyName: row.company_name, companyType: row.company_type, profile: JSON.parse(String(row.profile_json)), employees: JSON.parse(String(row.employees_json)), fetchedAt: row.fetched_at }, 200, origin)
    }
    const companyId = companyIdFromPath(url.pathname)
    if (companyId && url.pathname.endsWith("/refresh") && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      try {
        const apiKey = await savedKey(env, session.player_id)
        if (!apiKey) return jsonResponse({ error: "No Torn API key is saved. Add a key to refresh live data. Previously saved company data is still available." }, 409, origin)
        const client = new TornApiClient({ apiKey })
        const [profile, employees] = await Promise.all([client.getCompanyProfile(companyId), client.getCompanyEmployees(companyId)])
        const profileObj = isRecord(profile) && isRecord(profile.profile) ? profile.profile : {}
        const companyName = typeof profileObj.name === "string" ? profileObj.name : `Company #${companyId}`
        const type = profileObj.type
        const companyType = isRecord(type) && typeof type.name === "string" ? type.name : null
        const now = new Date().toISOString()
        const db = requireDb(env)
        await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(session.player_id, String(companyId), companyName, companyType, asJson(profile), asJson(employees), now).run()
        await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(session.player_id, String(companyId), asJson(profile), asJson(employees), now).run()
        return jsonResponse({ companyId, companyName, companyType, profile, employees, fetchedAt: now }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    const routeMatch = url.pathname.match(/^\/api\/company\/(\d+)\/(profile|employees)$/)
    if (routeMatch && request.method === "GET") {
      const id = Number(routeMatch[1])
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ error: "Invalid company ID." }, 400, origin)
      const apiKey = request.headers.get("Authorization")?.match(/^ApiKey\s+(.+)$/i)?.[1]?.trim() ?? ""
      if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 401, origin)
      try {
        const client = new TornApiClient({ apiKey })
        const data = routeMatch[2] === "profile" ? await client.getCompanyProfile(id) : await client.getCompanyEmployees(id)
        return jsonResponse(data, 200, origin, { "cache-control": "private, no-store" })
      } catch (error) { return tornError(error, origin) }
    }
    return jsonResponse({ error: "Route not found." }, 404, origin)
  },
}
