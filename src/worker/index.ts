import { TornApiClient, TornApiClientError } from "../lib/torn/client"
import {
  FACTION_PUBLIC_STAT_COLUMNS,
  parseFactionGymEnergyResponse,
  parseFactionPublicStatsResponse,
  parseFactionRosterResponse,
  parseFactionStatsResponse,
} from "../lib/faction-performance/collector"
import {
  calculateWeeklyMemberResult,
  rankWeeklyMembers,
  utcSundayWindow,
  utcSundayStart,
  WEEK_MS,
  WEEKLY_METRIC_NAMES,
  type WeeklyMemberResult,
  type WeeklyMembership,
  type WeeklyMetricName,
  type WeeklyRankingMetric,
  type WeeklySnapshot,
} from "../lib/faction-performance/weekly"
import { PERSONAL_STATS_HISTORICAL_NAMES } from "../lib/torn/personalstats"
import { parsePrivateLiveBars, parsePrivateLiveCooldowns, parsePrivateLiveNetworth } from "../lib/faction-performance/private-live"
import { officialSnapshotSourceTime, manualRecoverySnapshotSourceTime } from "./snapshot-provenance"
import { evaluateIncomeDrop, evaluateIncomeIncrease, evaluatePercentageDrop, evaluateRosterChange, isSnapshotStale, normalizeWebhookUrl, normalizeAlertThreshold, normalizeCooldownHours } from "../lib/automation/rules"

type D1Result<T = Record<string, unknown>> = { results?: T[]; success?: boolean; meta?: { changes?: number } }
type D1Statement = { bind(...values: (string | number | null)[]): D1Statement; first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<D1Result<T>>; run(): Promise<D1Result> }
type D1Database = {
  prepare(sql: string): D1Statement
  batch?(statements: D1Statement[]): Promise<D1Result[]>
}
type QueueProducer = { send(message: unknown): Promise<unknown> }
type QueueMessage = { body: unknown; attempts?: number; ack(): void; retry(options?: { delaySeconds?: number }): void }
type TornFixtureBinding = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
type WorkerEnv = { ALLOWED_ORIGIN?: string; DB?: D1Database; KEY_ENCRYPTION_SECRET?: string; TORN_FACTION_API_KEY?: string; TORN_API_BASE_URL?: string; TORN_API_FIXTURE?: TornFixtureBinding; GLOBAL_RANKINGS_QUEUE?: QueueProducer }
type Session = { player_id: string; player_name: string; is_admin: number; faction_id?: string | null; faction_verified_at?: string | null; membership_check_attempted_at?: string | null; membership_check_status?: string | null }

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
const DAY = 86400
const ADMIN_PLAYER_ID = "351311"
const NAUGHTY_SOULS_FACTION_ID = "8317"

function jsonResponse(body: unknown, status = 200, origin = "null", extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...jsonHeaders, "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, X-Admin-Confirm-Restore", vary: "Origin", ...extraHeaders } })
}
function allowedOrigin(request: Request, env: WorkerEnv): string | null {
  const incoming = request.headers.get("Origin")
  if (!incoming) return "null"
  const configured = env.ALLOWED_ORIGIN?.trim()
  if (configured && configured !== "*" && incoming === configured) return incoming
  try {
    const url = new URL(incoming)
    const isDashboard = url.protocol === "https:" && (/^(?:[a-z0-9-]+\.)?naughty-company-dashboard\.pages\.dev$/.test(url.hostname) || url.hostname === "naughtyfamily.pages.dev")
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
async function readAdminSetting(env: WorkerEnv, key: string): Promise<unknown> {
  const row = await requireDb(env).prepare("SELECT value_json FROM admin_settings WHERE setting_key = ?").bind(key).first<{ value_json: string }>()
  if (!row) return undefined
  try { return JSON.parse(row.value_json) as unknown } catch { return undefined }
}
async function readAdminBoolean(env: WorkerEnv, key: string, fallback: boolean): Promise<boolean> {
  const value = await readAdminSetting(env, key)
  return typeof value === "boolean" ? value : fallback
}
async function verifyFactionMembershipWithKey(apiKey: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch("https://api.torn.com/v2/user/faction", {
      headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
      signal: controller.signal,
    })
    const payload: unknown = await response.json().catch(() => null)
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    if (!response.ok || error) {
      const code = typeof error?.code === "number" ? error.code : undefined
      throw Object.assign(new Error(code === 9 ? "Torn rate limit reached while checking faction membership." : "Could not refresh current Naughty Souls membership."), { status: code === 9 ? 429 : 502 })
    }
    const faction = isRecord(payload) && isRecord(payload.faction) ? payload.faction : null
    const id = faction?.id ?? (isRecord(payload) ? payload.faction_id : undefined)
    if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id))) return ""
    return String(id)
  } finally { clearTimeout(timeout) }
}

async function revalidateFactionMembershipBatch(env: WorkerEnv, scheduledTime: number, batchSize = 5): Promise<number> {
  if (!env.DB) return 0
  const db = requireDb(env)
  const checkedBefore = new Date(scheduledTime - 30 * 60 * 1000).toISOString()
  const retryBefore = checkedBefore
  const candidates = await db.prepare(
    "SELECT p.player_id AS playerId, p.membership_check_status AS membershipCheckStatus FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.faction_id = ? AND st.disabled_at IS NULL AND (p.membership_check_status = 'cleanup_pending' OR ((p.faction_verified_at IS NULL OR p.faction_verified_at < ?) AND (p.membership_check_attempted_at IS NULL OR p.membership_check_attempted_at < ?))) ORDER BY CASE WHEN p.membership_check_status = 'cleanup_pending' THEN 0 ELSE 1 END, COALESCE(p.membership_check_attempted_at, p.faction_verified_at, p.created_at) ASC LIMIT ?"
  ).bind(NAUGHTY_SOULS_FACTION_ID, checkedBefore, retryBefore, Math.max(1, Math.min(10, batchSize))).all<{ playerId: string; membershipCheckStatus: string | null }>()
  let checked = 0
  for (const candidate of candidates.results ?? []) {
    const playerId = String(candidate.playerId)
    const retryCleanup = candidate.membershipCheckStatus === "cleanup_pending"
    const attemptTime = Date.now()
    const attemptedAt = new Date(attemptTime).toISOString()
    const claimBefore = new Date(attemptTime - 5 * 60 * 1000).toISOString()
    const claim = await db.prepare("UPDATE players SET membership_check_attempted_at = ?, membership_check_status = 'checking' WHERE player_id = ? AND (membership_check_status = 'cleanup_pending' OR membership_check_attempted_at IS NULL OR membership_check_attempted_at < ?)")
      .bind(attemptedAt, playerId, claimBefore).run()
    // The cron candidate list can race with an authenticated request or another
    // scheduler invocation. Only the request that atomically claims this
    // member's check window may contact Torn.
    if (Number(claim.meta?.changes ?? 0) < 1) continue
    const apiKey = await savedKey(env, playerId).catch(() => null)
    if (!apiKey) {
      if (retryCleanup) {
        await db.prepare("UPDATE players SET membership_check_status = 'cleanup_pending' WHERE player_id = ?")
          .bind(playerId).run().catch(() => undefined)
      } else {
        await db.prepare("UPDATE players SET membership_check_status = 'unavailable' WHERE player_id = ? AND membership_check_attempted_at = ?")
          .bind(playerId, attemptedAt).run().catch(() => undefined)
      }
      continue
    }
    try {
      if (checked > 0) await new Promise((resolve) => setTimeout(resolve, 800))
      const factionId = await verifyFactionMembershipWithKey(apiKey)
      checked++
      if (factionId !== NAUGHTY_SOULS_FACTION_ID) {
        try {
          await removeDepartedFactionAccess(env, playerId)
        } catch {
          // A confirmed departure is not an outage. Mark it so authenticated
          // requests and the next sweep fail closed and retry cleanup.
          await db.prepare("UPDATE players SET membership_check_status = 'cleanup_pending' WHERE player_id = ?")
            .bind(playerId).run().catch(() => undefined)
          continue
        }
      }
      const verifiedAt = new Date().toISOString()
      await db.prepare("UPDATE players SET faction_id = ?, faction_verified_at = ?, membership_check_attempted_at = ?, membership_check_status = NULL, updated_at = ? WHERE player_id = ?")
        .bind(factionId || null, verifiedAt, verifiedAt, verifiedAt, playerId).run()
    } catch {
      // Torn network/rate-limit failures are not proof of faction departure.
      // But they must never erase a previously confirmed, pending departure.
      if (retryCleanup) {
        await db.prepare("UPDATE players SET membership_check_status = 'cleanup_pending' WHERE player_id = ?")
          .bind(playerId).run().catch(() => undefined)
      } else {
        await db.prepare("UPDATE players SET membership_check_status = 'unavailable' WHERE player_id = ? AND membership_check_attempted_at = ?")
          .bind(playerId, attemptedAt).run().catch(() => undefined)
      }
      continue
    }
  }
  return checked
}

async function authenticate(request: Request, env: WorkerEnv): Promise<Session | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token || !env.DB) return null
  const hash = await sha256(token)
  const session = await requireDb(env).prepare(
    "SELECT p.player_id, p.player_name, p.faction_id, p.faction_verified_at, p.membership_check_attempted_at, p.membership_check_status, CASE WHEN a.player_id IS NULL THEN 0 ELSE 1 END AS is_admin FROM sessions s JOIN players p ON p.player_id = s.player_id LEFT JOIN administrators a ON a.player_id = p.player_id AND a.revoked_at IS NULL WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(hash, Math.floor(Date.now() / 1000)).first<Session>()
  if (!session) return null
  const normalizedSession = { ...session, is_admin: Number(session.is_admin ?? 0) }
  const status = await requireDb(env).prepare("SELECT disabled_at FROM dashboard_member_status WHERE player_id = ?").bind(session.player_id).first<{ disabled_at: string | null }>()
  if (status?.disabled_at) return null

  // D1 rows on the migrated schema always include faction fields. Undefined
  // is tolerated only by lightweight legacy test doubles.
  if (session.faction_id !== undefined || session.faction_verified_at !== undefined) {
    const nowMs = Date.now()
    const ageMs = session.faction_verified_at ? nowMs - Date.parse(session.faction_verified_at) : Number.POSITIVE_INFINITY
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60 * 1000
    if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID || !fresh) {
      const apiKey = await savedKey(env, session.player_id)
      if (!apiKey) return null

      // A confirmed departure whose cleanup failed must never use the outage
      // grace. It can only recover through another successful check+cleanup.
      const attemptAgeMs = session.membership_check_attempted_at
        ? nowMs - Date.parse(session.membership_check_attempted_at)
        : Number.POSITIVE_INFINITY
      const attemptedRecently = Number.isFinite(attemptAgeMs) && attemptAgeMs >= 0 && attemptAgeMs <= 5 * 60 * 1000
      const retryCleanup = session.membership_check_status === "cleanup_pending"
      if (attemptedRecently && session.membership_check_status === "unavailable") {
        if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60 * 1000) return null
      } else if (attemptedRecently && !retryCleanup) {
        // 'checking' means another request or sweep owns the claim. Unknown
        // legacy state also fails closed rather than assuming an outage.
        return null
      } else {
        const attemptedAt = new Date(nowMs).toISOString()
        const claimBefore = new Date(nowMs - 5 * 60 * 1000).toISOString()
        const claim = await requireDb(env).prepare("UPDATE players SET membership_check_attempted_at = ?, membership_check_status = 'checking' WHERE player_id = ? AND (membership_check_status = 'cleanup_pending' OR membership_check_attempted_at IS NULL OR membership_check_attempted_at < ?)")
          .bind(attemptedAt, session.player_id, claimBefore).run()
        if (Number(claim.meta?.changes ?? 0) < 1) {
          // Another request or the scheduled sweep claimed this check window.
          // Only an already-recorded genuine outage may use bounded grace.
          if (session.membership_check_status !== "unavailable" || session.faction_id !== NAUGHTY_SOULS_FACTION_ID || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60 * 1000) return null
        } else {
          let currentFactionId: string
          let verified = true
          try {
            currentFactionId = await verifyFactionMembershipWithKey(apiKey)
          } catch {
            if (retryCleanup) {
              // A previously confirmed departure remains fail-closed even if
              // Torn becomes unavailable while cleanup is being retried.
              await requireDb(env).prepare("UPDATE players SET membership_check_status = 'cleanup_pending' WHERE player_id = ?")
                .bind(session.player_id).run().catch(() => undefined)
              return null
            }
            await requireDb(env).prepare("UPDATE players SET membership_check_status = 'unavailable' WHERE player_id = ? AND membership_check_attempted_at = ?")
              .bind(session.player_id, attemptedAt).run().catch(() => undefined)
            // A short outage grace is tied to the last successful verification,
            // never to the attempted check timestamp. Do not refresh it here.
            if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60 * 1000) return null
            normalizedSession.membership_check_attempted_at = attemptedAt
            normalizedSession.membership_check_status = "unavailable"
            currentFactionId = NAUGHTY_SOULS_FACTION_ID
            verified = false
          }
          if (currentFactionId !== NAUGHTY_SOULS_FACTION_ID) {
            // Departure is authoritative. Failed cleanup remains explicitly
            // pending, so the next request cannot mistake it for a Torn outage.
            try { await removeDepartedFactionAccess(env, session.player_id) }
            catch {
              await requireDb(env).prepare("UPDATE players SET membership_check_status = 'cleanup_pending' WHERE player_id = ?")
                .bind(session.player_id).run().catch(() => undefined)
              return null
            }
            const verifiedAt = new Date().toISOString()
            await requireDb(env).prepare("UPDATE players SET faction_id = ?, faction_verified_at = ?, membership_check_attempted_at = ?, membership_check_status = NULL, updated_at = ? WHERE player_id = ?")
              .bind(currentFactionId || null, verifiedAt, verifiedAt, verifiedAt, session.player_id).run()
            return null
          }
          if (verified) {
            const verifiedAt = new Date().toISOString()
            await requireDb(env).prepare("UPDATE players SET faction_id = ?, faction_verified_at = ?, membership_check_attempted_at = ?, membership_check_status = NULL, updated_at = ? WHERE player_id = ?")
              .bind(currentFactionId, verifiedAt, attemptedAt, verifiedAt, session.player_id).run()
            normalizedSession.faction_id = currentFactionId
            normalizedSession.faction_verified_at = verifiedAt
            normalizedSession.membership_check_attempted_at = attemptedAt
            normalizedSession.membership_check_status = null
          }
        }
      }
    }
  }

  const maintenanceMode = await readAdminBoolean(env, "maintenanceMode", false)
  if (maintenanceMode && normalizedSession.is_admin !== 1) return null
  return normalizedSession
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

async function fetchPrivateLiveSelection(apiKey: string, selection: "bars" | "cooldowns" | "networth"): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch("https://api.torn.com/v2/user/" + selection, {
      headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
      signal: controller.signal,
    })
    const payload: unknown = await response.json().catch(() => null)
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    if (!response.ok || error) {
      const code = typeof error?.code === "number" ? error.code : undefined
      const status = code === 2 || code === 18 ? 401
        : code === 5 || code === 14 ? 429
        : code === 7 || code === 10 || code === 13 || code === 16 ? 403
        : code === 9 || code === 17 ? 503
        : code === 3 || code === 4 || code === 6 ? 400
        : response.status >= 500 ? 502 : 502
      const message = code === 2 ? "The private live Torn API key is invalid."
        : code === 3 || code === 4 ? "Torn rejected the requested private live selection. Check the selection and try again."
        : code === 5 ? "Torn rate limit reached. Wait before refreshing your private live data."
        : code === 7 ? "Torn denied this owner-only data selection for the submitted request."
        : code === 10 ? "The key owner is in federal jail. Your saved key and last successful snapshot were retained."
        : code === 13 ? "Torn temporarily disabled this key because its owner has been inactive. Your last successful snapshot was retained."
        : code === 14 ? "Torn's daily API read limit has been reached. Your key and last successful snapshot were retained."
        : code === 16 ? "This key does not have permission for the requested private Torn selection."
        : code === 18 ? "This Torn API key has been paused by its owner."
        : code === 9 ? "Torn's API is temporarily unavailable. Try again shortly."
        : code === 17 ? "Torn reported a temporary backend error. Your last successful snapshot was retained."
        : "Torn could not provide the requested private live data."
      throw new TornApiClientError(message, { status, code })
    }
    return payload
  } catch (error) {
    if (error instanceof TornApiClientError) throw error
    if (error instanceof Error && error.name === "AbortError") {
      throw new TornApiClientError("Torn's private live API request timed out.", { status: 504 })
    }
    throw new TornApiClientError("Could not reach Torn to refresh private live data.", { status: 502 })
  } finally { clearTimeout(timeout) }
}

async function validatePrivateLiveKeyOwner(apiKey: string, playerId: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch("https://api.torn.com/v2/key/info", {
      headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
      signal: controller.signal,
    })
    const payload: unknown = await response.json().catch(() => null)
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
    if (!response.ok || error) {
      const code = typeof error?.code === "number" ? error.code : undefined
      const status = code === 2 ? 401 : code === 5 ? 429 : response.status >= 500 ? 502 : 400
      throw new TornApiClientError(code === 5 ? "Torn rate limit reached while validating your private live key." : "Torn could not validate this private live API key.", { status, code })
    }
    const root = isRecord(payload) && isRecord(payload.info) ? payload.info : null
    const owner = isRecord(root?.user) ? root.user.id : isRecord(payload) && isRecord(payload.user) ? payload.user.id : undefined
    if (String(owner ?? "") !== playerId) {
      throw new TornApiClientError("That key belongs to a different Torn player. Connect a key created on your own account.", { status: 403 })
    }
  } catch (error) {
    if (error instanceof TornApiClientError) throw error
    if (error instanceof Error && error.name === "AbortError") {
      throw new TornApiClientError("Torn's key validation request timed out.", { status: 504 })
    }
    throw new TornApiClientError("Could not reach Torn to validate your private live key.", { status: 502 })
  } finally { clearTimeout(timeout) }
}

async function fetchPrivateLiveBase(apiKey: string): Promise<{ bars: ReturnType<typeof parsePrivateLiveBars>; cooldowns: ReturnType<typeof parsePrivateLiveCooldowns> }> {
  const [barsPayload, cooldownsPayload] = await Promise.all([
    fetchPrivateLiveSelection(apiKey, "bars"),
    fetchPrivateLiveSelection(apiKey, "cooldowns"),
  ])
  return {
    bars: parsePrivateLiveBars(barsPayload),
    cooldowns: parsePrivateLiveCooldowns(cooldownsPayload),
  }
}

function privateLiveSafeError(error: unknown): { status: number; message: string; code?: number } {
  if (error instanceof TornApiClientError) return { status: error.status, message: error.message, code: error.code }
  if (error instanceof Error && /Torn did not return|Torn returned/.test(error.message)) {
    return { status: 502, message: error.message }
  }
  return { status: 502, message: "Private live collection failed. The previous successful snapshot has been retained." }
}

function privateLiveKeyMustBeRevoked(error: unknown): boolean {
  // Permanently invalid keys, owner-paused keys, or keys that have lost the
  // required private selections are disconnected. Temporary owner states
  // (federal jail/inactivity), rate limits and API outages retain the key and
  // the last known snapshot until the member explicitly retries.
  return error instanceof TornApiClientError && [2, 16, 18].includes(Number(error.code))
}

function safeStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return null
  try { return JSON.parse(value) as unknown } catch { return null }
}

type FactionPerformanceRunRow = {
  runId: string
  factionId: string
  collectionKind: "roster" | "personalstats" | "gym_energy"
  status: "queued" | "running" | "completed" | "partial" | "failed"
  scheduledAt: string
  targetUserIdsJson: string | null
  nextIndex: number
  lastEnqueuedAt: string | null
}

const FACTION_PERFORMANCE_PAGE_SIZE = 5
const FACTION_PERFORMANCE_QUEUE_KIND = "faction-performance-collection"
const FACTION_STATS_QUEUE_KIND = "faction-stats-collection"

function factionCollectionSafeError(error: unknown): { summary: string; tornCode: number | null } {
  if (error instanceof Error && (
    error.message === "Faction performance collection exhausted its queue retries." ||
    error.message === "Faction stats collection exhausted its queue retries."
  )) {
    return { summary: error.message, tornCode: null }
  }
  if (error instanceof TornApiClientError) {
    return {
      summary: error.code === undefined ? "Torn API request failed." : `Torn API error ${error.code}.`,
      tornCode: typeof error.code === "number" ? error.code : null,
    }
  }
  return { summary: "Collection failed due to an upstream or storage error.", tornCode: null }
}

async function finishFactionPerformanceRun(
  env: WorkerEnv,
  run: FactionPerformanceRunRow,
  status: "completed" | "partial",
  capturedAt: string,
  error: string | null = null,
): Promise<void> {
  const now = new Date().toISOString()
  const db = requireDb(env)
  const finishRun = db.prepare(
    "UPDATE faction_performance_collection_runs SET status = ?, completed_at = ?, last_error = ?, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed', 'partial', 'failed')"
  ).bind(status, now, error, now, run.runId)
  // A partial capture is not a last fully successful collection. Preserve
  // the previous last_success_at while still recording this run and its error.
  const updateState = db.prepare(
    "INSERT INTO faction_performance_collection_state (faction_id, collection_kind, last_success_at, last_run_id, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(faction_id, collection_kind) DO UPDATE SET last_success_at = COALESCE(excluded.last_success_at, faction_performance_collection_state.last_success_at), last_run_id = excluded.last_run_id, last_error = excluded.last_error, updated_at = excluded.updated_at"
  ).bind(run.factionId, run.collectionKind, status === "completed" ? capturedAt : null, run.runId, error, now)
  if (db.batch) {
    // D1 batch is transactional: a state-write failure must roll back the
    // terminal run status so the retried queue message can finish both writes.
    await db.batch([finishRun, updateState])
  } else {
    // Lightweight test doubles may expose only prepare(). Production D1 always
    // supports batch(), which keeps the success marker and run state atomic.
    await finishRun.run()
    await updateState.run()
  }
}

async function markFactionPerformanceRunFailed(env: WorkerEnv, runId: string, error: unknown): Promise<void> {
  if (!env.DB) return
  const safe = factionCollectionSafeError(error)
  const now = new Date().toISOString()
  const db = requireDb(env)
  const run = await db.prepare(
    "SELECT faction_id AS factionId, collection_kind AS collectionKind, status FROM faction_performance_collection_runs WHERE run_id = ?"
  ).bind(runId).first<{ factionId: string; collectionKind: FactionPerformanceRunRow["collectionKind"]; status: FactionPerformanceRunRow["status"] }>()
  if (!run || run.status === "completed" || run.status === "partial" || run.status === "failed") return

  const failRun = db.prepare(
    "UPDATE faction_performance_collection_runs SET status = 'failed', completed_at = ?, last_error = ?, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed', 'partial', 'failed')"
  ).bind(now, safe.summary, now, runId)
  const failState = db.prepare(
    "INSERT INTO faction_performance_collection_state (faction_id, collection_kind, last_success_at, last_run_id, last_error, updated_at) VALUES (?, ?, NULL, ?, ?, ?) ON CONFLICT(faction_id, collection_kind) DO UPDATE SET last_run_id = excluded.last_run_id, last_error = excluded.last_error, updated_at = excluded.updated_at"
  ).bind(run.factionId, run.collectionKind, runId, safe.summary, now)
  if (db.batch) {
    // Keep the run's terminal failure and collection status in one D1 transaction.
    await db.batch([failRun, failState])
  } else {
    await failRun.run()
    await failState.run()
  }
}


async function markFactionStatsRunFailed(env: WorkerEnv, runId: string, error: unknown): Promise<void> {
  if (!env.DB) return
  const safe = factionCollectionSafeError(error)
  const now = new Date().toISOString()
  const db = requireDb(env)
  const run = await db.prepare(
    "SELECT faction_id AS factionId, status FROM faction_stats_collection_runs WHERE run_id = ?"
  ).bind(runId).first<{ factionId: string; status: string }>()
  if (!run || ["completed", "failed"].includes(run.status)) return
  const failRun = db.prepare(
    "UPDATE faction_stats_collection_runs SET status = 'failed', completed_at = ?, last_error = ?, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed', 'failed')"
  ).bind(now, safe.summary, now, runId)
  const failState = db.prepare(
    "INSERT INTO faction_stats_collection_state (faction_id, last_success_at, last_run_id, last_error, updated_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT(faction_id) DO UPDATE SET last_run_id = excluded.last_run_id, last_error = excluded.last_error, updated_at = excluded.updated_at"
  ).bind(run.factionId, runId, safe.summary, now)
  if (db.batch) await db.batch([failRun, failState])
  else { await failRun.run(); await failState.run() }
}

async function enqueueOneFactionPerformanceRun(
  env: WorkerEnv,
  scheduledTime: number,
  kind: FactionPerformanceRunRow["collectionKind"],
  intervalMs: number,
): Promise<boolean> {
  if (!env.DB || !env.GLOBAL_RANKINGS_QUEUE || !env.TORN_FACTION_API_KEY?.trim()) return false
  const db = requireDb(env)
  const bucketStart = Math.floor(scheduledTime / intervalMs) * intervalMs
  const scheduledAt = new Date(bucketStart).toISOString()
  const collectionKey = `${NAUGHTY_SOULS_FACTION_ID}:${kind}:${bucketStart}`
  let targetUserIds: string[] | null = null

  if (kind === "personalstats") {
    const active = await db.prepare(
      "SELECT user_id AS userId FROM faction_membership_intervals WHERE faction_id = ? AND left_observed_at IS NULL ORDER BY user_id"
    ).bind(NAUGHTY_SOULS_FACTION_ID).all<{ userId: string }>()
    targetUserIds = Array.from(new Set((active.results ?? []).map((row) => String(row.userId)).filter((id) => /^[1-9]\d*$/.test(id))))
    if (!targetUserIds.length) return false
  }

  let run = await db.prepare(
    "SELECT run_id AS runId, faction_id AS factionId, collection_kind AS collectionKind, status, scheduled_at AS scheduledAt, target_user_ids_json AS targetUserIdsJson, next_index AS nextIndex, last_enqueued_at AS lastEnqueuedAt FROM faction_performance_collection_runs WHERE collection_key = ?"
  ).bind(collectionKey).first<FactionPerformanceRunRow>()

  if (!run) {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    await db.prepare(
      "INSERT OR IGNORE INTO faction_performance_collection_runs (run_id, collection_key, faction_id, collection_kind, status, scheduled_at, target_user_ids_json, next_index, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)"
    ).bind(runId, collectionKey, NAUGHTY_SOULS_FACTION_ID, kind, scheduledAt, targetUserIds ? asJson(targetUserIds) : null, now, now).run()
    run = await db.prepare(
      "SELECT run_id AS runId, faction_id AS factionId, collection_kind AS collectionKind, status, scheduled_at AS scheduledAt, target_user_ids_json AS targetUserIdsJson, next_index AS nextIndex, last_enqueued_at AS lastEnqueuedAt FROM faction_performance_collection_runs WHERE collection_key = ?"
    ).bind(collectionKey).first<FactionPerformanceRunRow>()
  }
  if (!run || run.status === "completed" || run.status === "partial" || run.status === "failed") return false

  const lastEnqueuedMs = run.lastEnqueuedAt ? Date.parse(run.lastEnqueuedAt) : Number.NEGATIVE_INFINITY
  const staleAfterMs = run.status === "running" ? 10 * 60 * 1000 : 4 * 60 * 1000
  if (Number.isFinite(lastEnqueuedMs) && scheduledTime - lastEnqueuedMs < staleAfterMs) return false

  await env.GLOBAL_RANKINGS_QUEUE.send({ kind: FACTION_PERFORMANCE_QUEUE_KIND, runId: run.runId })
  const enqueuedAt = new Date().toISOString()
  await db.prepare(
    "UPDATE faction_performance_collection_runs SET last_enqueued_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')"
  ).bind(enqueuedAt, enqueuedAt, String(run.runId)).run()
  return true
}


async function enqueueFactionStatsCollection(env: WorkerEnv, scheduledTime: number): Promise<boolean> {
  if (!env.DB || !env.GLOBAL_RANKINGS_QUEUE || !env.TORN_FACTION_API_KEY?.trim()) return false
  const db = requireDb(env)
  const intervalMs = 15 * 60 * 1000
  const bucketStart = Math.floor(scheduledTime / intervalMs) * intervalMs
  const scheduledAt = new Date(bucketStart).toISOString()
  const collectionKey = `${NAUGHTY_SOULS_FACTION_ID}:faction_stats:${bucketStart}`
  let run = await db.prepare(
    "SELECT run_id AS runId, status, last_enqueued_at AS lastEnqueuedAt FROM faction_stats_collection_runs WHERE collection_key = ?"
  ).bind(collectionKey).first<{ runId: string; status: string; lastEnqueuedAt: string | null }>()
  if (!run) {
    const now = new Date().toISOString()
    const runId = crypto.randomUUID()
    await db.prepare(
      "INSERT OR IGNORE INTO faction_stats_collection_runs (run_id, collection_key, faction_id, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)"
    ).bind(runId, collectionKey, NAUGHTY_SOULS_FACTION_ID, scheduledAt, now, now).run()
    run = await db.prepare(
      "SELECT run_id AS runId, status, last_enqueued_at AS lastEnqueuedAt FROM faction_stats_collection_runs WHERE collection_key = ?"
    ).bind(collectionKey).first<{ runId: string; status: string; lastEnqueuedAt: string | null }>()
  }
  if (!run || ["completed", "failed"].includes(run.status)) return false
  const lastEnqueuedMs = run.lastEnqueuedAt ? Date.parse(run.lastEnqueuedAt) : Number.NEGATIVE_INFINITY
  const staleAfterMs = run.status === "running" ? 10 * 60 * 1000 : 4 * 60 * 1000
  if (Number.isFinite(lastEnqueuedMs) && scheduledTime - lastEnqueuedMs < staleAfterMs) return false
  await env.GLOBAL_RANKINGS_QUEUE.send({ kind: FACTION_STATS_QUEUE_KIND, runId: run.runId })
  const enqueuedAt = new Date().toISOString()
  await db.prepare(
    "UPDATE faction_stats_collection_runs SET last_enqueued_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')"
  ).bind(enqueuedAt, enqueuedAt, String(run.runId)).run()
  return true
}

async function runFactionStatsCollection(env: WorkerEnv, runId: string): Promise<void> {
  const db = requireDb(env)
  const run = await db.prepare(
    "SELECT run_id AS runId, faction_id AS factionId, status, scheduled_at AS scheduledAt FROM faction_stats_collection_runs WHERE run_id = ?"
  ).bind(runId).first<{ runId: string; factionId: string; status: string; scheduledAt: string }>()
  if (!run || ["completed", "failed"].includes(run.status)) return
  const apiKey = env.TORN_FACTION_API_KEY?.trim()
  if (!apiKey) throw new Error("Faction collector secret is not configured.")
  const startedAt = new Date().toISOString()
  await db.prepare(
    "UPDATE faction_stats_collection_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')"
  ).bind(startedAt, startedAt, runId).run()
  const client = new TornApiClient({
    apiKey,
    baseUrl: env.TORN_API_BASE_URL,
    fetcher: env.TORN_API_FIXTURE?.fetch.bind(env.TORN_API_FIXTURE),
  })
  const parsed = parseFactionStatsResponse(await client.getFactionStats())
  const capturedAt = new Date().toISOString()
  const snapshot = db.prepare(
    "INSERT INTO faction_stats_snapshots (run_id, faction_id, captured_at, scheduled_at, collection_status, stats_json, missing_stat_names_json, unexpected_stat_names_json, returned_stat_count, response_version) VALUES (?, ?, ?, ?, 'complete', ?, ?, ?, ?, 'torn-v2') ON CONFLICT(run_id) DO UPDATE SET captured_at = excluded.captured_at, scheduled_at = excluded.scheduled_at, collection_status = excluded.collection_status, stats_json = excluded.stats_json, missing_stat_names_json = excluded.missing_stat_names_json, unexpected_stat_names_json = excluded.unexpected_stat_names_json, returned_stat_count = excluded.returned_stat_count"
  ).bind(runId, run.factionId, capturedAt, run.scheduledAt, asJson(parsed.stats), asJson(parsed.missingStatNames), asJson(parsed.unexpectedStatNames), parsed.stats.length)
  const finishRun = db.prepare(
    "UPDATE faction_stats_collection_runs SET status = 'completed', completed_at = ?, last_error = NULL, updated_at = ? WHERE run_id = ? AND status NOT IN ('completed', 'failed')"
  ).bind(capturedAt, capturedAt, runId)
  const updateState = db.prepare(
    "INSERT INTO faction_stats_collection_state (faction_id, last_success_at, last_run_id, last_error, updated_at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(faction_id) DO UPDATE SET last_success_at = excluded.last_success_at, last_run_id = excluded.last_run_id, last_error = NULL, updated_at = excluded.updated_at"
  ).bind(run.factionId, capturedAt, runId, capturedAt)
  if (!db.batch) throw new Error("D1 transactional batch support is required to save faction-wide stats.")
  await db.batch([snapshot, finishRun, updateState])
}

async function enqueueFactionPerformanceCollections(env: WorkerEnv, scheduledTime: number): Promise<number> {
  // Dedicated Cloudflare Worker secret. Never substitute a member login key.
  if (!env.DB || !env.GLOBAL_RANKINGS_QUEUE || !env.TORN_FACTION_API_KEY?.trim()) return 0
  let enqueued = 0
  if (await enqueueOneFactionPerformanceRun(env, scheduledTime, "roster", 5 * 60 * 1000)) enqueued += 1
  const fiveMinuteBucket = Math.floor(scheduledTime / (5 * 60 * 1000))
  if (fiveMinuteBucket % 3 === 0) {
    if (await enqueueOneFactionPerformanceRun(env, scheduledTime, "personalstats", 15 * 60 * 1000)) enqueued += 1
    if (await enqueueOneFactionPerformanceRun(env, scheduledTime, "gym_energy", 15 * 60 * 1000)) enqueued += 1
    if (await enqueueFactionStatsCollection(env, scheduledTime)) enqueued += 1
  }
  return enqueued
}

async function enqueueFactionWeeklyBoundaryRun(env: WorkerEnv, scheduledTime: number): Promise<boolean> {
  if (!env.DB || !env.GLOBAL_RANKINGS_QUEUE || !env.TORN_FACTION_API_KEY?.trim()) return false
  const db = requireDb(env)
  const boundaryMs = utcSundayStart(scheduledTime)
  const boundaryAt = new Date(boundaryMs).toISOString()
  let boundary = await db.prepare(
    "SELECT stats_run_id AS statsRunId, gym_energy_run_id AS gymEnergyRunId FROM faction_weekly_boundary_runs WHERE faction_id = ? AND boundary_at = ?"
  ).bind(NAUGHTY_SOULS_FACTION_ID, boundaryAt).first<{ statsRunId: string; gymEnergyRunId: string }>()
  if (!boundary) {
    // Freeze the cohort that was known to be in-faction at this exact
    // Sunday boundary. A delayed scheduler must still include members who
    // left after the boundary, while excluding people who joined afterward.
    const active = await db.prepare(
      "SELECT user_id AS userId FROM faction_membership_intervals WHERE faction_id = ? AND COALESCE(estimated_joined_at, first_seen_at) <= ? AND (left_observed_at IS NULL OR left_observed_at > ?) ORDER BY user_id"
    ).bind(NAUGHTY_SOULS_FACTION_ID, boundaryAt, boundaryAt).all<{ userId: string }>()
    const targetUserIds = Array.from(new Set((active.results ?? [])
      .map((row) => String(row.userId))
      .filter((id) => /^[1-9]\d*$/.test(id))))
    // The roster refresh is queued earlier in this scheduler tick. If this is
    // a fresh install with no observed membership intervals yet, do not lock
    // an empty Sunday baseline. Retry on the next five-minute tick instead.
    if (!targetUserIds.length) return false
    const statsRunId = crypto.randomUUID()
    const gymRunId = crypto.randomUUID()
    const now = new Date().toISOString()
    const statsKey = `${NAUGHTY_SOULS_FACTION_ID}:personalstats:weekly-boundary:${boundaryMs}`
    const gymKey = `${NAUGHTY_SOULS_FACTION_ID}:gym_energy:weekly-boundary:${boundaryMs}`
    await db.prepare(
      "INSERT OR IGNORE INTO faction_performance_collection_runs (run_id, collection_key, faction_id, collection_kind, status, scheduled_at, target_user_ids_json, next_index, created_at, updated_at) VALUES (?, ?, ?, 'personalstats', 'queued', ?, ?, 0, ?, ?)"
    ).bind(statsRunId, statsKey, NAUGHTY_SOULS_FACTION_ID, boundaryAt, asJson(targetUserIds), now, now).run()
    await db.prepare(
      "INSERT OR IGNORE INTO faction_performance_collection_runs (run_id, collection_key, faction_id, collection_kind, status, scheduled_at, target_user_ids_json, next_index, created_at, updated_at) VALUES (?, ?, ?, 'gym_energy', 'queued', ?, NULL, 0, ?, ?)"
    ).bind(gymRunId, gymKey, NAUGHTY_SOULS_FACTION_ID, boundaryAt, now, now).run()
    const [savedStatsRun, savedGymRun] = await Promise.all([
      db.prepare("SELECT run_id AS runId FROM faction_performance_collection_runs WHERE collection_key = ?")
        .bind(statsKey).first<{ runId: string }>(),
      db.prepare("SELECT run_id AS runId FROM faction_performance_collection_runs WHERE collection_key = ?")
        .bind(gymKey).first<{ runId: string }>(),
    ])
    if (!savedStatsRun || !savedGymRun) throw new Error("Weekly boundary collection runs could not be initialized.")
    await db.prepare(
      "INSERT OR IGNORE INTO faction_weekly_boundary_runs (faction_id, boundary_at, stats_run_id, gym_energy_run_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(NAUGHTY_SOULS_FACTION_ID, boundaryAt, savedStatsRun.runId, savedGymRun.runId, now).run()
    boundary = await db.prepare(
      "SELECT stats_run_id AS statsRunId, gym_energy_run_id AS gymEnergyRunId FROM faction_weekly_boundary_runs WHERE faction_id = ? AND boundary_at = ?"
    ).bind(NAUGHTY_SOULS_FACTION_ID, boundaryAt).first<{ statsRunId: string; gymEnergyRunId: string }>()
  }
  if (!boundary) return false

  let enqueued = false
  for (const runId of [boundary.statsRunId, boundary.gymEnergyRunId]) {
    const run = await db.prepare(
      "SELECT status, last_enqueued_at AS lastEnqueuedAt FROM faction_performance_collection_runs WHERE run_id = ?"
    ).bind(runId).first<{ status: string; lastEnqueuedAt: string | null }>()
    if (!run || ["completed", "partial", "failed"].includes(run.status)) continue
    const lastEnqueuedMs = run.lastEnqueuedAt ? Date.parse(run.lastEnqueuedAt) : Number.NEGATIVE_INFINITY
    const retryAfter = run.status === "running" ? 10 * 60 * 1000 : 4 * 60 * 1000
    if (Number.isFinite(lastEnqueuedMs) && scheduledTime - lastEnqueuedMs < retryAfter) continue
    await env.GLOBAL_RANKINGS_QUEUE.send({ kind: FACTION_PERFORMANCE_QUEUE_KIND, runId })
    const enqueuedAt = new Date().toISOString()
    await db.prepare(
      "UPDATE faction_performance_collection_runs SET last_enqueued_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')"
    ).bind(enqueuedAt, enqueuedAt, runId).run()
    enqueued = true
  }
  return enqueued
}


async function finalizeFactionWeeklyReport(env: WorkerEnv, weekStartMs: number): Promise<boolean> {
  if (!env.DB || !Number.isFinite(weekStartMs)) return false
  const db = requireDb(env)
  const weekStartAt = new Date(utcSundayStart(weekStartMs)).toISOString()
  const weekEndAt = new Date(Date.parse(weekStartAt) + WEEK_MS).toISOString()
  const existing = await db.prepare(
    "SELECT report_status AS reportStatus FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at = ?"
  ).bind(NAUGHTY_SOULS_FACTION_ID, weekStartAt).first<{ reportStatus: string }>()
  if (existing) return false

  const boundaries = await db.prepare(
    "SELECT boundary_at AS boundaryAt, stats_run_id AS statsRunId, gym_energy_run_id AS gymEnergyRunId FROM faction_weekly_boundary_runs WHERE faction_id = ? AND boundary_at IN (?, ?)"
  ).bind(NAUGHTY_SOULS_FACTION_ID, weekStartAt, weekEndAt).all<{
    boundaryAt: string; statsRunId: string; gymEnergyRunId: string
  }>()
  const boundaryByAt = new Map((boundaries.results ?? []).map((row) => [row.boundaryAt, row]))
  const startBoundary = boundaryByAt.get(weekStartAt)
  const endBoundary = boundaryByAt.get(weekEndAt)
  if (!startBoundary || !endBoundary) return false

  const runIds = [
    startBoundary.statsRunId, endBoundary.statsRunId,
    startBoundary.gymEnergyRunId, endBoundary.gymEnergyRunId,
  ]
  const placeholders = runIds.map(() => "?").join(",")
  const runRows = await db.prepare(
    `SELECT run_id AS runId, collection_kind AS collectionKind, status FROM faction_performance_collection_runs WHERE run_id IN (${placeholders})`
  ).bind(...runIds).all<{ runId: string; collectionKind: string; status: string }>()
  const runsById = new Map((runRows.results ?? []).map((row) => [row.runId, row]))
  const allTerminal = runIds.every((runId) => {
    const status = runsById.get(runId)?.status
    return status === "completed" || status === "partial" || status === "failed"
  })
  if (!allTerminal) return false

  const now = new Date().toISOString()
  const [membersRows, statsRows, gymRows, captureRows] = await Promise.all([
    db.prepare(
      "SELECT user_id AS userId, member_name AS name, position, level, estimated_joined_at AS estimatedJoinedAt, first_seen_at AS firstSeenAt, left_observed_at AS leftObservedAt FROM faction_membership_intervals WHERE faction_id = ? AND first_seen_at < ? AND (left_observed_at IS NULL OR left_observed_at > ?) ORDER BY member_name COLLATE NOCASE, user_id"
    ).bind(NAUGHTY_SOULS_FACTION_ID, weekEndAt, weekStartAt).all<WeeklyMembership>(),
    db.prepare(
      "SELECT snapshot_id AS snapshotId, run_id AS runId, user_id AS userId, captured_at AS capturedAt, scheduled_at AS scheduledAt, collection_status AS collectionStatus, xantaken, lsdtaken, drugsused, overdosed, alcoholused, boostersused, energydrinkused, refills, statenhancersused, networth, cantaken, exttaken, kettaken, opitaken, shrtaken, spetaken, pcptaken, victaken FROM faction_member_stat_snapshots WHERE faction_id = ? AND ((captured_at >= ? AND captured_at < ?) OR run_id IN (?, ?)) ORDER BY user_id, captured_at, snapshot_id"
    ).bind(NAUGHTY_SOULS_FACTION_ID, weekStartAt, weekEndAt, startBoundary.statsRunId, endBoundary.statsRunId).all<WeeklySnapshot>(),
    db.prepare(
      "SELECT snapshot_id AS snapshotId, run_id AS runId, user_id AS userId, captured_at AS capturedAt, gym_energy_total AS gymEnergyTotal, collection_status AS collectionStatus FROM faction_gym_energy_snapshots WHERE faction_id = ? AND ((captured_at >= ? AND captured_at < ?) OR run_id IN (?, ?)) ORDER BY user_id, captured_at, snapshot_id"
    ).bind(NAUGHTY_SOULS_FACTION_ID, weekStartAt, weekEndAt, startBoundary.gymEnergyRunId, endBoundary.gymEnergyRunId).all<WeeklySnapshot>(),
    db.prepare(
      "SELECT (SELECT MIN(captured_at) FROM faction_member_stat_snapshots WHERE run_id = ?) AS statsStartCapturedAt, (SELECT MIN(captured_at) FROM faction_member_stat_snapshots WHERE run_id = ?) AS statsEndCapturedAt, (SELECT MIN(captured_at) FROM faction_gym_energy_snapshots WHERE run_id = ?) AS gymStartCapturedAt, (SELECT MIN(captured_at) FROM faction_gym_energy_snapshots WHERE run_id = ?) AS gymEndCapturedAt"
    ).bind(startBoundary.statsRunId, endBoundary.statsRunId, startBoundary.gymEnergyRunId, endBoundary.gymEnergyRunId).first<{
      statsStartCapturedAt: string | null
      statsEndCapturedAt: string | null
      gymStartCapturedAt: string | null
      gymEndCapturedAt: string | null
    }>(),
  ])

  const calculated = (membersRows.results ?? []).map((member) => calculateWeeklyMemberResult({
    member,
    statSnapshots: statsRows.results ?? [],
    gymSnapshots: gymRows.results ?? [],
    weekStart: weekStartAt,
    weekEnd: weekEndAt,
    now,
    statsBoundaryRunId: startBoundary.statsRunId,
    gymBoundaryRunId: startBoundary.gymEnergyRunId,
    statsEndingBoundaryRunId: endBoundary.statsRunId,
    gymEndingBoundaryRunId: endBoundary.gymEnergyRunId,
    requireEndingBoundary: true,
  }))

  const statSummary = Object.fromEntries(WEEKLY_METRIC_NAMES.map((metric) => {
    const known = calculated.map((member) => member.metrics[metric]).filter((value): value is number => value !== null)
    return [metric, { total: known.reduce((sum, value) => sum + value, 0), knownMembers: known.length }]
  }))
  const knownGymEnergy = calculated.map((member) => member.gymEnergy).filter((value): value is number => value !== null)
  const summary = {
    ...statSummary,
    gymEnergy: { total: knownGymEnergy.reduce((sum, value) => sum + value, 0), knownMembers: knownGymEnergy.length },
  }
  const allRunsCompleted = runIds.every((runId) => runsById.get(runId)?.status === "completed")
  const allMembersComplete = calculated.every((member) => member.status === "complete")
  const reportStatus = allRunsCompleted && allMembersComplete && calculated.length > 0 ? "complete" : "partial"
  const finalizedAt = new Date().toISOString()

  if (!db.batch) throw new Error("D1 transactional batch support is required to finalize immutable weekly reports.")
  const statements = [
    db.prepare(
      "INSERT OR IGNORE INTO faction_weekly_reports (faction_id, week_start_at, week_end_at, report_status, stats_start_run_id, stats_end_run_id, gym_start_run_id, gym_end_run_id, stats_start_captured_at, stats_end_captured_at, gym_start_captured_at, gym_end_captured_at, member_count, complete_member_count, summary_json, finalized_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      NAUGHTY_SOULS_FACTION_ID, weekStartAt, weekEndAt, reportStatus,
      startBoundary.statsRunId, endBoundary.statsRunId, startBoundary.gymEnergyRunId, endBoundary.gymEnergyRunId,
      captureRows?.statsStartCapturedAt ?? null, captureRows?.statsEndCapturedAt ?? null,
      captureRows?.gymStartCapturedAt ?? null, captureRows?.gymEndCapturedAt ?? null,
      calculated.length, calculated.filter((member) => member.status === "complete").length,
      asJson(summary), finalizedAt, finalizedAt,
    ),
    ...calculated.map((member) => db.prepare(
      "INSERT OR IGNORE INTO faction_weekly_member_results (faction_id, week_start_at, user_id, member_name, position, level, participation, result_status, metrics_json, starting_networth, ending_networth, gym_energy, known_metric_count, anomaly_metrics_json, baseline_captured_at, ending_captured_at, ending_is_boundary, baseline_snapshot_id, ending_snapshot_id, gym_baseline_captured_at, gym_ending_captured_at, gym_ending_is_boundary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      NAUGHTY_SOULS_FACTION_ID, weekStartAt, member.userId, member.name, member.position, member.level,
      member.participation, member.status, asJson(member.metrics), member.startingNetworth, member.endingNetworth,
      member.gymEnergy, member.knownMetricCount, asJson(member.anomalyMetrics),
      member.baselineCapturedAt, member.endingCapturedAt, member.endingIsBoundary ? 1 : 0,
      member.baselineSnapshotId === null ? null : Number(member.baselineSnapshotId),
      member.endingSnapshotId === null ? null : Number(member.endingSnapshotId),
      member.gymEnergyBaselineCapturedAt, member.gymEnergyEndingCapturedAt,
      member.gymEnergyEndingIsBoundary ? 1 : 0, finalizedAt,
    )),
  ]
  await db.batch(statements)
  return true
}

function sqliteBoolean(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0
}

async function runFactionRosterCollection(env: WorkerEnv, run: FactionPerformanceRunRow, client: TornApiClient): Promise<void> {
  const payload = await client.getFactionMembersForRoster()
  const members = parseFactionRosterResponse(payload)
  if (members.length === 0) {
    throw new Error("Torn returned an empty faction roster; existing membership intervals were preserved.")
  }
  const capturedAt = new Date().toISOString()
  const db = requireDb(env)
  // A retried run may have persisted a subset from an earlier response. Replace
  // its child rows so members absent from the successful retry cannot linger.
  await db.prepare("DELETE FROM faction_member_roster_snapshots WHERE run_id = ?").bind(run.runId).run()

  await db.prepare(
    "INSERT INTO faction_roster_snapshots (run_id, faction_id, captured_at, scheduled_at, member_count, response_version) VALUES (?, ?, ?, ?, ?, 'torn-v2') ON CONFLICT(run_id) DO UPDATE SET captured_at = excluded.captured_at, member_count = excluded.member_count"
  ).bind(run.runId, run.factionId, capturedAt, run.scheduledAt, members.length).run()

  const activeRows = await db.prepare(
    "SELECT interval_id AS intervalId, user_id AS userId FROM faction_membership_intervals WHERE faction_id = ? AND left_observed_at IS NULL"
  ).bind(run.factionId).all<{ intervalId: string; userId: string }>()
  const activeByUser = new Map((activeRows.results ?? []).map((row) => [String(row.userId), String(row.intervalId)]))
  const seen = new Set<string>()

  for (const member of members) {
    seen.add(member.userId)
    const activeIntervalId = activeByUser.get(member.userId)
    const estimatedJoinedAt = member.daysInFaction === null
      ? null
      : new Date(Date.parse(capturedAt) - Math.max(0, member.daysInFaction) * DAY * 1000).toISOString()
    if (activeIntervalId) {
      await db.prepare(
        "UPDATE faction_membership_intervals SET member_name = ?, position = ?, level = ?, days_in_faction = ?, last_seen_at = ? WHERE interval_id = ? AND left_observed_at IS NULL"
      ).bind(member.name, member.position, member.level, member.daysInFaction, capturedAt, activeIntervalId).run()
    } else {
      await db.prepare(
        "INSERT INTO faction_membership_intervals (interval_id, faction_id, user_id, member_name, position, level, days_in_faction, estimated_joined_at, first_seen_at, last_seen_at, left_observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
      ).bind(crypto.randomUUID(), run.factionId, member.userId, member.name, member.position, member.level, member.daysInFaction, estimatedJoinedAt, capturedAt, capturedAt).run()
    }

    await db.prepare(
      "INSERT INTO faction_member_roster_snapshots (run_id, faction_id, user_id, captured_at, name, position, level, days_in_faction, last_action_status, last_action_timestamp, last_action_relative, status_description, status_details, status_state, status_until, status_color, is_revivable, revive_setting, is_on_wall, is_in_oc, has_early_discharge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, user_id) DO UPDATE SET captured_at = excluded.captured_at, name = excluded.name, position = excluded.position, level = excluded.level, days_in_faction = excluded.days_in_faction, last_action_status = excluded.last_action_status, last_action_timestamp = excluded.last_action_timestamp, last_action_relative = excluded.last_action_relative, status_description = excluded.status_description, status_details = excluded.status_details, status_state = excluded.status_state, status_until = excluded.status_until, status_color = excluded.status_color, is_revivable = excluded.is_revivable, revive_setting = excluded.revive_setting, is_on_wall = excluded.is_on_wall, is_in_oc = excluded.is_in_oc, has_early_discharge = excluded.has_early_discharge"
    ).bind(
      run.runId, run.factionId, member.userId, capturedAt, member.name, member.position, member.level, member.daysInFaction,
      member.lastActionStatus, member.lastActionTimestamp, member.lastActionRelative, member.statusDescription, member.statusDetails,
      member.statusState, member.statusUntil, member.statusColor, sqliteBoolean(member.isRevivable), member.reviveSetting,
      sqliteBoolean(member.isOnWall), sqliteBoolean(member.isInOc), sqliteBoolean(member.hasEarlyDischarge),
    ).run()
  }

  for (const active of activeRows.results ?? []) {
    const userId = String(active.userId)
    if (seen.has(userId)) continue
    await db.prepare(
      "UPDATE faction_membership_intervals SET left_observed_at = ? WHERE interval_id = ? AND left_observed_at IS NULL"
    ).bind(capturedAt, String(active.intervalId)).run()
  }

  await finishFactionPerformanceRun(env, run, "completed", capturedAt)
}

function emptyFactionPublicStats(): ReturnType<typeof parseFactionPublicStatsResponse> {
  const metrics = Object.fromEntries(PERSONAL_STATS_HISTORICAL_NAMES.map((name) => [name, null])) as Record<(typeof PERSONAL_STATS_HISTORICAL_NAMES)[number], number | null>
  return { ...metrics, missingMetrics: [...PERSONAL_STATS_HISTORICAL_NAMES] }
}

async function saveFactionMemberStatSample(
  env: WorkerEnv,
  run: FactionPerformanceRunRow,
  userId: string,
  capturedAt: string,
  stats: ReturnType<typeof parseFactionPublicStatsResponse>,
  status: "complete" | "partial" | "failed",
  tornErrorCode: number | null = null,
): Promise<void> {
  const columns = FACTION_PUBLIC_STAT_COLUMNS.join(", ")
  const values = FACTION_PUBLIC_STAT_COLUMNS.map((name) => stats[name])
  const placeholders = Array.from({ length: values.length + 9 }, () => "?").join(", ")
  const updateColumns = [
    "captured_at", "scheduled_at", "collection_status", ...FACTION_PUBLIC_STAT_COLUMNS, "missing_metrics_json", "torn_error_code",
  ]
  const updateSql = updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")
  await requireDb(env).prepare(
    `INSERT INTO faction_member_stat_snapshots (run_id, faction_id, user_id, captured_at, scheduled_at, response_variant, collection_status, ${columns}, missing_metrics_json, torn_error_code) VALUES (${placeholders}) ON CONFLICT(run_id, user_id) DO UPDATE SET ${updateSql}`
  ).bind(
    run.runId, run.factionId, userId, capturedAt, run.scheduledAt, "popular", status, ...values,
    asJson(stats.missingMetrics), tornErrorCode,
  ).run()
}

async function runFactionPersonalStatsCollectionPage(env: WorkerEnv, run: FactionPerformanceRunRow, client: TornApiClient): Promise<void> {
  let targetUserIds: string[]
  try {
    const parsed: unknown = run.targetUserIdsJson ? JSON.parse(run.targetUserIdsJson) : []
    targetUserIds = Array.isArray(parsed) ? Array.from(new Set(parsed.filter((value): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value)))) : []
  } catch {
    throw new Error("Faction personalstats run has an invalid target list.")
  }
  let index = Math.max(0, Number(run.nextIndex) || 0)
  const endIndex = Math.min(targetUserIds.length, index + FACTION_PERFORMANCE_PAGE_SIZE)
  let partialCount = 0

  while (index < endIndex) {
    const userId = targetUserIds[index]
    let capturedAt = new Date().toISOString()
    let stats = emptyFactionPublicStats()
    let sampleStatus: "complete" | "partial" | "failed" = "failed"
    let tornErrorCode: number | null = null
    try {
      const payload = await client.getUserPersonalStatsFor(userId, { kind: "popular" })
      stats = parseFactionPublicStatsResponse(payload)
      capturedAt = new Date().toISOString()
      sampleStatus = stats.missingMetrics.length ? "partial" : "complete"
      if (sampleStatus === "partial") partialCount += 1
    } catch (error) {
      // Rate limits, transient Torn failures and network errors retry the same
      // member. Permanent per-member errors are recorded without blocking the
      // remaining roster. D1 writes stay outside this catch so storage failures
      // retry the queue message instead of becoming false member/API failures.
      if (error instanceof TornApiClientError &&
        (error.status === 429 || error.status >= 500 || error.code === 9)) {
        throw error
      }
      capturedAt = new Date().toISOString()
      partialCount += 1
      tornErrorCode = factionCollectionSafeError(error).tornCode
    }
    await saveFactionMemberStatSample(env, run, userId, capturedAt, stats, sampleStatus, tornErrorCode)
    index += 1
    if (index < endIndex) await new Promise((resolve) => setTimeout(resolve, 800))
    await requireDb(env).prepare(
      "UPDATE faction_performance_collection_runs SET next_index = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')"
    ).bind(index, new Date().toISOString(), run.runId).run()
  }

  if (index < targetUserIds.length) {
    await requireDb(env).prepare(
      "UPDATE faction_performance_collection_runs SET status = 'queued', updated_at = ? WHERE run_id = ? AND status NOT IN ('completed', 'partial', 'failed')"
    ).bind(new Date().toISOString(), run.runId).run()
    if (!env.GLOBAL_RANKINGS_QUEUE) throw new Error("Faction performance collection queue is not configured.")
    await env.GLOBAL_RANKINGS_QUEUE.send({ kind: FACTION_PERFORMANCE_QUEUE_KIND, runId: run.runId })
    await requireDb(env).prepare(
      "UPDATE faction_performance_collection_runs SET last_enqueued_at = ?, updated_at = ? WHERE run_id = ?"
    ).bind(new Date().toISOString(), new Date().toISOString(), run.runId).run()
    return
  }

  const failures = await requireDb(env).prepare(
    "SELECT COUNT(*) AS count FROM faction_member_stat_snapshots WHERE run_id = ? AND collection_status != 'complete'"
  ).bind(run.runId).first<{ count: number }>()
  const status = partialCount > 0 || Number(failures?.count ?? 0) > 0 ? "partial" : "completed"
  const capturedAt = new Date().toISOString()
  await finishFactionPerformanceRun(env, run, status, capturedAt, status === "partial" ? "One or more member stat samples were incomplete or unavailable." : null)
}

async function runFactionGymEnergyCollection(env: WorkerEnv, run: FactionPerformanceRunRow, client: TornApiClient): Promise<void> {
  const payload = await client.getFactionGymEnergyContributors()
  const contributors = parseFactionGymEnergyResponse(payload)
  const capturedAt = new Date().toISOString()
  let partial = false
  for (const contributor of contributors) {
    const status = contributor.value === null || contributor.inFaction === null ? "partial" : "complete"
    if (status === "partial") partial = true
    await requireDb(env).prepare(
      "INSERT INTO faction_gym_energy_snapshots (run_id, faction_id, user_id, captured_at, gym_energy_total, in_faction, collection_status) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, user_id) DO UPDATE SET captured_at = excluded.captured_at, gym_energy_total = excluded.gym_energy_total, in_faction = excluded.in_faction, collection_status = excluded.collection_status"
    ).bind(run.runId, run.factionId, contributor.userId, capturedAt, contributor.value, sqliteBoolean(contributor.inFaction), status).run()
  }
  await finishFactionPerformanceRun(env, run, partial ? "partial" : "completed", capturedAt, partial ? "One or more gym-energy values were missing." : null)
}

async function runFactionPerformanceCollection(env: WorkerEnv, runId: string): Promise<void> {
  const db = requireDb(env)
  const run = await db.prepare(
    "SELECT run_id AS runId, faction_id AS factionId, collection_kind AS collectionKind, status, scheduled_at AS scheduledAt, target_user_ids_json AS targetUserIdsJson, next_index AS nextIndex, last_enqueued_at AS lastEnqueuedAt FROM faction_performance_collection_runs WHERE run_id = ?"
  ).bind(runId).first<FactionPerformanceRunRow>()
  if (!run || run.status === "completed" || run.status === "partial" || run.status === "failed") return
  const apiKey = env.TORN_FACTION_API_KEY?.trim()
  if (!apiKey) throw new Error("Faction collector secret is not configured.")
  const now = new Date().toISOString()
  await db.prepare(
    "UPDATE faction_performance_collection_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')"
  ).bind(now, now, runId).run()
  const client = new TornApiClient({
    apiKey,
    baseUrl: env.TORN_API_BASE_URL,
    // The staging acceptance test routes the Torn client through an isolated
    // Service Binding to deterministic fixture responses, never public Torn.
    fetcher: env.TORN_API_FIXTURE?.fetch.bind(env.TORN_API_FIXTURE),
  })

  if (run.collectionKind === "roster") {
    await runFactionRosterCollection(env, run, client)
  } else if (run.collectionKind === "personalstats") {
    await runFactionPersonalStatsCollectionPage(env, run, client)
  } else if (run.collectionKind === "gym_energy") {
    await runFactionGymEnergyCollection(env, run, client)
  } else {
    throw new Error("Unknown faction performance collection kind.")
  }
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
async function persistCompanyConnection(
  env: WorkerEnv,
  playerId: string,
  apiKey: string,
  validated: { companyId: number; profile: unknown; employees: unknown; stock: unknown; sourceTimestamp?: number | null },
  captureHistory = true,
): Promise<void> {
  // Store the same credential in both legacy and per-company slots, with the
  // per-company record updated last so it becomes the active primary key.
  await saveCompanyKey(env, playerId, apiKey)
  await saveCompanyApiKey(env, playerId, validated.companyId, apiKey, validated.profile)
  const profile = validated.profile
  const root = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : {}
  const type = isRecord(root.type) ? root.type : {}
  const companyName = typeof root.name === "string" ? root.name : `Company #${validated.companyId}`
  const companyType = typeof type.name === "string" ? type.name : null
  const db = requireDb(env)
  const existing = await db.prepare("SELECT employees_json FROM companies WHERE player_id = ? AND company_id = ?").bind(playerId, String(validated.companyId)).first<{ employees_json: string }>()
  const employeesJson = validated.employees ? asJson(validated.employees) : existing?.employees_json ?? "{}"
  const now = new Date().toISOString()
  const sourceMs = typeof validated.sourceTimestamp === "number" && Number.isFinite(validated.sourceTimestamp) && validated.sourceTimestamp > 0
    ? validated.sourceTimestamp * 1000
    : NaN
  const initialFetchedAt = Number.isFinite(sourceMs) && !Number.isNaN(new Date(sourceMs).getTime())
    ? new Date(sourceMs).toISOString()
    : now

  await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at")
    .bind(playerId, String(validated.companyId), companyName, companyType, asJson(profile), employeesJson, now).run()
  if (validated.stock !== null && validated.stock !== undefined) {
    await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at")
      .bind(playerId, String(validated.companyId), asJson(validated.stock), now).run()
  }

  // Connecting or signing in again must not append another historical point.
  // Create a one-time initialization baseline only when this company has no
  // saved profile, financial, or director history at all.
  if (captureHistory) {
    const [profileHistory, financialHistory, directorHistory] = await Promise.all([
      db.prepare("SELECT 1 AS found FROM company_snapshots WHERE player_id = ? AND company_id = ? LIMIT 1").bind(playerId, String(validated.companyId)).first<{ found: number }>(),
      db.prepare("SELECT 1 AS found FROM company_financial_snapshots WHERE player_id = ? AND company_id = ? LIMIT 1").bind(playerId, String(validated.companyId)).first<{ found: number }>(),
      db.prepare("SELECT 1 AS found FROM faction_director_snapshots WHERE player_id = ? AND company_id = ? LIMIT 1").bind(playerId, String(validated.companyId)).first<{ found: number }>(),
    ])
    if (!profileHistory && !financialHistory && !directorHistory) {
      await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)")
        .bind(playerId, String(validated.companyId), asJson(profile), employeesJson, initialFetchedAt).run()
      if (validated.stock !== null && validated.stock !== undefined) {
        await db.prepare("INSERT INTO company_financial_snapshots (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?)")
          .bind(playerId, String(validated.companyId), asJson(validated.stock), initialFetchedAt).run()
      }
      try {
        await persistFactionDirectorSnapshot(env, profile, validated.stock, {
          kind: "initialization",
          sourceTimestamp: validated.sourceTimestamp,
        })
      } catch {
        /* The current company data is already persisted. */
      }
    }
  }
}
async function ensurePrimaryCompanyConnection(env: WorkerEnv, playerId: string): Promise<{ saved: boolean; companyId?: string }> {
  const db = requireDb(env)
  const existing = await db.prepare("SELECT company_id FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC LIMIT 1").bind(playerId).first<{ company_id: string }>()
  if (existing) {
    const snapshot = await db.prepare("SELECT company_id FROM companies WHERE player_id = ? AND company_id = ?").bind(playerId, existing.company_id).first<{ company_id: string }>()
    if (snapshot) return { saved: true, companyId: existing.company_id }
    const existingKey = await savedCompanyApiKey(env, playerId, existing.company_id)
    if (existingKey) {
      const validated = await validateCompanyKey(existingKey)
      await persistCompanyConnection(env, playerId, existingKey, validated)
      return { saved: true, companyId: String(validated.companyId) }
    }
  }
  const director = await db.prepare("SELECT is_director FROM faction_member_cache WHERE player_id = ?").bind(playerId).first<{ is_director: number }>()
  if (director?.is_director !== 1) return { saved: false }
  const apiKey = await savedKey(env, playerId)
  if (!apiKey) return { saved: false }
  const validated = await validateCompanyKey(apiKey)
  await persistCompanyConnection(env, playerId, apiKey, validated)
  return { saved: true, companyId: String(validated.companyId) }
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
async function validateCompanyKey(apiKey: string): Promise<{ companyId: number; profile: unknown; employees: unknown; stock: unknown; sourceTimestamp: number | null }> {
  const client = new TornApiClient({ apiKey })
  let profile: unknown, employees: unknown = null, stock: unknown = null
  let sourceTimestamp: number | null = null
  try {
    const selections = await client.getCompanySelections()
    profile = selections.profile
    employees = selections.employees
    stock = selections.stock
    sourceTimestamp = selections.timestamp
  } catch {
    // A profile-capable login key should still be promoted even if the combined
    // endpoint rejects one optional selection. Try the individual endpoints.
    profile = await client.getCompanyProfile()
    const fallbackId = companyIdFromPayload(profile)
    if (!fallbackId) throw Object.assign(new Error("That key did not return a valid company profile. Use a key with company profile access."), { status: 403 })
    try { employees = await client.getCompanyEmployees() } catch { /* Preserve any existing employee snapshot. */ }
    try { stock = await client.getCompanyStock() } catch { /* Stock can be refreshed later if access is available. */ }
  }
  const companyId = companyIdFromPayload(profile)
  if (!companyId) throw Object.assign(new Error("That key did not return a valid company profile. Use a key with company profile access."), { status: 403 })
  return { companyId, profile, employees, stock, sourceTimestamp }
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
  const headers = { Authorization: `ApiKey ${apiKey}`, Accept: "application/json" }
  const typesResponse = await fetch("https://api.torn.com/v2/torn/companies", { headers, signal: AbortSignal.timeout(20000) })
  const typesBody = await typesResponse.text()
  if (!typesResponse.ok || typesBody.trimStart().startsWith("{") && (() => { try { const parsed = JSON.parse(typesBody); return isRecord(parsed) && isRecord(parsed.error) } catch { return true } })()) {
    let message = "Torn could not provide the company type catalog."
    try { const payload = JSON.parse(typesBody); if (isRecord(payload) && isRecord(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message } catch { /* Keep the fallback message. */ }
    throw Object.assign(new Error(message), { status: typesResponse.status === 429 ? 429 : 502 })
  }
  let typePayload: unknown
  try { typePayload = JSON.parse(typesBody) } catch { throw Object.assign(new Error("Torn returned malformed company type metadata."), { status: 502 }) }
  const root = isRecord(typePayload)
    ? (Array.isArray(typePayload.companies) || isRecord(typePayload.companies) ? typePayload.companies
      : Array.isArray(typePayload.company_types) || isRecord(typePayload.company_types) ? typePayload.company_types : typePayload)
    : typePayload
  const typeEntries = Array.isArray(root) ? root : isRecord(root) ? Object.values(root) : []
  const typesById = new Map<number, { id: number; name: string }>()
  for (const entry of typeEntries) {
    if (!isRecord(entry)) continue
    const id = positiveId(entry.id ?? entry.type_id ?? entry.typeId ?? entry.company_type_id)
    if (!id) continue
    const typeId = Number(id)
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Type #${typeId}`
    typesById.set(typeId, { id: typeId, name })
  }
  const types = Array.from(typesById.values()).sort((a, b) => a.id - b.id)
  if (!types.length) throw Object.assign(new Error("Torn returned no valid company type IDs; the existing ranking cache was preserved."), { status: 502 })

  const pageSize = 100
  async function fetchTypeCompanies(type: { id: number; name: string }): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    let expectedTotal: number | null = null
    for (let page = 0; page < 1000; page++) {
      const offset = rows.length
      const response = await fetch(`https://api.torn.com/v2/company/${type.id}/companies?offset=${offset}&limit=${pageSize}`, { headers, signal: AbortSignal.timeout(20000) })
      const body = await response.text()
      if (!response.ok) {
        let message = `Torn could not provide companies for ${type.name} (type #${type.id}).`
        try { const payload = JSON.parse(body); if (isRecord(payload) && isRecord(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message } catch { /* Keep the fallback message. */ }
        throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : response.status >= 500 ? 502 : 502 })
      }
      let payload: unknown
      try { payload = JSON.parse(body) } catch { throw Object.assign(new Error(`Torn returned malformed company-list data for type #${type.id}.`), { status: 502 }) }
      if (!isRecord(payload) || !Array.isArray(payload.companies)) throw Object.assign(new Error(`Torn returned no company list for type #${type.id}; the existing ranking cache was preserved.`), { status: 502 })
      if (payload.companies.some((item) => !isRecord(item))) throw Object.assign(new Error(`Torn returned a malformed company row for type #${type.id}.`), { status: 502 })
      const pageRows = payload.companies as Record<string, unknown>[]
      const metadata = isRecord(payload._metadata) ? payload._metadata : {}
      const metadataTotal = numericField(metadata.total)
      if (metadataTotal !== null) {
        if (expectedTotal !== null && expectedTotal !== metadataTotal) throw Object.assign(new Error(`Torn company-list total changed during type #${type.id} pagination.`), { status: 502 })
        expectedTotal = metadataTotal
      }
      rows.push(...pageRows)
      if (expectedTotal !== null) {
        if (rows.length > expectedTotal) throw Object.assign(new Error(`Torn returned more companies than its declared total for type #${type.id}.`), { status: 502 })
        if (rows.length === expectedTotal) break
        if (pageRows.length === 0) throw Object.assign(new Error(`Torn returned an incomplete company list for type #${type.id}; the existing ranking cache was preserved.`), { status: 502 })
      } else if (pageRows.length < pageSize) {
        break
      }
      if (pageRows.length === 0) break
      if (page === 999) throw Object.assign(new Error(`Torn company-list pagination exceeded its safety limit for type #${type.id}.`), { status: 502 })
    }
    if (expectedTotal !== null && rows.length !== expectedTotal) throw Object.assign(new Error(`Torn returned ${rows.length} of ${expectedTotal} companies for type #${type.id}; the existing ranking cache was preserved.`), { status: 502 })
    return rows
  }

  const collected: { row: Record<string, unknown>; typeId: number; typeName: string }[] = []
  // Limit concurrency to avoid hammering Torn while still paging every company type.
  for (let index = 0; index < types.length; index += 4) {
    const batch = types.slice(index, index + 4)
    const pages = await Promise.all(batch.map(async (type) => ({ type, rows: await fetchTypeCompanies(type) })))
    for (const page of pages) for (const row of page.rows) collected.push({ row, typeId: page.type.id, typeName: page.type.name })
  }
  if (!collected.length) throw Object.assign(new Error("Torn returned no companies for the scheduled ranking capture; the existing ranking cache was preserved."), { status: 502 })
  const snapshotFetchedAt = new Date().toISOString()
  const companies = collected.flatMap(({ row, typeId, typeName }) => {
    const companyId = positiveId(row.id ?? row.company_id ?? row.companyId ?? row.ID)
    if (!companyId) return []
    const type = isRecord(row.type) ? row.type : {}
    const income = isRecord(row.income) ? row.income : {}
    const director = isRecord(row.director) ? row.director : {}
    const typeNameFromRow = typeof type.name === "string" && type.name.trim() ? type.name.trim() : typeName
    const typeIdFromRow = positiveId(type.id ?? row.company_type_id ?? row.companyTypeId)
    const weeklyIncome = numericField(income.weekly ?? row.weekly_income ?? row.weeklyIncome)
    const dailyIncome = numericField(income.daily ?? row.daily_income ?? row.dailyIncome)
    return [{
      companyId,
      companyName: typeof row.name === "string" && row.name.trim() ? row.name : `Company #${companyId}`,
      companyType: typeNameFromRow,
      companyTypeId: typeIdFromRow === null ? typeId : Number(typeIdFromRow),
      starRating: numericField(row.rating ?? row.stars ?? row.star_rating),
      weeklyIncome,
      dailyIncome,
      averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7,
      directorName: typeof director.name === "string" ? director.name : "",
      playerId: "torn-global",
      fetchedAt: snapshotFetchedAt,
    }]
  }).sort((a, b) => Number(b.weeklyIncome ?? -1) - Number(a.weeklyIncome ?? -1))
  if (!companies.length || companies.length < collected.length) {
    throw Object.assign(new Error("Torn returned company rows without valid IDs; the existing ranking cache was preserved."), { status: 502 })
  }
  const uniqueIds = new Set(companies.map((company) => String(company.companyId)))
  if (uniqueIds.size !== companies.length) throw Object.assign(new Error("Torn returned duplicate company IDs across company types; the existing ranking cache was preserved."), { status: 502 })
  return { companies, snapshotFetchedAt }
}

// Verification-only source: never use /company/snapshot to populate the live global ranking cache.
async function fetchOfficialCompanySnapshot(apiKey: string): Promise<{ companies: Record<string, unknown>[]; snapshotFetchedAt: string }> {
  const response = await fetch("https://api.torn.com/v2/company/snapshot", {
    headers: { Authorization: `ApiKey ${apiKey}`, Accept: "text/csv, text/plain, application/json" },
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  if (!response.ok || body.trimStart().startsWith("{")) {
    let message = "Torn could not provide the official all-company snapshot for verification."
    try { const payload = JSON.parse(body); if (isRecord(payload) && isRecord(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message } catch { /* CSV response */ }
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 })
  }
  const csv = parseCsv(body)
  if (csv.length < 2) throw Object.assign(new Error("Torn returned an empty official company snapshot for verification."), { status: 502 })
  const headersRow = csv[0].map(normalizedColumn)
  const records = csv.slice(1).map((cells) => Object.fromEntries(headersRow.map((header, index) => [header, cells[index] ?? ""])))
  const companies = records.flatMap((row) => {
    const companyId = numberField(row, "id", "company_id", "companyId", "ID")
    if (!companyId) return []
    const typeId = numberField(row, "type", "company_type_id", "company_type", "type_id")
    return [{
      companyId: String(companyId),
      companyName: row.name || `Company #${companyId}`,
      companyTypeId: typeId,
      starRating: numberField(row, "rating", "stars", "star_rating"),
      weeklyIncome: numberField(row, "weekly_income", "weeklyIncome"),
      dailyIncome: numberField(row, "daily_income", "dailyIncome"),
    }]
  })
  if (!companies.length || companies.length < Math.ceil(records.length * 0.95)) throw Object.assign(new Error("Torn returned an incomplete or malformed official company snapshot; no ranking data was changed."), { status: 502 })
  const uniqueIds = new Set(companies.map((company) => String(company.companyId)))
  if (uniqueIds.size !== companies.length) throw Object.assign(new Error("Torn returned duplicate company IDs in the official verification snapshot."), { status: 502 })
  return { companies, snapshotFetchedAt: new Date().toISOString() }
}
type GlobalCompanyType = { id: number; name: string }
type GlobalRankingRunRow = {
  run_id: string; source: string; status: string; types_json: string; type_index: number; page_offset: number;
  expected_total: number | null; companies_seen: number; snapshot_fetched_at: string; admin_job_id: string | null;
  lease_until: number; started_at: string; updated_at: string
}

async function ensureGlobalRankingRefreshSchema(env: WorkerEnv): Promise<void> {
  const db = requireDb(env)
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_refresh_runs (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, types_json TEXT NOT NULL, type_index INTEGER NOT NULL DEFAULT 0, page_offset INTEGER NOT NULL DEFAULT 0, expected_total INTEGER, companies_seen INTEGER NOT NULL DEFAULT 0, snapshot_fetched_at TEXT NOT NULL, admin_job_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, error_message TEXT)").run()
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_refresh_pages (run_id TEXT NOT NULL, type_index INTEGER NOT NULL, page_offset INTEGER NOT NULL, companies_json TEXT NOT NULL, PRIMARY KEY (run_id, type_index, page_offset))").run()
}

async function fetchGlobalCompanyTypeCatalog(apiKey: string): Promise<GlobalCompanyType[]> {
  const response = await fetch("https://api.torn.com/v2/torn/companies", {
    headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  })
  const body = await response.text()
  if (!response.ok) {
    let message = "Torn could not provide the company type catalog."
    try { const payload = JSON.parse(body); if (isRecord(payload) && isRecord(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message } catch { /* Keep the fallback message. */ }
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 })
  }
  let payload: unknown
  try { payload = JSON.parse(body) } catch { throw Object.assign(new Error("Torn returned malformed company type metadata."), { status: 502 }) }
  const root = isRecord(payload)
    ? (Array.isArray(payload.companies) || isRecord(payload.companies) ? payload.companies
      : Array.isArray(payload.company_types) || isRecord(payload.company_types) ? payload.company_types : payload)
    : payload
  const entries = Array.isArray(root) ? root : isRecord(root) ? Object.values(root) : []
  const byId = new Map<number, GlobalCompanyType>()
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const id = positiveId(entry.id ?? entry.type_id ?? entry.typeId ?? entry.company_type_id)
    if (!id) continue
    const typeId = Number(id)
    byId.set(typeId, { id: typeId, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "Type #" + typeId })
  }
  const types = Array.from(byId.values()).sort((a, b) => a.id - b.id)
  if (!types.length) throw Object.assign(new Error("Torn returned no valid company type IDs; the existing ranking cache was preserved."), { status: 502 })
  return types
}

async function getGlobalRankingApiKey(env: WorkerEnv, preferredKey?: string): Promise<string> {
  if (preferredKey) return preferredKey
  const row = await requireDb(env).prepare("SELECT player_id FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string }>()
  const key = row ? await savedKey(env, row.player_id) : null
  if (!key) throw Object.assign(new Error("No saved Torn API key is available to refresh the global company rankings cache."), { status: 503 })
  return key
}

async function startGlobalRankingRefresh(
  env: WorkerEnv,
  source: "scheduled" | "automatic" | "admin",
  adminJobId?: string,
  deferDispatch = false,
  preferredKey?: string,
): Promise<{ runId: string; dispatchRequired: boolean }> {
  if (!env.GLOBAL_RANKINGS_QUEUE) throw new Error("The resumable global-ranking queue is not configured.")
  const db = requireDb(env)
  await ensureGlobalRankingRefreshSchema(env)
  const active = await db.prepare("SELECT run_id AS runId, admin_job_id AS adminJobId FROM global_rankings_refresh_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
    .first<{ runId: string; adminJobId: string | null }>()
  if (active) {
    // Do not attach a new admin job to an already-running refresh: it could finish
    // before that job has persisted its pending result. Keep the job lifecycle race-free.
    if (adminJobId) throw new Error("A global ranking refresh is already running. Wait for it to finish before starting another.")
    return { runId: active.runId, dispatchRequired: false }
  }

  const apiKey = await getGlobalRankingApiKey(env, preferredKey)
  const types = await fetchGlobalCompanyTypeCatalog(apiKey)
  const now = new Date().toISOString()
  const runId = randomToken().slice(0, 24)
  await db.prepare("INSERT INTO global_rankings_refresh_runs (run_id, source, status, types_json, type_index, page_offset, expected_total, companies_seen, snapshot_fetched_at, admin_job_id, lease_until, started_at, updated_at) VALUES (?, ?, 'running', ?, 0, 0, NULL, 0, ?, ?, 0, ?, ?)")
    .bind(runId, source, asJson(types), now, adminJobId ?? null, now, now).run()
  if (deferDispatch) return { runId, dispatchRequired: true }
  try {
    await env.GLOBAL_RANKINGS_QUEUE.send({ runId })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 220) : "Could not enqueue the global ranking refresh."
    await db.prepare("UPDATE global_rankings_refresh_runs SET status = 'failed', finished_at = ?, updated_at = ?, error_message = ? WHERE run_id = ? AND status = 'running'")
      .bind(new Date().toISOString(), new Date().toISOString(), message, runId).run()
    throw new Error("Could not queue the resumable global ranking refresh: " + message)
  }
  return { runId, dispatchRequired: false }
}

async function completeLinkedAdminRankingJob(env: WorkerEnv, run: GlobalRankingRunRow, succeeded: boolean, summary: string): Promise<void> {
  if (!run.admin_job_id) return
  const db = requireDb(env)
  const job = await db.prepare("SELECT job_type, result_json FROM admin_jobs WHERE job_id = ?").bind(run.admin_job_id)
    .first<{ job_type: string; result_json: string | null }>()
  if (!job || job.job_type !== "endpoint-refresh") return
  const raw = parseStoredJson(job.result_json)
  const result: Record<string, unknown> = isRecord(raw) ? raw : {}
  const globalResults: Record<string, unknown> = isRecord(result.globalResults) ? result.globalResults : {}
  globalResults["global-company-rankings"] = succeeded
    ? { message: "Shared rankings cache refreshed from type-specific company lists.", refreshRunId: run.run_id, fetchedAt: run.snapshot_fetched_at, companies: run.companies_seen }
    : { message: summary, status: "failed", refreshRunId: run.run_id }
  result.globalResults = globalResults
  delete result.pendingGlobalRankingRunId
  delete result.dispatchGlobalRankingRun
  if (!succeeded) {
    result.partialFailure = true
    result.globalFailures = Math.max(0, Number(result.globalFailures ?? 0)) + 1
    result.globalSuccesses = Math.max(0, Number(result.globalSuccesses ?? 0) - 1)
    const endpoints: Record<string, unknown> = isRecord(result.endpoints) ? result.endpoints : {}
    const stats: Record<string, unknown> = isRecord(endpoints["global-company-rankings"]) ? endpoints["global-company-rankings"] as Record<string, unknown> : { attempted: 1, succeeded: 0, failed: 0 }
    stats.succeeded = Math.max(0, Number(stats.succeeded ?? 0) - 1)
    stats.failed = Number(stats.failed ?? 0) + 1
    endpoints["global-company-rankings"] = stats
    result.endpoints = endpoints
    const failures = Array.isArray(result.failures) ? result.failures.slice() : []
    failures.push({ endpoint: "global-company-rankings", error: summary })
    result.failures = failures.slice(0, 30)
    result.failedEndpointCalls = Number(result.failedEndpointCalls ?? 0) + 1
    result.successfulEndpointCalls = Math.max(0, Number(result.successfulEndpointCalls ?? 0) - 1)
  }
  const now = new Date().toISOString()
  await db.prepare("UPDATE admin_jobs SET status = 'completed', finished_at = ?, result_json = ?, error_message = NULL WHERE job_id = ? AND status = 'running'")
    .bind(now, asJson(result), run.admin_job_id).run()
  const actor: Session = { player_id: ADMIN_PLAYER_ID, player_name: "SharpSplinter", is_admin: 1 }
  await writeAdminAudit(env, actor, "job.completed", "job", run.admin_job_id, succeeded ? "succeeded" : "failed",
    succeeded ? "Administrative endpoint refresh completed, including resumable global company rankings." : "Administrative endpoint refresh completed with a failed global company ranking endpoint.",
    { jobType: "endpoint-refresh", refreshRunId: run.run_id, partialFailure: !succeeded })
}

async function markGlobalRankingRunFailed(env: WorkerEnv, runId: string, error: unknown): Promise<void> {
  const db = requireDb(env)
  const run = await db.prepare("SELECT run_id, source, status, types_json, type_index, page_offset, expected_total, companies_seen, snapshot_fetched_at, admin_job_id, lease_until, started_at, updated_at FROM global_rankings_refresh_runs WHERE run_id = ?")
    .bind(runId).first<GlobalRankingRunRow>()
  if (!run || run.status !== "running") return
  const message = error instanceof Error ? error.message.slice(0, 220) : "Global company rankings refresh failed unexpectedly."
  const now = new Date().toISOString()
  await db.prepare("UPDATE global_rankings_refresh_runs SET status = 'failed', lease_until = 0, finished_at = ?, updated_at = ?, error_message = ? WHERE run_id = ? AND status = 'running'")
    .bind(now, now, message, runId).run()
  await db.prepare("DELETE FROM global_rankings_refresh_pages WHERE run_id = ?").bind(runId).run()
  await completeLinkedAdminRankingJob(env, run, false, message)
}

async function finalizeGlobalRankingRefresh(env: WorkerEnv, run: GlobalRankingRunRow, types: GlobalCompanyType[]): Promise<void> {
  const db = requireDb(env)
  const pages = await db.prepare("SELECT type_index AS typeIndex, page_offset AS pageOffset, companies_json AS companiesJson FROM global_rankings_refresh_pages WHERE run_id = ? ORDER BY type_index, page_offset")
    .bind(run.run_id).all<{ typeIndex: number; pageOffset: number; companiesJson: string }>()
  const collected: Array<{ row: Record<string, unknown>; typeId: number; typeName: string }> = []
  for (const page of pages.results ?? []) {
    const type = types[Number(page.typeIndex)]
    if (!type) throw new Error("Staged global-ranking data referenced an unknown company type; the existing cache was preserved.")
    let parsed: unknown
    try { parsed = JSON.parse(page.companiesJson) } catch { throw new Error("Staged global-ranking page data was malformed; the existing cache was preserved.") }
    if (!Array.isArray(parsed) || parsed.some((item) => !isRecord(item))) throw new Error("Staged global-ranking page data was incomplete; the existing cache was preserved.")
    for (const row of parsed as Record<string, unknown>[]) collected.push({ row, typeId: type.id, typeName: type.name })
  }
  if (collected.length !== run.companies_seen) throw new Error("Staged global-ranking row count did not match the saved progress; the existing cache was preserved.")
  if (!collected.length) throw new Error("Torn returned no companies for the global ranking capture; the existing cache was preserved.")
  const companies = collected.flatMap(({ row, typeId, typeName }) => {
    const companyId = positiveId(row.id ?? row.company_id ?? row.companyId ?? row.ID)
    if (!companyId) return []
    const type = isRecord(row.type) ? row.type : {}
    const income = isRecord(row.income) ? row.income : {}
    const director = isRecord(row.director) ? row.director : {}
    const typeNameFromRow = typeof type.name === "string" && type.name.trim() ? type.name.trim() : typeName
    const typeIdFromRow = positiveId(type.id ?? row.company_type_id ?? row.companyTypeId)
    const weeklyIncome = numericField(income.weekly ?? row.weekly_income ?? row.weeklyIncome)
    const dailyIncome = numericField(income.daily ?? row.daily_income ?? row.dailyIncome)
    return [{
      companyId, companyName: typeof row.name === "string" && row.name.trim() ? row.name : "Company #" + companyId,
      companyType: typeNameFromRow, companyTypeId: typeIdFromRow === null ? typeId : Number(typeIdFromRow),
      starRating: numericField(row.rating ?? row.stars ?? row.star_rating), weeklyIncome, dailyIncome,
      averageDailyIncome: weeklyIncome === null ? null : weeklyIncome / 7, directorName: typeof director.name === "string" ? director.name : "",
      playerId: "torn-global", fetchedAt: run.snapshot_fetched_at,
    }]
  }).sort((a, b) => Number(b.weeklyIncome ?? -1) - Number(a.weeklyIncome ?? -1))
  if (!companies.length || companies.length !== collected.length) throw new Error("Torn returned company rows without valid IDs; the existing ranking cache was preserved.")
  const uniqueIds = new Set(companies.map((company) => String(company.companyId)))
  if (uniqueIds.size !== companies.length) throw new Error("Torn returned duplicate company IDs across company types; the existing ranking cache was preserved.")
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run()
  await db.prepare("INSERT INTO global_rankings_cache (cache_id, companies_json, fetched_at) VALUES (1, ?, ?) ON CONFLICT(cache_id) DO UPDATE SET companies_json = excluded.companies_json, fetched_at = excluded.fetched_at")
    .bind(asJson(companies), run.snapshot_fetched_at).run()
  const now = new Date().toISOString()
  await db.prepare("UPDATE global_rankings_refresh_runs SET status = 'completed', lease_until = 0, finished_at = ?, updated_at = ?, error_message = NULL WHERE run_id = ? AND status = 'running'")
    .bind(now, now, run.run_id).run()
  await db.prepare("DELETE FROM global_rankings_refresh_pages WHERE run_id = ?").bind(run.run_id).run()
  await completeLinkedAdminRankingJob(env, { ...run, companies_seen: companies.length }, true, "")
}

async function processGlobalRankingQueueMessage(env: WorkerEnv, runId: string): Promise<"busy" | "pending" | "complete"> {
  const db = requireDb(env)
  await ensureGlobalRankingRefreshSchema(env)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const leaseUntil = nowSeconds + 45
  const claim = await db.prepare("UPDATE global_rankings_refresh_runs SET lease_until = ?, updated_at = ? WHERE run_id = ? AND status = 'running' AND lease_until < ?")
    .bind(leaseUntil, new Date().toISOString(), runId, nowSeconds).run()
  if (claim.meta?.changes === 0) {
    const current = await db.prepare("SELECT status FROM global_rankings_refresh_runs WHERE run_id = ?").bind(runId).first<{ status: string }>()
    return current?.status === "running" ? "busy" : "complete"
  }
  let run = await db.prepare("SELECT run_id, source, status, types_json, type_index, page_offset, expected_total, companies_seen, snapshot_fetched_at, admin_job_id, lease_until, started_at, updated_at FROM global_rankings_refresh_runs WHERE run_id = ?")
    .bind(runId).first<GlobalRankingRunRow>()
  if (!run || run.status !== "running") return "complete"
  try {
    let typesValue: unknown
    try { typesValue = JSON.parse(run.types_json) } catch { throw new Error("Saved global-ranking type catalogue was malformed; the existing cache was preserved.") }
    if (!Array.isArray(typesValue) || typesValue.some((item) => !isRecord(item) || !Number.isFinite(Number(item.id)) || typeof item.name !== "string")) throw new Error("Saved global-ranking type catalogue was incomplete; the existing cache was preserved.")
    const types = typesValue as GlobalCompanyType[]
    if (!types.length) throw new Error("Saved global-ranking type catalogue is empty; the existing cache was preserved.")
    const key = await getGlobalRankingApiKey(env)
    let typeIndex = Number(run.type_index)
    let offset = Number(run.page_offset)
    let expectedTotal = run.expected_total === null ? null : Number(run.expected_total)
    let companiesSeen = Number(run.companies_seen)
    const pageSize = 100
    const maxPagesPerInvocation = 3
    for (let pageNumber = 0; pageNumber < maxPagesPerInvocation && typeIndex < types.length; pageNumber++) {
      const type = types[typeIndex]
      const response = await fetch("https://api.torn.com/v2/company/" + type.id + "/companies?offset=" + offset + "&limit=" + pageSize, {
        headers: { Authorization: "ApiKey " + key, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      })
      const body = await response.text()
      if (!response.ok) {
        let message = "Torn could not provide companies for " + type.name + " (type #" + type.id + ")."
        try { const payload = JSON.parse(body); if (isRecord(payload) && isRecord(payload.error)) message = typeof payload.error.error === "string" ? payload.error.error : message } catch { /* Keep the fallback message. */ }
        throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 })
      }
      let payload: unknown
      try { payload = JSON.parse(body) } catch { throw new Error("Torn returned malformed company-list data for type #" + type.id + "; the existing cache was preserved.") }
      if (!isRecord(payload) || !Array.isArray(payload.companies)) throw new Error("Torn returned no company list for type #" + type.id + "; the existing cache was preserved.")
      if (payload.companies.some((item) => !isRecord(item))) throw new Error("Torn returned a malformed company row for type #" + type.id + ".")
      const rows = payload.companies as Record<string, unknown>[]
      const metadata = isRecord(payload._metadata) ? payload._metadata : {}
      const metadataTotal = numericField(metadata.total)
      if (metadataTotal !== null && expectedTotal !== null && expectedTotal !== metadataTotal) throw new Error("Torn company-list total changed during type #" + type.id + " pagination.")
      if (metadataTotal !== null) expectedTotal = metadataTotal
      const nextOffset = offset + rows.length
      if (expectedTotal !== null && nextOffset > expectedTotal) throw new Error("Torn returned more companies than its declared total for type #" + type.id + ".")
      if (expectedTotal !== null && rows.length === 0 && offset < expectedTotal) throw new Error("Torn returned an incomplete company list for type #" + type.id + "; the existing cache was preserved.")
      await db.prepare("INSERT INTO global_rankings_refresh_pages (run_id, type_index, page_offset, companies_json) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, type_index, page_offset) DO UPDATE SET companies_json = excluded.companies_json")
        .bind(runId, typeIndex, offset, asJson(rows)).run()
      companiesSeen += rows.length
      const typeFinished = expectedTotal !== null
        ? nextOffset === expectedTotal
        : rows.length < pageSize
      if (typeFinished) {
        typeIndex += 1
        offset = 0
        expectedTotal = null
      } else {
        offset = nextOffset
      }
      const updatedAt = new Date().toISOString()
      await db.prepare("UPDATE global_rankings_refresh_runs SET type_index = ?, page_offset = ?, expected_total = ?, companies_seen = ?, lease_until = ?, updated_at = ? WHERE run_id = ? AND status = 'running' AND lease_until = ?")
        .bind(typeIndex, offset, expectedTotal, companiesSeen, leaseUntil, updatedAt, runId, leaseUntil).run()
    }
    run = { ...run, type_index: typeIndex, page_offset: offset, expected_total: expectedTotal, companies_seen: companiesSeen, lease_until: leaseUntil, updated_at: new Date().toISOString() }
    if (typeIndex >= types.length) {
      await finalizeGlobalRankingRefresh(env, run, types)
      return "complete"
    }
    if (!env.GLOBAL_RANKINGS_QUEUE) throw new Error("The resumable global-ranking queue binding is missing.")
    await env.GLOBAL_RANKINGS_QUEUE.send({ runId })
    await db.prepare("UPDATE global_rankings_refresh_runs SET lease_until = 0, updated_at = ? WHERE run_id = ? AND status = 'running' AND lease_until = ?")
      .bind(new Date().toISOString(), runId, leaseUntil).run()
    return "pending"
  } catch (error) {
    await db.prepare("UPDATE global_rankings_refresh_runs SET lease_until = 0, updated_at = ? WHERE run_id = ? AND status = 'running' AND lease_until = ?")
      .bind(new Date().toISOString(), runId, leaseUntil).run().catch(() => undefined)
    throw error
  }
}

async function purgeHalloweenMemberData(env: WorkerEnv, playerId: string): Promise<void> {
  const db = requireDb(env)
  await db.prepare("DELETE FROM halloween_historical_keys WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM halloween_event_logs WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM halloween_live_snapshots WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM halloween_collection_jobs WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM halloween_live_snapshot_jobs WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM halloween_member_event_slots WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM halloween_api_throttles WHERE player_id = ?").bind(playerId).run()
  await db.prepare("UPDATE administrators SET revoked_by = 'system', revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), playerId).run()
}

async function removeDepartedFactionAccess(env: WorkerEnv, playerId: string): Promise<void> {
  const db = requireDb(env)
  // Revoke the durable admin role first. If later archive/session cleanup fails,
  // administrator access is still removed immediately.
  await db.prepare("UPDATE administrators SET revoked_by = 'system', revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), playerId).run()
  await purgeHalloweenMemberData(env, playerId)
  // Private owner-key data is live-only and is removed immediately on a
  // confirmed faction departure. It is never retained as faction history.
  await db.prepare("DELETE FROM faction_member_private_live_snapshots WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM member_private_live_keys WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM sessions WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM api_keys WHERE player_id = ?").bind(playerId).run()
  await db.prepare("DELETE FROM faction_member_cache WHERE player_id = ?").bind(playerId).run()
  // Sharing preferences are optional on older installations. Their absence
  // must not block session/key invalidation or Halloween-data deletion.
  await db.prepare("DELETE FROM company_sharing_recipients WHERE owner_player_id = ? OR recipient_player_id = ?")
    .bind(playerId, playerId).run().catch(() => undefined)
}

async function applyConfirmedFactionDeparture(env: WorkerEnv, playerId: string, factionId: string): Promise<void> {
  const db = requireDb(env)
  // A collector may discover departure before the normal session revalidator.
  // Mark it pending before cleanup so every active session fails closed.
  await db.prepare("UPDATE players SET membership_check_status = 'cleanup_pending' WHERE player_id = ?")
    .bind(playerId).run()
  await removeDepartedFactionAccess(env, playerId)
  const verifiedAt = new Date().toISOString()
  await db.prepare("UPDATE players SET faction_id = ?, faction_verified_at = ?, membership_check_attempted_at = ?, membership_check_status = NULL, updated_at = ? WHERE player_id = ?")
    .bind(factionId || null, verifiedAt, verifiedAt, verifiedAt, playerId).run()
}

function classifyHalloweenLog(row: Record<string, unknown>): { labels: string[]; isHit: boolean; relevant: boolean } {
  const details = isRecord(row.details) ? row.details : {}
  const title = typeof details.title === "string" ? details.title.toLowerCase() : ""
  const category = typeof details.category === "string" ? details.category.toLowerCase() : ""
  const searchable = (title + " " + category + " " + JSON.stringify(row.data ?? {}) + " " + JSON.stringify(row.params ?? {})).toLowerCase()
  const labels = new Set<string>()
  if (searchable.includes("trick or treat")) labels.add("trick_or_treat")
  if (searchable.includes("treat") && /(receive|received|gain|gained|collect|collected|earned)/.test(searchable)) labels.add("treat_received")
  if (searchable.includes("basket")) labels.add("basket")
  if (title.includes("attack") && title.includes("leave")) labels.add("attack_leave")
  if (title.includes("attack") && title.includes("mug")) labels.add("attack_mug")
  if (title.includes("attack") && /(hospital|hospitalize|hospitalise)/.test(title)) labels.add("attack_hospitalize")
  if (searchable.includes("revitalize") || searchable.includes("revitalise")) labels.add("revitalize")
  if (searchable.includes("boost")) labels.add("boost")
  if (searchable.includes("book") && /(activate|activation|used|use)/.test(searchable)) labels.add("book_activation")
  if (searchable.includes("company") && /(change|changed|joined|left|director)/.test(searchable)) labels.add("company_change")
  if (title.includes("item use") || title.includes("items use")) labels.add("item_use")
  const isHit = labels.has("attack_leave") || labels.has("attack_mug") || labels.has("attack_hospitalize")
  return { labels: Array.from(labels), isHit, relevant: labels.size > 0 }
}

async function throttleHalloweenRequest(env: WorkerEnv, playerId: string): Promise<void> {
  const db = requireDb(env)
  const row = await db.prepare("SELECT last_request_at FROM halloween_api_throttles WHERE player_id = ?")
    .bind(playerId).first<{ last_request_at: number }>()
  const now = Date.now()
  const waitMs = Math.max(0, 800 - (now - Number(row?.last_request_at ?? 0)))
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
  const startedAt = Date.now()
  await db.prepare("INSERT INTO halloween_api_throttles (player_id, last_request_at) VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET last_request_at = excluded.last_request_at")
    .bind(playerId, startedAt).run()
}

async function sendHalloweenCollectionJob(env: WorkerEnv, jobId: string): Promise<void> {
  if (!env.GLOBAL_RANKINGS_QUEUE) throw new Error("The background collection queue is not configured.")
  await env.GLOBAL_RANKINGS_QUEUE.send({ kind: "halloween-log-collection", jobId })
}

type HalloweenEventDefinition = { eventYear: number; startAt: string; endAt: string }
type HalloweenMemberEventWindow = {
  configured: boolean
  startMinuteOfDay: number | null
  startTime: string | null
  startAt: string | null
  endAt: string | null
}

function formatHalloweenStartTime(startMinuteOfDay: number): string {
  const hour = Math.floor(startMinuteOfDay / 60)
  const minute = startMinuteOfDay % 60
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0")
}

function buildHalloweenMemberEventWindow(event: HalloweenEventDefinition, startMinuteOfDay: number): HalloweenMemberEventWindow {
  if (!Number.isInteger(startMinuteOfDay) || startMinuteOfDay < 600 || startMinuteOfDay > 960 || startMinuteOfDay % 15 !== 0) {
    throw new Error("Choose a Trick or Treat start time from 10:00 through 16:00 TCT in 15-minute increments.")
  }
  const startDate = event.startAt.slice(0, 10)
  const endDate = event.endAt.slice(0, 10)
  const startDay = Date.parse(startDate + "T00:00:00.000Z")
  const endDay = Date.parse(endDate + "T00:00:00.000Z")
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay) || endDay <= startDay) {
    throw new Error("The configured Halloween calendar dates are invalid.")
  }
  const time = formatHalloweenStartTime(startMinuteOfDay)
  const startAt = new Date(startDay + startMinuteOfDay * 60 * 1000).toISOString()
  const endAt = new Date(endDay + startMinuteOfDay * 60 * 1000).toISOString()
  return { configured: true, startMinuteOfDay, startTime: time, startAt, endAt }
}

async function getHalloweenMemberEventWindow(env: WorkerEnv, playerId: string, eventYear: number): Promise<{ event: HalloweenEventDefinition; window: HalloweenMemberEventWindow } | null> {
  const db = requireDb(env)
  const event = await db.prepare("SELECT event_year AS eventYear, start_at AS startAt, end_at AS endAt FROM halloween_event_windows WHERE event_year = ?")
    .bind(eventYear).first<HalloweenEventDefinition>()
  if (!event) return null
  const slot = await db.prepare("SELECT start_minute_of_day AS startMinuteOfDay FROM halloween_member_event_slots WHERE player_id = ? AND event_year = ?")
    .bind(playerId, eventYear).first<{ startMinuteOfDay: number }>()
  if (!slot || slot.startMinuteOfDay == null) {
    return { event, window: { configured: false, startMinuteOfDay: null, startTime: null, startAt: null, endAt: null } }
  }
  return { event, window: buildHalloweenMemberEventWindow(event, Number(slot.startMinuteOfDay)) }
}

async function runHalloweenLogCollectionPage(env: WorkerEnv, jobId: string): Promise<void> {
  const db = requireDb(env)
  const job = await db.prepare("SELECT job_id, player_id, event_year, status, cursor_ts, cursor_url, cursor_direction, pages_collected, logs_collected, window_start_at, window_end_at FROM halloween_collection_jobs WHERE job_id = ?")
    .bind(jobId).first<{ job_id: string; player_id: string; event_year: number; status: string; cursor_ts: number; cursor_url: string | null; cursor_direction: string | null; pages_collected: number; logs_collected: number; window_start_at: string | null; window_end_at: string | null }>()
  if (!job || ["complete", "failed", "cancelled"].includes(job.status)) return
  const memberStatus = await db.prepare("SELECT disabled_at FROM dashboard_member_status WHERE player_id = ?")
    .bind(job.player_id).first<{ disabled_at: string | null }>()
  if (memberStatus?.disabled_at) {
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'cancelled', last_error = ?, updated_at = ? WHERE job_id = ?")
      .bind("Collection was cancelled because this member's dashboard access is disabled.", new Date().toISOString(), jobId).run()
    return
  }
  const event = await db.prepare("SELECT start_at, end_at, historical_collection_enabled FROM halloween_event_windows WHERE event_year = ?")
    .bind(job.event_year).first<{ start_at: string; end_at: string; historical_collection_enabled: number }>()
  if (!event || event.historical_collection_enabled !== 1) {
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
      .bind("Historical collection is disabled for this event year.", new Date().toISOString(), jobId).run()
    return
  }
  const keyRow = await db.prepare("SELECT ciphertext, iv FROM halloween_historical_keys WHERE player_id = ?")
    .bind(job.player_id).first<{ ciphertext: string; iv: string }>()
  if (!keyRow) {
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
      .bind("The member's Full Access key is no longer connected.", new Date().toISOString(), jobId).run()
    return
  }
  const apiKey = await decryptKey(env, keyRow.ciphertext, keyRow.iv)
  await throttleHalloweenRequest(env, job.player_id)
  const factionId = await verifyFactionMembershipWithKey(apiKey)
  if (factionId !== NAUGHTY_SOULS_FACTION_ID) {
    await applyConfirmedFactionDeparture(env, job.player_id, factionId)
    return
  }

  const eventStart = Math.floor(Date.parse(job.window_start_at || event.start_at) / 1000)
  const eventEnd = Math.floor(Date.parse(job.window_end_at || event.end_at) / 1000)
  const dayStart = Number(job.cursor_ts)
  if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd <= eventStart || !Number.isFinite(dayStart) || dayStart < eventStart) {
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
      .bind("The personal Halloween event window is invalid.", new Date().toISOString(), jobId).run()
    return
  }
  if (dayStart >= eventEnd) {
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'complete', completed_at = ?, updated_at = ?, last_error = NULL WHERE job_id = ?")
      .bind(new Date().toISOString(), new Date().toISOString(), jobId).run()
    return
  }
  const dayEnd = Math.min(dayStart + 86400, eventEnd)
  let requestUrl = job.cursor_url || (() => {
    const url = new URL("https://api.torn.com/v2/user/log")
    url.searchParams.set("from", String(dayStart))
    url.searchParams.set("to", String(dayEnd - 1))
    url.searchParams.set("limit", "100")
    url.searchParams.set("sort", "desc")
    return url.toString()
  })()
  const parsedUrl = new URL(requestUrl)
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "api.torn.com" || parsedUrl.pathname !== "/v2/user/log" || parsedUrl.searchParams.has("key")) {
    throw new Error("Torn returned an unsafe pagination URL. The API key was not sent.")
  }
  await throttleHalloweenRequest(env, job.player_id)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  let response: Response
  let payload: unknown
  try {
    response = await fetch(parsedUrl.toString(), {
      headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
      signal: controller.signal,
    })
    payload = await response.json().catch(() => null)
  } finally { clearTimeout(timeout) }
  const apiError = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  if (!response.ok || apiError) {
    const code = typeof apiError?.code === "number" ? apiError.code : undefined
    if (code === 2 || code === 16 || code === 18) {
      await db.prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
        .bind("Torn rejected the saved Full Access key. Reconnect a valid Full Access key with user log access.", new Date().toISOString(), jobId).run()
      return
    }
    throw new Error(code === 5 ? "Torn rate limit reached during historical collection." : "Torn historical log request failed.")
  }
  if (!isRecord(payload) || !Array.isArray(payload.log)) throw new Error("Torn returned an unexpected user log response.")
  const collectedAt = new Date().toISOString()
  let inserted = 0
  for (const raw of payload.log) {
    if (!isRecord(raw) || raw.id == null || !Number.isFinite(Number(raw.timestamp))) continue
    const eventTimestamp = Number(raw.timestamp)
    if (eventTimestamp < eventStart || eventTimestamp >= eventEnd) continue
    const classification = classifyHalloweenLog(raw)
    if (!classification.relevant) continue
    const details = isRecord(raw.details) ? raw.details : {}
    const logTypeId = details.id == null ? null : Number(details.id)
    const result = await db.prepare("INSERT OR IGNORE INTO halloween_event_logs (event_year, player_id, log_id, event_timestamp, log_type_id, category, title, labels_json, is_hit, log_json, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(job.event_year, job.player_id, String(raw.id), Number(raw.timestamp), Number.isFinite(logTypeId) ? logTypeId : null, typeof details.category === "string" ? details.category : null, typeof details.title === "string" ? details.title : null, asJson(classification.labels), classification.isHit ? 1 : 0, asJson(raw), collectedAt).run()
    inserted += Number(result.meta?.changes ?? 0)
  }
  const metadata = isRecord(payload._metadata) ? payload._metadata : {}
  const links = isRecord(metadata.links) ? metadata.links : {}
  const direction = job.cursor_direction || (typeof links.prev === "string" ? "prev" : "next")
  const candidate = links[direction]
  const nextUrl = typeof candidate === "string" ? candidate : null
  const pages = Number(job.pages_collected ?? 0) + 1
  const logs = Number(job.logs_collected ?? 0) + inserted
  const now = new Date().toISOString()
  if (nextUrl) {
    const next = new URL(nextUrl, parsedUrl)
    if (next.protocol !== "https:" || next.hostname !== "api.torn.com" || next.pathname !== "/v2/user/log" || next.searchParams.has("key")) throw new Error("Torn returned an unsafe historical pagination link.")
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'running', cursor_url = ?, cursor_direction = ?, pages_collected = ?, logs_collected = ?, last_error = NULL, updated_at = ? WHERE job_id = ?")
      .bind(next.toString(), direction, pages, logs, now, jobId).run()
    await sendHalloweenCollectionJob(env, jobId)
    return
  }
  if (dayEnd < eventEnd) {
    await db.prepare("UPDATE halloween_collection_jobs SET status = 'queued', cursor_ts = ?, cursor_url = NULL, cursor_direction = NULL, pages_collected = ?, logs_collected = ?, last_error = NULL, updated_at = ? WHERE job_id = ?")
      .bind(dayEnd, pages, logs, now, jobId).run()
    await sendHalloweenCollectionJob(env, jobId)
    return
  }
  await db.prepare("UPDATE halloween_collection_jobs SET status = 'complete', pages_collected = ?, logs_collected = ?, last_error = NULL, completed_at = ?, updated_at = ? WHERE job_id = ?")
    .bind(pages, logs, now, now, jobId).run()
}

async function runHalloweenLiveSnapshot(env: WorkerEnv, playerId: string, eventYear: number, snapshotKind: "opening" | "periodic" | "closing" | "manual"): Promise<Record<string, unknown>> {
  const db = requireDb(env)
  const personal = await getHalloweenMemberEventWindow(env, playerId, eventYear)
  if (!personal) throw new Error("No Halloween event window is configured for that year.")
  if (!personal.window.configured || !personal.window.startAt || !personal.window.endAt) throw new Error("Select your personal Trick or Treat start time before collecting live snapshots.")
  const startMs = Date.parse(personal.window.startAt)
  const endMs = Date.parse(personal.window.endAt)
  const nowMs = Date.now()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("The personal Halloween event window is invalid.")
  if (snapshotKind === "manual" && (nowMs < startMs || nowMs >= endMs)) throw new Error("Manual live snapshots are only available during your personal Halloween event window.")

  const apiKey = await savedKey(env, playerId)
  if (!apiKey) throw new Error("This member has no saved faction login key.")
  await throttleHalloweenRequest(env, playerId)
  const factionId = await verifyFactionMembershipWithKey(apiKey)
  if (factionId !== NAUGHTY_SOULS_FACTION_ID) {
    await applyConfirmedFactionDeparture(env, playerId, factionId)
    throw new Error("This member is no longer in Naughty Souls. Their sessions, faction login key, administrator role, and Halloween contributions were removed.")
  }

  await throttleHalloweenRequest(env, playerId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  let response: Response
  let payload: unknown
  try {
    response = await fetch("https://api.torn.com/v2/user/halloween", {
      headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
      signal: controller.signal,
    })
    payload = await response.json().catch(() => null)
  } finally { clearTimeout(timeout) }
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
  if (!response.ok || error) {
    const code = typeof error?.code === "number" ? error.code : undefined
    throw new Error(code === 9 ? "Torn rate limit reached while collecting Halloween summary." : code === 3 ? "The saved login key does not have the Minimal Access Halloween selection." : "Torn's Halloween summary endpoint is temporarily unavailable.")
  }
  const halloween = isRecord(payload) && isRecord(payload.halloween) ? payload.halloween : null
  const treats = isRecord(halloween?.treats) ? halloween.treats : null
  const upgrades = Array.isArray(halloween?.basket_upgrades) ? halloween.basket_upgrades : null
  if (!treats || !upgrades) throw new Error("Torn returned an incomplete Halloween treats summary.")
  const current = Number(treats.current)
  const total = Number(treats.total)
  if (!Number.isInteger(current) || current < 0 || !Number.isInteger(total) || total < 0) throw new Error("Torn returned invalid Halloween treat counts.")
  const metadata = isRecord(payload) && isRecord(payload._metadata) ? payload._metadata : {}
  const sourceTimestamp = typeof metadata.timestamp === "number" && Number.isFinite(metadata.timestamp) ? metadata.timestamp : null
  const capturedAt = new Date().toISOString()
  await db.prepare("INSERT INTO halloween_live_snapshots (event_year, player_id, captured_at, snapshot_kind, treats_current, treats_total, upgrades_json, payload_json, source_timestamp, collection_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete')")
    .bind(eventYear, playerId, capturedAt, snapshotKind, current, total, asJson(upgrades), asJson(payload), sourceTimestamp).run()
  return { eventYear, playerId, capturedAt, snapshotKind, treatsCurrent: current, treatsTotal: total, upgradesUnlocked: upgrades.length, sourceTimestamp }
}

async function runHalloweenLiveSnapshotJob(env: WorkerEnv, jobId: string): Promise<void> {
  const db = requireDb(env)
  const job = await db.prepare("SELECT job_id AS jobId, player_id AS playerId, event_year AS eventYear, snapshot_kind AS snapshotKind, status FROM halloween_live_snapshot_jobs WHERE job_id = ?")
    .bind(jobId).first<{ jobId: string; playerId: string; eventYear: number; snapshotKind: "opening" | "periodic" | "closing"; status: string }>()
  if (!job || job.status === "complete" || job.status === "failed") return
  const memberStatus = await db.prepare("SELECT disabled_at FROM dashboard_member_status WHERE player_id = ?")
    .bind(job.playerId).first<{ disabled_at: string | null }>()
  if (memberStatus?.disabled_at) {
    await db.prepare("UPDATE halloween_live_snapshot_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
      .bind("Snapshot was cancelled because this member's dashboard access is disabled.", new Date().toISOString(), jobId).run()
    return
  }
  await db.prepare("UPDATE halloween_live_snapshot_jobs SET status = 'running', updated_at = ? WHERE job_id = ?")
    .bind(new Date().toISOString(), jobId).run()
  try {
    await runHalloweenLiveSnapshot(env, job.playerId, job.eventYear, job.snapshotKind)
    const now = new Date().toISOString()
    await db.prepare("UPDATE halloween_live_snapshot_jobs SET status = 'complete', completed_at = ?, updated_at = ?, last_error = NULL WHERE job_id = ?")
      .bind(now, now, jobId).run()
  } catch (error) {
    const now = new Date().toISOString()
    const message = error instanceof Error ? error.message.slice(0, 240) : "Halloween snapshot failed."
    // Keep transient failures eligible for the queue's bounded retry policy.
    // The consumer marks the job failed only after the final delivery attempt.
    await db.prepare("UPDATE halloween_live_snapshot_jobs SET status = 'queued', last_error = ?, updated_at = ? WHERE job_id = ?")
      .bind(message, now, jobId).run()
    throw error
  }
}

async function enqueueHalloweenLiveSnapshot(env: WorkerEnv, eventYear: number, playerId: string, kind: "opening" | "periodic" | "closing", bucketStart: number): Promise<void> {
  if (!env.GLOBAL_RANKINGS_QUEUE) return
  const db = requireDb(env)
  const existing = await db.prepare("SELECT job_id AS jobId, status FROM halloween_live_snapshot_jobs WHERE event_year = ? AND player_id = ? AND snapshot_kind = ? AND bucket_start = ?")
    .bind(eventYear, playerId, kind, bucketStart).first<{ jobId: string; status: string }>()
  // Each event bucket receives one bounded queue attempt sequence. A terminal
  // failure is not re-enqueued on every five-minute scheduler tick.
  if (existing) return
  const now = new Date().toISOString()
  const jobId = crypto.randomUUID()
  await db.prepare("INSERT INTO halloween_live_snapshot_jobs (job_id, event_year, player_id, snapshot_kind, bucket_start, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
    .bind(jobId, eventYear, playerId, kind, bucketStart, now, now).run()
  await env.GLOBAL_RANKINGS_QUEUE.send({ kind: "halloween-live-snapshot", jobId })
}

async function enqueueScheduledHalloweenSnapshots(env: WorkerEnv, scheduledTime: number): Promise<number> {
  if (!env.DB || !env.GLOBAL_RANKINGS_QUEUE) return 0
  const db = requireDb(env)
  const nowMs = scheduledTime
  const nowIso = new Date(nowMs).toISOString()
  const events = await db.prepare("SELECT event_year AS eventYear, start_at AS startAt, end_at AS endAt FROM halloween_event_windows WHERE live_collection_enabled = 1")
    .all<{ eventYear: number; startAt: string; endAt: string }>()
  let queued = 0
  for (const event of events.results ?? []) {
    const startMs = Date.parse(event.startAt)
    const endMs = Date.parse(event.endAt)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const members = await db.prepare("SELECT p.player_id AS playerId, s.start_minute_of_day AS startMinuteOfDay FROM players p JOIN halloween_member_event_slots s ON s.player_id = p.player_id AND s.event_year = ? LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.faction_id = ? AND st.disabled_at IS NULL")
      .bind(event.eventYear, NAUGHTY_SOULS_FACTION_ID).all<{ playerId: string; startMinuteOfDay: number }>()
    for (const member of members.results ?? []) {
      let personalWindow: HalloweenMemberEventWindow
      try { personalWindow = buildHalloweenMemberEventWindow(event, Number(member.startMinuteOfDay)) } catch { continue }
      const memberStartMs = Date.parse(personalWindow.startAt || "")
      const memberEndMs = Date.parse(personalWindow.endAt || "")
      if (!Number.isFinite(memberStartMs) || !Number.isFinite(memberEndMs) || memberEndMs <= memberStartMs) continue
      const openingExists = await db.prepare("SELECT job_id FROM halloween_live_snapshot_jobs WHERE event_year = ? AND player_id = ? AND snapshot_kind = 'opening' AND status = 'complete' LIMIT 1")
        .bind(event.eventYear, member.playerId).first<{ job_id: string }>()
      if (!openingExists && nowMs >= memberStartMs - 5 * 60 * 1000 && nowMs <= memberStartMs + 60 * 1000) {
        await enqueueHalloweenLiveSnapshot(env, event.eventYear, member.playerId, "opening", Math.floor(memberStartMs / 1000))
        queued++
        continue
      }
      if (nowMs >= memberStartMs && nowMs < memberEndMs) {
        const last = await db.prepare("SELECT MAX(captured_at) AS capturedAt FROM halloween_live_snapshots WHERE event_year = ? AND player_id = ?")
          .bind(event.eventYear, member.playerId).first<{ capturedAt: string | null }>()
        const lastMs = last?.capturedAt ? Date.parse(last.capturedAt) : Number.NEGATIVE_INFINITY
        if (!Number.isFinite(lastMs) || nowMs - lastMs >= 6 * 60 * 60 * 1000) {
          const bucket = memberStartMs + Math.floor((nowMs - memberStartMs) / (6 * 60 * 60 * 1000)) * (6 * 60 * 60 * 1000)
          await enqueueHalloweenLiveSnapshot(env, event.eventYear, member.playerId, "periodic", Math.floor(bucket / 1000))
          queued++
          continue
        }
      }
      const closingExists = await db.prepare("SELECT job_id FROM halloween_live_snapshot_jobs WHERE event_year = ? AND player_id = ? AND snapshot_kind = 'closing' AND status = 'complete' LIMIT 1")
        .bind(event.eventYear, member.playerId).first<{ job_id: string }>()
      if (!closingExists && nowMs >= memberEndMs && nowMs <= memberEndMs + 5 * 60 * 1000) {
        await enqueueHalloweenLiveSnapshot(env, event.eventYear, member.playerId, "closing", Math.floor(memberEndMs / 1000))
        queued++
      }
    }
  }
  return queued
}

async function handleGlobalRankingQueueBatch(batch: { messages: QueueMessage[]; queue?: string }, env: WorkerEnv): Promise<void> {
  if (batch.queue?.endsWith("-dlq")) {
    for (const message of batch.messages) {
      const body = isRecord(message.body) ? message.body : {}
      const runId = typeof body.runId === "string" ? body.runId : ""
      const halloweenJobId = typeof body.jobId === "string" ? body.jobId : ""
      const liveSnapshotJobId = typeof body.jobId === "string" ? body.jobId : ""
      if (body.kind === FACTION_STATS_QUEUE_KIND && runId) {
        await markFactionStatsRunFailed(env, runId, new Error("Faction stats collection exhausted its queue retries."))
      } else if (body.kind === FACTION_PERFORMANCE_QUEUE_KIND && runId) {
        await markFactionPerformanceRunFailed(env, runId, new Error("Faction performance collection exhausted its queue retries."))
      } else if (body.kind === "faction-weekly-finalize") {
        console.error("Weekly report finalization exhausted its queue retries.")
      } else if (body.kind === "halloween-live-snapshot" && liveSnapshotJobId) {
        await requireDb(env).prepare("UPDATE halloween_live_snapshot_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
          .bind("Live Halloween snapshot exhausted its queue retries.", new Date().toISOString(), liveSnapshotJobId).run()
      } else if (body.kind === "halloween-log-collection" && halloweenJobId) {
        await requireDb(env).prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ? AND status NOT IN ('complete', 'cancelled')")
          .bind("Historical collection exhausted its queue retries. Check the saved Full Access key and retry.", new Date().toISOString(), halloweenJobId).run()
      } else if (body.kind === "manual-snapshot-recovery" && runId) {
        await markManualSnapshotRecoveryFailed(env, runId, "Manual snapshot recovery exhausted its queue retries.")
      } else if (runId) {
        await markGlobalRankingRunFailed(env, runId, new Error("Global-ranking refresh exhausted its queue retries. The last good cache was preserved."))
      }
      message.ack()
    }
    return
  }
  for (const message of batch.messages) {
    const body = isRecord(message.body) ? message.body : {}
    const runId = typeof body.runId === "string" ? body.runId : ""
    const halloweenJobId = typeof body.jobId === "string" ? body.jobId : ""
    const liveSnapshotJobId = typeof body.jobId === "string" ? body.jobId : ""
    if (body.kind === FACTION_STATS_QUEUE_KIND && runId) {
      try {
        await runFactionStatsCollection(env, runId)
        message.ack()
      } catch (error) {
        const safe = factionCollectionSafeError(error)
        console.error("Faction stats collection attempt failed", { runId, summary: safe.summary, tornCode: safe.tornCode })
        const attempts = Math.max(1, Number(message.attempts ?? 1))
        message.retry({ delaySeconds: Math.min(60, attempts * 10) })
      }
      continue
    }
    if (body.kind === FACTION_PERFORMANCE_QUEUE_KIND && runId) {
      try {
        await runFactionPerformanceCollection(env, runId)
        message.ack()
      } catch (error) {
        // Emit only the classified, sanitized reason; never log the key,
        // request headers, raw upstream body, or arbitrary exception text.
        const safe = factionCollectionSafeError(error)
        console.error("Faction performance collection attempt failed", {
          runId,
          summary: safe.summary,
          tornCode: safe.tornCode,
        })
        // Leave retry exhaustion to Cloudflare Queues so the configured DLQ
        // receives the message and records the terminal collection failure.
        const attempts = Math.max(1, Number(message.attempts ?? 1))
        message.retry({ delaySeconds: Math.min(60, attempts * 10) })
      }
      continue
    }
    if (body.kind === "faction-weekly-finalize") {
      const weekStartAt = typeof body.weekStartAt === "string" ? body.weekStartAt : ""
      const parsedStart = Date.parse(weekStartAt)
      if (!Number.isFinite(parsedStart) || new Date(utcSundayStart(parsedStart)).toISOString() !== weekStartAt) {
        message.ack()
        continue
      }
      try {
        await finalizeFactionWeeklyReport(env, parsedStart)
        message.ack()
      } catch {
        const attempts = Math.max(1, Number(message.attempts ?? 1))
        message.retry({ delaySeconds: Math.min(60, attempts * 10) })
      }
      continue
    }
    if (body.kind === "halloween-live-snapshot" && liveSnapshotJobId) {
      try {
        await runHalloweenLiveSnapshotJob(env, liveSnapshotJobId)
        message.ack()
      } catch {
        const attempts = Number(message.attempts ?? 1)
        if (attempts < 4) message.retry({ delaySeconds: Math.min(60, attempts * 10) })
        else {
          await requireDb(env).prepare("UPDATE halloween_live_snapshot_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
            .bind("Live Halloween snapshot failed after repeated Torn API errors.", new Date().toISOString(), liveSnapshotJobId).run()
          message.ack()
        }
      }
      continue
    }
    if (body.kind === "halloween-log-collection" && halloweenJobId) {
      try {
        await runHalloweenLogCollectionPage(env, halloweenJobId)
        message.ack()
      } catch {
        const attempts = Number(message.attempts ?? 1)
        if (attempts < 4) message.retry({ delaySeconds: Math.min(30, attempts * 5) })
        else {
          await requireDb(env).prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
            .bind("Historical collection failed after repeated Torn API errors. Retry the collection from the Historical tab.", new Date().toISOString(), halloweenJobId).run()
          message.ack()
        }
      }
      continue
    }
    if (!runId) { message.ack(); continue }
    if (body.kind === "manual-snapshot-recovery") {
      const reportingDay = typeof body.reportingDay === "string" ? body.reportingDay : ""
      try {
        await runManualSnapshotRecovery(env, runId, reportingDay)
        message.ack()
      } catch (error) {
        const attempts = Number(message.attempts ?? 1)
        if (attempts < 4) {
          message.retry({ delaySeconds: Math.min(60, attempts * 15) })
        } else {
          await markManualSnapshotRecoveryFailed(env, runId, error instanceof Error ? error.message : "Manual snapshot recovery failed.")
          message.ack()
        }
      }
      continue
    }
    try {
      const result = await processGlobalRankingQueueMessage(env, runId)
      if (result === "busy") message.retry({ delaySeconds: 5 })
      else message.ack()
    } catch (error) {
      const attempts = Number(message.attempts ?? 1)
      if (attempts < 4) {
        message.retry({ delaySeconds: Math.min(30, attempts * 5) })
      } else {
        await markGlobalRankingRunFailed(env, runId, error)
        message.ack()
      }
    }
  }
}

async function refreshGlobalRankingCache(env: WorkerEnv, apiKey?: string, force = false): Promise<void> {
  if (!env.DB) return
  const db = requireDb(env)
  await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run()
  const cached = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ fetchedAt: string }>()
  const nowMs = Date.now()
  const cacheAge = cached?.fetchedAt ? nowMs - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY
  // Refresh the shared ranking cache after six hours when a request arrives.
  // The queue path stages bounded pages and only publishes after full validation.
  const maxAgeMs = 6 * 60 * 60 * 1000
  if (!force && Number.isFinite(cacheAge) && cacheAge >= 0 && cacheAge < maxAgeMs) return

  if (env.GLOBAL_RANKINGS_QUEUE) {
    await startGlobalRankingRefresh(env, force ? "scheduled" : "automatic", undefined, false, apiKey)
    return
  }

  // Local/test fallback only. Production is bound to GLOBAL_RANKINGS_QUEUE in wrangler.toml.
  let key = apiKey
  if (!key) key = await getGlobalRankingApiKey(env)
  const snapshot = await fetchGlobalCompanyRankings(key)
  await db.prepare("INSERT INTO global_rankings_cache (cache_id, companies_json, fetched_at) VALUES (1, ?, ?) ON CONFLICT(cache_id) DO UPDATE SET companies_json = excluded.companies_json, fetched_at = excluded.fetched_at")
    .bind(asJson(snapshot.companies), snapshot.snapshotFetchedAt).run()
}
async function verifyGlobalRankingsAgainstOfficialSnapshot(env: WorkerEnv, scheduledTime: number): Promise<void> {
  if (!env.DB) return
  const db = requireDb(env)
  await db.prepare(`CREATE TABLE IF NOT EXISTS global_rankings_verification (
    verification_day TEXT PRIMARY KEY,
    scheduled_at TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    ranking_snapshot_at TEXT,
    official_company_count INTEGER NOT NULL DEFAULT 0,
    ranking_company_count INTEGER NOT NULL DEFAULT 0,
    matched_company_count INTEGER NOT NULL DEFAULT 0,
    missing_from_rankings INTEGER NOT NULL DEFAULT 0,
    missing_from_official INTEGER NOT NULL DEFAULT 0,
    type_mismatch_count INTEGER NOT NULL DEFAULT 0,
    rating_mismatch_count INTEGER NOT NULL DEFAULT 0,
    weekly_income_mismatch_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_message TEXT
  )`).run()
  const scheduledAt = new Date(scheduledTime).toISOString()
  const verificationDay = scheduledAt.slice(0, 10)
  const save = async (record: {
    verifiedAt: string; rankingSnapshotAt: string | null; officialCount: number; rankingCount: number;
    matched: number; missingFromRankings: number; missingFromOfficial: number; typeMismatches: number;
    ratingMismatches: number; weeklyIncomeMismatches: number; status: string; errorMessage: string | null
  }) => {
    await db.prepare(`INSERT INTO global_rankings_verification (
      verification_day, scheduled_at, verified_at, ranking_snapshot_at, official_company_count, ranking_company_count,
      matched_company_count, missing_from_rankings, missing_from_official, type_mismatch_count, rating_mismatch_count,
      weekly_income_mismatch_count, status, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(verification_day) DO UPDATE SET scheduled_at = excluded.scheduled_at, verified_at = excluded.verified_at,
      ranking_snapshot_at = excluded.ranking_snapshot_at, official_company_count = excluded.official_company_count,
      ranking_company_count = excluded.ranking_company_count, matched_company_count = excluded.matched_company_count,
      missing_from_rankings = excluded.missing_from_rankings, missing_from_official = excluded.missing_from_official,
      type_mismatch_count = excluded.type_mismatch_count, rating_mismatch_count = excluded.rating_mismatch_count,
      weekly_income_mismatch_count = excluded.weekly_income_mismatch_count, status = excluded.status, error_message = excluded.error_message`)
      .bind(verificationDay, scheduledAt, record.verifiedAt, record.rankingSnapshotAt, record.officialCount, record.rankingCount,
        record.matched, record.missingFromRankings, record.missingFromOfficial, record.typeMismatches, record.ratingMismatches,
        record.weeklyIncomeMismatches, record.status, record.errorMessage).run()
  }
  try {
    const keyRow = await db.prepare("SELECT player_id FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string }>()
    const apiKey = keyRow ? await savedKey(env, keyRow.player_id) : null
    if (!apiKey) throw new Error("No saved Torn API key is available for the official company snapshot verification.")
    const [official, cached] = await Promise.all([
      fetchOfficialCompanySnapshot(apiKey),
      db.prepare("SELECT companies_json AS companiesJson, fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ companiesJson: string; fetchedAt: string }>(),
    ])
    const officialById = new Map<string, Record<string, unknown>>()
    for (const company of official.companies) officialById.set(String(company.companyId), company)
    const rankingCompanies = cached ? JSON.parse(cached.companiesJson) as Record<string, unknown>[] : []
    const rankingsById = new Map<string, Record<string, unknown>>()
    for (const company of rankingCompanies) {
      const id = String(company.companyId ?? "")
      if (id) rankingsById.set(id, company)
    }
    let matched = 0, typeMismatches = 0, ratingMismatches = 0, weeklyIncomeMismatches = 0
    for (const [id, officialCompany] of officialById) {
      const rankedCompany = rankingsById.get(id)
      if (!rankedCompany) continue
      matched += 1
      const officialType = numericField(officialCompany.companyTypeId)
      const rankedType = numericField(rankedCompany.companyTypeId)
      if (officialType !== null && rankedType !== null && officialType !== rankedType) typeMismatches += 1
      const officialRating = numericField(officialCompany.starRating)
      const rankedRating = numericField(rankedCompany.starRating)
      if (officialRating !== null && rankedRating !== null && officialRating !== rankedRating) ratingMismatches += 1
      const officialWeekly = numericField(officialCompany.weeklyIncome)
      const rankedWeekly = numericField(rankedCompany.weeklyIncome)
      if (officialWeekly !== null && rankedWeekly !== null && officialWeekly !== rankedWeekly) weeklyIncomeMismatches += 1
    }
    const missingFromRankings = Array.from(officialById.keys()).filter((id) => !rankingsById.has(id)).length
    const missingFromOfficial = Array.from(rankingsById.keys()).filter((id) => !officialById.has(id)).length
    const hasRankingCache = Boolean(cached && rankingCompanies.length)
    const hasDifferences = missingFromRankings > 0 || missingFromOfficial > 0 || typeMismatches > 0 || ratingMismatches > 0 || weeklyIncomeMismatches > 0
    await save({
      verifiedAt: new Date().toISOString(), rankingSnapshotAt: cached?.fetchedAt ?? null,
      officialCount: official.companies.length, rankingCount: rankingCompanies.length, matched,
      missingFromRankings, missingFromOfficial, typeMismatches, ratingMismatches, weeklyIncomeMismatches,
      status: !hasRankingCache ? "no_ranking_cache" : hasDifferences ? "differences_found" : "verified",
      errorMessage: null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 220) : "Official company snapshot verification failed."
    await save({ verifiedAt: new Date().toISOString(), rankingSnapshotAt: null, officialCount: 0, rankingCount: 0, matched: 0, missingFromRankings: 0, missingFromOfficial: 0, typeMismatches: 0, ratingMismatches: 0, weeklyIncomeMismatches: 0, status: "failed", errorMessage: message })
    throw error
  }
}

function historicalAdvertisingBudget(profile: unknown): number | null {
  const keys = ["advertisement_budget", "advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"]
  const visit = (value: unknown, depth = 0): number | null => {
    if (depth > 6) return null
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = visit(child, depth + 1)
        if (found !== null) return found
      }
      return null
    }
    if (!isRecord(value)) return null
    for (const key of keys) {
      const candidate = value[key]
      if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.max(0, candidate)
    }
    for (const child of Object.values(value)) {
      const found = visit(child, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  return visit(profile)
}

function historicalEmployeeWages(payload: unknown): number | null {
  // Reconstructed history may have a proven daily wage aggregate without a recoverable per-employee roster.
  // Accept it only when its source method is explicit and the accounting identity reconciles exactly.
  if (isRecord(payload) && payload.reconstructed === true && isRecord(payload.wage_reconstruction)) {
    const aggregate = payload.wage_reconstruction
    const totalWages = numericField(aggregate.total_wages)
    const dailyIncome = numericField(aggregate.daily_income)
    const dailyProfit = numericField(aggregate.daily_profit)
    const advertisingBudget = numericField(aggregate.advertising_budget)
    const stockOrderExpense = numericField(aggregate.stock_order_expense)
    const validSource = typeof aggregate.source === "string" && aggregate.source.trim().length > 0
    const validMethod = aggregate.method === "daily-income-minus-daily-profit-minus-advertising-budget-minus-stock-order-expense"
    if (totalWages !== null && totalWages >= 0 && Number.isInteger(totalWages) &&
      dailyIncome !== null && dailyProfit !== null && advertisingBudget !== null && stockOrderExpense !== null &&
      validSource && validMethod &&
      totalWages === dailyIncome - dailyProfit - advertisingBudget - stockOrderExpense) {
      return totalWages
    }
  }
  const hasEmployeeList = Array.isArray(payload) || (isRecord(payload) && (
    Array.isArray(payload.employees) ||
    (isRecord(payload.employees) && Array.isArray(payload.employees.employees))
  ))
  if (!hasEmployeeList) return null
  const employees = employeesFromPayload(payload)
  let total = 0
  for (const employee of employees) {
    const wage = numericField(employee.wage)
    if (wage === null || wage < 0) return null
    total += wage
  }
  return total
}

function historicalStockOrderExpense(stock: unknown): number | null {
  if (stock === null || stock === undefined || (!isRecord(stock) && !Array.isArray(stock))) return null
  const rows: Array<{ name: string; order: number | null; unitCost: number | null; rawCost: unknown }> = []
  const visit = (value: unknown, depth = 0, label = ""): void => {
    if (!value || typeof value !== "object" || depth > 7) return
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, depth + 1, String(index + 1)))
      return
    }
    if (!isRecord(value)) return
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(value, key)
    const unitCost = numericField(value.cost) ?? numericField(value.unit_cost) ?? numericField(value.cost_per_unit) ?? numericField(value.purchase_price)
    const hasCostField = ["cost", "unit_cost", "cost_per_unit", "purchase_price"].some(hasOwn)
    const hasOrderField = ["on_order", "onOrder"].some(hasOwn)
    const hasInventoryField = ["in_stock", "quantity", "amount", "price", "rrp"].some(hasOwn)
    if (hasOrderField || (hasCostField && hasInventoryField)) {
      rows.push({
        name: String(value.name ?? value.item_name ?? value.itemName ?? label ?? "Stock item"),
        order: numericField(value.on_order) ?? numericField(value.onOrder),
        unitCost,
        rawCost: value.cost
      })
      return
    }
    for (const [key, child] of Object.entries(value)) if (child && typeof child === "object") visit(child, depth + 1, key)
  }
  visit(stock)
  let total = 0
  for (const row of rows) {
    const nonOrderable = typeof row.rawCost === "string" && /cannot be ordered/i.test(row.rawCost)
    if (row.order === null) {
      if (nonOrderable || row.unitCost === 0) continue
      return null
    }
    const order = Math.max(0, row.order)
    if (order === 0) continue
    if (row.unitCost === null) return null
    total += order * Math.max(0, row.unitCost)
  }
  return total
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
async function persistFactionDirectorSnapshot(
  env: WorkerEnv,
  profile: unknown,
  stock: unknown = null,
  options: {
    kind: "initialization" | "lock-in"
    sourceTimestamp?: number | null
    schedule?: { cron: string; scheduledTime: number }
  },
): Promise<void> {
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
  const updatedAt = new Date().toISOString()
  const sourceMs = typeof options.sourceTimestamp === "number" && Number.isFinite(options.sourceTimestamp) && options.sourceTimestamp > 0
    ? options.sourceTimestamp * 1000
    : NaN
  const sourceAt = Number.isFinite(sourceMs) && !Number.isNaN(new Date(sourceMs).getTime()) ? new Date(sourceMs) : null
  const snapshotAt = options.kind === "lock-in"
    ? officialSnapshotSourceTime(options.sourceTimestamp, options.schedule)
    : sourceAt ?? new Date(updatedAt)
  if (!snapshotAt) return
  const fetchedAt = snapshotAt.toISOString()
  const day = new Date(snapshotAt.getTime() - 18 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const db = requireDb(env)

  // Live directory fields reflect processing time, while historical rows retain
  // Torn's source timestamp whenever it is available.
  await db.prepare("INSERT INTO faction_member_cache (player_id, player_name, faction_id, checked_at, is_director, company_id, company_name, company_type, company_type_id, company_rating, daily_income, weekly_income, profile_json, updated_at) VALUES (?, ?, '8317', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET is_director = 1, company_id = excluded.company_id, company_name = excluded.company_name, company_type = excluded.company_type, company_type_id = excluded.company_type_id, company_rating = excluded.company_rating, daily_income = excluded.daily_income, weekly_income = excluded.weekly_income, profile_json = excluded.profile_json, updated_at = excluded.updated_at")
    .bind(playerId, typeof director.name === "string" ? director.name : `Player #${playerId}`, updatedAt, companyId, name, typeName, typeId, rating, dailyIncome, weeklyIncome, asJson(profile), updatedAt).run()

  if (options.kind === "initialization") {
    // A legacy or existing initialization/lock-in row means this is not a new
    // baseline. Never manufacture an initialization snapshot on a later login.
    const existing = await db.prepare("SELECT snapshot_day FROM faction_director_snapshots WHERE player_id = ? AND company_id = ? LIMIT 1")
      .bind(playerId, companyId).first<{ snapshot_day: string }>()
    if (existing) return
    await db.prepare("INSERT INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at, snapshot_kind) VALUES (?, ?, ?, ?, ?, ?, 'initialization') ON CONFLICT(player_id, company_id, snapshot_day) DO NOTHING")
      .bind(playerId, companyId, day, asJson(profile), stock === null || stock === undefined ? null : asJson(stock), fetchedAt).run()
    return
  }

  await db.prepare("INSERT INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at, snapshot_kind) VALUES (?, ?, ?, ?, ?, ?, 'lock-in') ON CONFLICT(player_id, company_id, snapshot_day) DO UPDATE SET profile_json = excluded.profile_json, stock_json = excluded.stock_json, fetched_at = excluded.fetched_at, snapshot_kind = excluded.snapshot_kind WHERE faction_director_snapshots.snapshot_kind IN ('legacy', 'initialization')")
    .bind(playerId, companyId, day, asJson(profile), stock === null || stock === undefined ? null : asJson(stock), fetchedAt).run()
}
async function syncFactionDirectorDirectory(env: WorkerEnv, apiKey: string, limit = 20, forceRefresh = false): Promise<{ processed: number; pending: number; directors: Record<string, unknown>[] }> {
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
    if (!forceRefresh && checked && now - checked < 12 * 60 * 60 * 1000) continue
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

async function refreshFactionDirectoryFromAnyKey(env: WorkerEnv, limit = 35, forceRefresh = false): Promise<void> {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return
  const row = await requireDb(env).prepare("SELECT player_id, ciphertext, iv FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string; ciphertext: string; iv: string }>()
  if (!row) return
  try {
    const apiKey = await decryptKey(env, row.ciphertext, row.iv)
    await syncFactionDirectorDirectory(env, apiKey, limit, forceRefresh)
  } catch { /* Keep scheduled sync resilient to a revoked key or temporary Torn failure. */ }
}

async function refreshRankingProfiles(env: WorkerEnv, captureHistory = false, snapshotSchedule?: { cron: string; scheduledTime: number }): Promise<{ companiesChecked: number; companiesFailed: number; snapshotsAdded: number; snapshotsSkipped: number; snapshotsRejected: number }> {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) return { companiesChecked: 0, companiesFailed: 0, snapshotsAdded: 0, snapshotsSkipped: 0, snapshotsRejected: 0 }
  const db = requireDb(env)
  const perCompany = await db.prepare("SELECT player_id, company_id, ciphertext, iv FROM company_api_keys ORDER BY updated_at ASC").all<{ player_id: string; company_id: string; ciphertext: string; iv: string }>()
  const keys = perCompany.results ?? []
  const keyedPlayers = new Set(keys.map((row) => row.player_id))
  const legacy = await db.prepare("SELECT player_id, ciphertext, iv FROM company_keys ORDER BY updated_at ASC").all<{ player_id: string; ciphertext: string; iv: string }>()
  const work = [...keys, ...(legacy.results ?? []).filter((row) => !keyedPlayers.has(row.player_id)).map((row) => ({ ...row, company_id: "" }))]
  let companiesChecked = 0
  let companiesFailed = 0
  let snapshotsAdded = 0
  let snapshotsSkipped = 0
  let snapshotsRejected = 0
  const isManualSnapshotRecovery = captureHistory && snapshotSchedule?.cron === "manual-snapshot-recovery"
  for (const keyRow of work) {
    try {
      const apiKey = await decryptKey(env, keyRow.ciphertext, keyRow.iv)
      const client = new TornApiClient({ apiKey })
      const { profile, employees: employeePayload, stock, timestamp: sourceTimestamp } = await client.getCompanySelections()
      const companyId = companyIdFromPayload(profile)
      if (!companyId || (keyRow.company_id && String(companyId) !== keyRow.company_id)) continue
      const root = isRecord(profile) && isRecord(profile.company) ? profile.company : isRecord(profile) && isRecord(profile.profile) ? profile.profile : isRecord(profile) ? profile : {}
      const type = isRecord(root.type) ? root.type : {}
      const existing = await db.prepare("SELECT employees_json FROM companies WHERE player_id = ? AND company_id = ?").bind(keyRow.player_id, String(companyId)).first<{ employees_json: string }>()
      const employees = employeePayload === null ? existing?.employees_json ?? "{}" : asJson(employeePayload)
      const now = new Date().toISOString()
      const sourceSnapshotAt = captureHistory ? officialSnapshotSourceTime(sourceTimestamp, snapshotSchedule) : null
      const manualRecoverySnapshotAt = isManualSnapshotRecovery
        ? manualRecoverySnapshotSourceTime(sourceTimestamp, snapshotSchedule!.scheduledTime, Date.now())
        : null
      await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(keyRow.player_id, String(companyId), String(root.name ?? `Company #${companyId}`), typeof type.name === "string" ? type.name : null, asJson(profile), employees, now).run()
      if (sourceSnapshotAt) {
        const fetchedAt = sourceSnapshotAt.toISOString()
        await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(keyRow.player_id, String(companyId), asJson(profile), employees, fetchedAt).run()
      } else if (manualRecoverySnapshotAt) {
        // Manual recovery records the real Torn source time within today's reporting day.
        // One row per company/day makes queue retries idempotent.
        const fetchedAt = manualRecoverySnapshotAt.toISOString()
        const snapshotDay = new Date(manualRecoverySnapshotAt.getTime() - 18 * 60 * 60 * 1000).toISOString().slice(0, 10)
        const existingSnapshot = await db.prepare("SELECT snapshot_id FROM company_snapshots WHERE player_id = ? AND company_id = ? AND date(fetched_at, '-18 hours') = ? LIMIT 1")
          .bind(keyRow.player_id, String(companyId), snapshotDay).first<{ snapshot_id: number }>()
        if (!existingSnapshot) {
          await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)")
            .bind(keyRow.player_id, String(companyId), asJson(profile), employees, fetchedAt).run()
          snapshotsAdded += 1
        } else {
          snapshotsSkipped += 1
        }
      } else if (isManualSnapshotRecovery) {
        snapshotsRejected += 1
      }
      await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(keyRow.player_id, String(companyId), asJson(stock), now).run()
      if (sourceSnapshotAt) {
        const fetchedAt = sourceSnapshotAt.toISOString()
        await db.prepare("INSERT INTO company_financial_snapshots (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?)").bind(keyRow.player_id, String(companyId), asJson(stock), fetchedAt).run()
        await persistFactionDirectorSnapshot(env, profile, stock, {
          kind: "lock-in",
          sourceTimestamp,
          schedule: snapshotSchedule,
        })
      } else if (manualRecoverySnapshotAt) {
        const fetchedAt = manualRecoverySnapshotAt.toISOString()
        const snapshotDay = new Date(manualRecoverySnapshotAt.getTime() - 18 * 60 * 60 * 1000).toISOString().slice(0, 10)
        const existingFinancialSnapshot = await db.prepare("SELECT snapshot_id FROM company_financial_snapshots WHERE player_id = ? AND company_id = ? AND date(fetched_at, '-18 hours') = ? LIMIT 1")
          .bind(keyRow.player_id, String(companyId), snapshotDay).first<{ snapshot_id: number }>()
        if (!existingFinancialSnapshot) {
          await db.prepare("INSERT INTO company_financial_snapshots (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?)")
            .bind(keyRow.player_id, String(companyId), asJson(stock), fetchedAt).run()
        }
        // Refresh live director fields, but do not classify this catch-up as an official lock-in.
        await persistFactionDirectorSnapshot(env, profile, stock, {
          kind: "lock-in",
          sourceTimestamp,
          schedule: snapshotSchedule,
        })
      }
      companiesChecked += 1
      await evaluateAutomationForCompany(env, keyRow.player_id, String(companyId)).catch(() => undefined)
    } catch (error) {
      companiesFailed += 1
      await emitRefreshFailureAlerts(env, keyRow.player_id, keyRow.company_id || null, error).catch(() => undefined)
      /* One stale key or Torn API error must not stop the remaining companies. */
    }
  }
  return { companiesChecked, companiesFailed, snapshotsAdded, snapshotsSkipped, snapshotsRejected }
}

async function runManualSnapshotRecovery(env: WorkerEnv, runId: string, reportingDay: string): Promise<void> {
  if (!env.DB || !env.KEY_ENCRYPTION_SECRET) throw new Error("Persistent storage or company-key decryption is not configured.")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportingDay)) throw new Error("A valid reporting day is required.")
  const startedAtMs = Date.now()
  const currentReportingDay = new Date(startedAtMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (reportingDay !== currentReportingDay) throw new Error("Manual snapshot recovery is restricted to the current 18:00 UTC reporting day.")
  const db = requireDb(env)
  await ensureAutomationSchema(env)
  const previous = await db.prepare("SELECT status FROM automation_runs WHERE run_id = ?").bind(runId).first<{ status: string }>()
  if (previous?.status === "succeeded") return
  const startedAt = new Date(startedAtMs).toISOString()
  if (previous) {
    await db.prepare("UPDATE automation_runs SET trigger_name = ?, status = 'running', started_at = ?, finished_at = NULL, companies_checked = 0, companies_failed = 0, alerts_created = 0, error_summary = NULL WHERE run_id = ?")
      .bind("manual-snapshot-recovery", startedAt, runId).run()
  } else {
    await db.prepare("INSERT INTO automation_runs (run_id, trigger_name, status, started_at) VALUES (?, 'manual-snapshot-recovery', 'running', ?)")
      .bind(runId, startedAt).run()
  }

  const result = await refreshRankingProfiles(env, true, { cron: "manual-snapshot-recovery", scheduledTime: startedAtMs })
  const finishedAt = new Date().toISOString()
  const totalSavedOrAlreadyPresent = result.snapshotsAdded + result.snapshotsSkipped
  const status = totalSavedOrAlreadyPresent === 0 ? "failed"
    : result.companiesFailed > 0 || result.snapshotsRejected > 0 ? "partial" : "succeeded"
  const summary = ("Manual catch-up used actual Torn source timestamps. Snapshots added: " + result.snapshotsAdded
    + "; already present: " + result.snapshotsSkipped
    + "; source timestamps rejected: " + result.snapshotsRejected
    + "; company refreshes checked: " + result.companiesChecked
    + "; company refreshes failed: " + result.companiesFailed + ".").slice(0, 500)
  await db.prepare("UPDATE automation_runs SET status = ?, finished_at = ?, companies_checked = ?, companies_failed = ?, alerts_created = 0, error_summary = ? WHERE run_id = ?")
    .bind(status, finishedAt, result.companiesChecked, result.companiesFailed, summary, runId).run()
  if (status === "failed") throw new Error(summary)
}

async function markManualSnapshotRecoveryFailed(env: WorkerEnv, runId: string, error: string): Promise<void> {
  if (!env.DB) return
  try { await ensureAutomationSchema(env) } catch { return }
  await requireDb(env).prepare("UPDATE automation_runs SET status = 'failed', finished_at = ?, error_summary = ? WHERE run_id = ? AND status = 'running'")
    .bind(new Date().toISOString(), error.slice(0, 500), runId).run().catch(() => undefined)
}

type AdminAuditOutcome = "succeeded" | "failed" | "denied" | "pending"
type AdminJobStatus = "queued" | "running" | "completed" | "failed"

async function writeAdminAudit(env: WorkerEnv, actor: Session, action: string, targetType: string | null, targetId: string | null, outcome: AdminAuditOutcome, summary: string, details: Record<string, unknown> = {}): Promise<void> {
  try {
    await requireDb(env).prepare("INSERT INTO admin_audit_log (actor_player_id, actor_player_name, action, target_type, target_id, outcome, summary, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(actor.player_id, actor.player_name, action, targetType, targetId, outcome, summary.slice(0, 240), asJson(details), new Date().toISOString()).run()
  } catch { /* An audit write must not expose internals or roll back an otherwise completed maintenance action. */ }
}

function parseStoredJson(value: unknown): unknown {
  try { return JSON.parse(String(value)) as unknown } catch { return null }
}

type AlertRuleType = "income_drop" | "stale_data" | "refresh_failure" | "income_increase" | "rating_drop" | "roster_change"
type AlertRuleRow = { rule_id: string; owner_player_id: string; company_id: string | null; rule_type: AlertRuleType; enabled: number; threshold_percent: number; cooldown_hours: number; stale_after_hours: number; last_triggered_at: string | null; last_evaluated_at: string | null; created_at: string; updated_at: string }
type AlertEventInput = { severity: "info" | "warning" | "critical"; title: string; message: string; companyId?: string | null; previousValue?: number | null; currentValue?: number | null; changePercent?: number | null; sourceSnapshotAt?: string | null; dedupeSuffix: string }

const automationSchemaInitializations = new WeakMap<D1Database, Promise<void>>()

async function ensureAutomationSchema(env: WorkerEnv): Promise<void> {
  const db = requireDb(env)
  const existing = automationSchemaInitializations.get(db)
  if (existing) return existing

  // Share one bootstrap promise across concurrent requests in this Worker isolate.
  // If initialization fails, discard the rejected promise so a later request can retry.
  const initialization = createAutomationSchema(db)
  automationSchemaInitializations.set(db, initialization)
  try {
    await initialization
  } catch (error) {
    if (automationSchemaInitializations.get(db) === initialization) {
      automationSchemaInitializations.delete(db)
    }
    throw error
  }
}

async function createAutomationSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS alert_rules (
    rule_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    company_id TEXT,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('income_drop', 'stale_data', 'refresh_failure', 'income_increase', 'rating_drop', 'roster_change')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    threshold_percent REAL NOT NULL DEFAULT 15,
    cooldown_hours INTEGER NOT NULL DEFAULT 24,
    stale_after_hours INTEGER NOT NULL DEFAULT 30,
    last_triggered_at TEXT,
    last_evaluated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS alert_events (
    event_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL REFERENCES alert_rules(rule_id) ON DELETE CASCADE,
    company_id TEXT,
    rule_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    previous_value REAL,
    current_value REAL,
    change_percent REAL,
    source_snapshot_at TEXT,
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'acknowledged')),
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_runs (
    run_id TEXT PRIMARY KEY,
    trigger_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    companies_checked INTEGER NOT NULL DEFAULT 0,
    companies_failed INTEGER NOT NULL DEFAULT 0,
    alerts_created INTEGER NOT NULL DEFAULT 0,
    error_summary TEXT
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_preferences (
    owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    browser_notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_notifications_enabled IN (0, 1)),
    quiet_hours_enabled INTEGER NOT NULL DEFAULT 0 CHECK (quiet_hours_enabled IN (0, 1)),
    quiet_hours_start TEXT NOT NULL DEFAULT '22:00',
    quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    minimum_severity TEXT NOT NULL DEFAULT 'info' CHECK (minimum_severity IN ('info', 'warning', 'critical')),
    digest_mode TEXT NOT NULL DEFAULT 'instant' CHECK (digest_mode IN ('instant', 'daily', 'both', 'off')),
    updated_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_webhooks (
    owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_delivered_at TEXT,
    last_error TEXT
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS discord_account_links (
    owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL UNIQUE,
    alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (alerts_enabled IN (0, 1)),
    linked_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS discord_link_codes (
    code TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS discord_alert_poll_health (
    owner_player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    poll_started_at TEXT,
    poll_completed_at TEXT,
    last_success_at TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    error_code TEXT,
    error_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    events_seen INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    filtered INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    exhausted INTEGER NOT NULL DEFAULT 0,
    stale_recovered INTEGER NOT NULL DEFAULT 0,
    exhausted_deliveries INTEGER NOT NULL DEFAULT 0,
    stale_claims INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS discord_alert_poll_history (
    report_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    poll_started_at TEXT,
    poll_completed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    events_seen INTEGER NOT NULL DEFAULT 0,
    delivered INTEGER NOT NULL DEFAULT 0,
    filtered INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    exhausted INTEGER NOT NULL DEFAULT 0,
    stale_recovered INTEGER NOT NULL DEFAULT 0,
    exhausted_deliveries INTEGER NOT NULL DEFAULT 0,
    stale_claims INTEGER NOT NULL DEFAULT 0
  )`).run()
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_discord_alert_poll_history_owner_completed ON discord_alert_poll_history(owner_player_id, discord_user_id, poll_completed_at DESC)").run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS automation_delivery_log (
    delivery_id TEXT PRIMARY KEY,
    owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES alert_events(event_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
    status_code INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  )`).run()
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_automation_delivery_owner_created ON automation_delivery_log(owner_player_id, created_at DESC)").run()
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_alert_rules_owner_enabled ON alert_rules(owner_player_id, enabled, rule_type)").run()
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_alert_events_owner_status_created ON alert_events(owner_player_id, status, created_at)").run()
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_automation_runs_started ON automation_runs(started_at DESC)").run()
}

function dailyIncomeFromProfile(payload: unknown): number | null {
  const root = companyProfileRoot(payload)
  const income = isRecord(root.income) ? root.income : null
  const value = income?.daily
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function ratingFromProfile(payload: unknown): number | null {
  const root = companyProfileRoot(payload)
  const value = root.rating ?? (isRecord(root.company) ? root.company.rating : undefined)
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function employeesFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []
  const nested = Array.isArray(payload.employees) ? payload.employees : isRecord(payload.employees) && Array.isArray(payload.employees.employees) ? payload.employees.employees : null
  return nested ? nested.filter(isRecord) : []
}

function rosterCount(payload: unknown): number {
  const listed = employeesFromPayload(payload).length
  if (listed > 0) return listed
  if (isRecord(payload) && payload.reconstructed === true) {
    const reconstructedCount = numericField(payload.employee_count)
    if (reconstructedCount !== null && reconstructedCount >= 0 && Number.isInteger(reconstructedCount)) return reconstructedCount
  }
  return listed
}

function numericField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

type WebhookAlert = { eventId: string; ruleId: string; ruleType: string; severity: "info" | "warning" | "critical"; title: string; message: string; companyId?: string | null; createdAt: string }

function severityRank(value: unknown): number { return value === "critical" ? 3 : value === "warning" ? 2 : 1 }

function isWithinQuietHours(preferences: { quietHoursEnabled?: number; quietHoursStart?: string; quietHoursEnd?: string; timezone?: string } | null, at = new Date()): boolean {
  if (!preferences?.quietHoursEnabled) return false
  const timezone = typeof preferences.timezone === "string" && preferences.timezone ? preferences.timezone : "UTC"
  let parts: Record<string, string> = {}
  try { parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value])) }
  catch { return false }
  const now = Number(parts.hour) * 60 + Number(parts.minute)
  const parse = (value: unknown, fallback: string) => { const match = /^(\d{2}):(\d{2})$/.exec(typeof value === "string" ? value : fallback); return match ? Number(match[1]) * 60 + Number(match[2]) : Number(fallback.slice(0, 2)) * 60 + Number(fallback.slice(3)) }
  const start = parse(preferences.quietHoursStart, "22:00"), end = parse(preferences.quietHoursEnd, "08:00")
  return start === end ? true : start < end ? now >= start && now < end : now >= start || now < end
}

function buildWebhookPayload(endpoint: string, payload: Record<string, unknown>): Record<string, unknown> {
  let url: URL
  try { url = new URL(endpoint) } catch { return payload }
  if (!((url.hostname === "discord.com" || url.hostname === "discordapp.com") && url.pathname.startsWith("/api/webhooks/"))) return payload
  const event = String(payload.event || "automation.alert")
  if (event === "automation.test") return { content: "✅ Naughty Company Dashboard webhook test succeeded. Discord is connected and ready for alerts and summaries.", allowed_mentions: { parse: [] } }
  const alert = isRecord(payload.alert) ? payload.alert as unknown as WebhookAlert : null
  const digest = isRecord(payload.digest) ? payload.digest : null
  const alerts = digest && Array.isArray(digest.alerts) ? digest.alerts.filter(isRecord) as unknown as WebhookAlert[] : []
  const toEmbed = (item: WebhookAlert) => ({ title: String(item.title || "Dashboard alert").slice(0, 256), description: String(item.message || "An automation event was detected.").slice(0, 4096), color: item.severity === "critical" ? 0xD92D20 : item.severity === "warning" ? 0xF79009 : 0x1570EF, fields: [{ name: "Severity", value: String(item.severity || "info").toUpperCase().slice(0, 1024), inline: true }, { name: "Rule", value: String(item.ruleType || "automation").replace(/_/g, " ").slice(0, 1024), inline: true }, ...(item.companyId ? [{ name: "Company ID", value: String(item.companyId).slice(0, 1024), inline: true }] : [])], ...(item.createdAt ? { timestamp: item.createdAt } : {}), footer: { text: "Naughty Company Dashboard" } })
  if (event === "automation.daily_digest") return { content: `📊 **Naughty Company Dashboard daily summary** · ${Number(digest?.eventCount || alerts.length)} alert(s)`, embeds: alerts.slice(0, 10).map(toEmbed), allowed_mentions: { parse: [] } }
  if (alert) return { content: "🔔 **Naughty Company Dashboard alert**", embeds: [toEmbed(alert)], allowed_mentions: { parse: [] } }
  return { content: "Naughty Company Dashboard notification", allowed_mentions: { parse: [] } }
}

async function sendWebhookTest(env: WorkerEnv, ownerPlayerId: string, kind: "connection" | "alert" | "summary" = "connection"): Promise<{ delivered: boolean; statusCode?: number; detail: string }> {
  const db = requireDb(env)
  try {
    const hook = await db.prepare("SELECT ciphertext, iv FROM automation_webhooks WHERE owner_player_id = ? AND enabled = 1").bind(ownerPlayerId).first<{ ciphertext: string; iv: string }>()
    if (!hook) return { delivered: false, detail: "Save a webhook URL before sending a test message." }
    const endpoint = await decryptKey(env, hook.ciphertext, hook.iv)
    if (isDiscordChannelWebhook(endpoint)) return { delivered: false, detail: "Discord channel webhooks are disabled for privacy. Link the Discord bot to receive private direct messages." }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    let statusCode: number | undefined
    let detail = ""
    try {
      const now = new Date().toISOString()
      const sampleAlert: WebhookAlert = { eventId: "test-alert", ruleId: "test-rule", ruleType: "income_drop", severity: "warning", title: "Sample automation alert", message: "This is a sample alert to verify that Naughty Company Dashboard alert formatting is reaching Discord correctly. No real alert was created.", companyId: "sample-company", createdAt: now }
      const source = { source: "Naughty Company Dashboard", event: kind === "alert" ? "automation.alert" : kind === "summary" ? "automation.daily_digest" : "automation.test" }
      const eventPayload = kind === "alert" ? { ...source, alert: sampleAlert } : kind === "summary" ? { ...source, digest: { generatedAt: now, eventCount: 2, alerts: [sampleAlert, { ...sampleAlert, eventId: "test-alert-2", severity: "critical", title: "Sample critical alert", message: "Second sample item included to preview how a daily summary groups multiple alerts." }] } } : source
      const payload = buildWebhookPayload(endpoint, eventPayload)
      const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": "Naughty-Company-Dashboard/1.0" }, body: JSON.stringify(payload), signal: controller.signal })
      statusCode = response.status
      const label = kind === "alert" ? "Sample alert" : kind === "summary" ? "Sample daily summary" : "Connection test"
      detail = response.ok ? `${label} delivered. Check your Discord channel.` : `Webhook endpoint returned HTTP ${response.status}.`
    } catch (error) { detail = error instanceof Error && error.name === "AbortError" ? "Webhook test timed out after 5 seconds." : "Webhook test failed. Check the saved endpoint and try again." }
    finally { clearTimeout(timeout) }
    const delivered = statusCode !== undefined && statusCode >= 200 && statusCode < 300
    const now = new Date().toISOString()
    await db.prepare("UPDATE automation_webhooks SET last_delivered_at = CASE WHEN ? = 1 THEN ? ELSE last_delivered_at END, last_error = ?, updated_at = ? WHERE owner_player_id = ?").bind(Number(delivered), now, delivered ? null : detail, now, ownerPlayerId).run()
    return { delivered, statusCode, detail }
  } catch { return { delivered: false, detail: "Webhook test could not be completed. Check the Worker encryption settings and saved endpoint." } }
}

async function deliverAutomationWebhook(env: WorkerEnv, ownerPlayerId: string, alert: WebhookAlert, options: { ignoreDigestMode?: boolean; ignoreQuietHours?: boolean } = {}): Promise<{ attempted: boolean; delivered: boolean; statusCode?: number; detail?: string }> {
  const db = requireDb(env)
  try {
    const [hook, preferences] = await Promise.all([
      db.prepare("SELECT ciphertext, iv FROM automation_webhooks WHERE owner_player_id = ? AND enabled = 1").bind(ownerPlayerId).first<{ ciphertext: string; iv: string }>(),
      db.prepare("SELECT minimum_severity AS minimumSeverity, digest_mode AS digestMode, quiet_hours_enabled AS quietHoursEnabled, quiet_hours_start AS quietHoursStart, quiet_hours_end AS quietHoursEnd, timezone FROM automation_preferences WHERE owner_player_id = ?").bind(ownerPlayerId).first<{ minimumSeverity: string; digestMode: string; quietHoursEnabled: number; quietHoursStart: string; quietHoursEnd: string; timezone: string }>(),
    ])
    if (!hook) return { attempted: false, delivered: false, detail: "No webhook is configured." }
    if (preferences?.minimumSeverity && severityRank(alert.severity) < severityRank(preferences.minimumSeverity)) return { attempted: false, delivered: false, detail: "Alert is below the configured minimum severity." }
    if (!options.ignoreDigestMode && preferences?.digestMode !== undefined && !["instant", "both"].includes(preferences.digestMode)) return { attempted: false, delivered: false, detail: preferences.digestMode === "off" ? "Webhook delivery is disabled by notification preferences." : "Alert is queued for daily digest delivery." }
    if (!options.ignoreQuietHours && isWithinQuietHours(preferences)) return { attempted: false, delivered: false, detail: "Alert is within configured quiet hours." }
    const endpoint = await decryptKey(env, hook.ciphertext, hook.iv)
    if (isDiscordChannelWebhook(endpoint)) return { attempted: true, delivered: false, detail: "Discord channel webhooks are disabled for privacy. Link the Discord bot to receive private direct messages." }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    let statusCode: number | undefined
    let detail = ""
    try {
      const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": "Naughty-Company-Dashboard/1.0" }, body: JSON.stringify(buildWebhookPayload(endpoint, { source: "Naughty Company Dashboard", event: "automation.alert", alert })), signal: controller.signal })
      statusCode = response.status
      if (!response.ok) detail = `Webhook endpoint returned HTTP ${response.status}.`
      else detail = "Webhook delivered successfully."
    } catch (error) { detail = error instanceof Error && error.name === "AbortError" ? "Webhook request timed out after 5 seconds." : "Webhook request failed. Check the endpoint and try again." }
    finally { clearTimeout(timeout) }
    const now = new Date().toISOString(), delivered = statusCode !== undefined && statusCode >= 200 && statusCode < 300
    await db.prepare("INSERT INTO automation_delivery_log (delivery_id, owner_player_id, event_id, status, status_code, detail, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), ownerPlayerId, alert.eventId, delivered ? "delivered" : "failed", statusCode ?? null, detail, now, delivered ? now : null).run()
    await db.prepare("UPDATE automation_webhooks SET last_delivered_at = CASE WHEN ? = 1 THEN ? ELSE last_delivered_at END, last_error = ?, updated_at = ? WHERE owner_player_id = ?").bind(Number(delivered), now, delivered ? null : detail, now, ownerPlayerId).run()
    return { attempted: true, delivered, statusCode, detail }
  } catch {
    const failedAt = new Date().toISOString()
    const detail = "Webhook delivery could not be completed. Check the configured endpoint and encryption settings."
    // Record failures that occur before the HTTP request, such as key decryption errors.
    // Best-effort logging must never mask the original delivery result.
    try {
      await db.prepare("INSERT INTO automation_delivery_log (delivery_id, owner_player_id, event_id, status, status_code, detail, created_at, delivered_at) VALUES (?, ?, ?, 'failed', NULL, ?, ?, NULL)")
        .bind(crypto.randomUUID(), ownerPlayerId, alert.eventId, detail, failedAt).run()
    } catch { /* The database itself may be unavailable. */ }
    try {
      await db.prepare("UPDATE automation_webhooks SET last_error = ?, updated_at = ? WHERE owner_player_id = ?")
        .bind(detail, failedAt, ownerPlayerId).run()
    } catch { /* Keep the caller resilient if status persistence is unavailable. */ }
    return { attempted: true, delivered: false, detail }
  }
}

async function deliverAutomationDigest(env: WorkerEnv, ownerPlayerId: string, alerts: WebhookAlert[]): Promise<boolean> {
  const db = requireDb(env)
  if (!alerts.length) return false
  try {
    const [hook, preferences] = await Promise.all([
      db.prepare("SELECT ciphertext, iv FROM automation_webhooks WHERE owner_player_id = ? AND enabled = 1").bind(ownerPlayerId).first<{ ciphertext: string; iv: string }>(),
      db.prepare("SELECT minimum_severity AS minimumSeverity FROM automation_preferences WHERE owner_player_id = ?").bind(ownerPlayerId).first<{ minimumSeverity: string }>(),
    ])
    if (!hook) return false
    const minimumRank = severityRank(preferences?.minimumSeverity ?? "info")
    const eligible = alerts.filter((alert) => severityRank(alert.severity) >= minimumRank)
    if (!eligible.length) return false
    const endpoint = await decryptKey(env, hook.ciphertext, hook.iv)
    let anyDelivered = false
    let anyFailed = false
    let lastFailure = ""
    const batchCount = Math.ceil(eligible.length / 10)
    for (let offset = 0; offset < eligible.length; offset += 10) {
      const batch = eligible.slice(offset, offset + 10)
      const now = new Date().toISOString()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      let statusCode: number | undefined
      let detail = ""
      try {
        const response = await fetch(endpoint, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "user-agent": "Naughty-Company-Dashboard/1.0" }, body: JSON.stringify(buildWebhookPayload(endpoint, { source: "Naughty Company Dashboard", event: "automation.daily_digest", digest: { generatedAt: now, eventCount: batch.length, alerts: batch } })), signal: controller.signal })
        statusCode = response.status
        detail = response.ok ? `Daily digest batch ${Math.floor(offset / 10) + 1}/${batchCount} delivered with ${batch.length} alerts.` : `Webhook endpoint returned HTTP ${response.status} for daily digest batch ${Math.floor(offset / 10) + 1}/${batchCount}.`
      } catch (error) { detail = error instanceof Error && error.name === "AbortError" ? "Daily digest request timed out after 5 seconds." : "Daily digest request failed. Check the endpoint and try again." }
      finally { clearTimeout(timeout) }
      const delivered = statusCode !== undefined && statusCode >= 200 && statusCode < 300
      anyDelivered ||= delivered
      anyFailed ||= !delivered
      if (!delivered) lastFailure = detail
      for (const alert of batch) {
        await db.prepare("INSERT INTO automation_delivery_log (delivery_id, owner_player_id, event_id, status, status_code, detail, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), ownerPlayerId, alert.eventId, delivered ? "delivered" : "failed", statusCode ?? null, detail, now, delivered ? now : null).run()
      }
    }
    const finishedAt = new Date().toISOString()
    await db.prepare("UPDATE automation_webhooks SET last_delivered_at = CASE WHEN ? = 1 THEN ? ELSE last_delivered_at END, last_error = ?, updated_at = ? WHERE owner_player_id = ?").bind(Number(anyDelivered), finishedAt, anyFailed ? lastFailure : null, finishedAt, ownerPlayerId).run()
    return anyFailed
  } catch {
    // Keep failures visible even when decrypting the webhook or recording individual deliveries fails.
    // Avoid surfacing raw exception text because it may contain provider-specific endpoint details.
    try {
      const failedAt = new Date().toISOString()
      await db.prepare("UPDATE automation_webhooks SET last_error = ?, updated_at = ? WHERE owner_player_id = ?")
        .bind("Daily digest could not be completed. Check the configured endpoint and encryption settings.", failedAt, ownerPlayerId).run()
    } catch { /* The database itself may be unavailable; the next scheduled pass can retry. */ }
    return true
  }
}

async function deliverDailyAutomationDigests(env: WorkerEnv, now = new Date()): Promise<number> {
  const db = requireDb(env)
  const cutoff = new Date(now.getTime() - DAY * 1000).toISOString()
  const owners = await db.prepare("SELECT owner_player_id AS ownerPlayerId, timezone, quiet_hours_enabled AS quietHoursEnabled, quiet_hours_start AS quietHoursStart, quiet_hours_end AS quietHoursEnd, minimum_severity AS minimumSeverity FROM automation_preferences WHERE digest_mode IN ('daily', 'both')").all<{ ownerPlayerId: string; timezone: string; quietHoursEnabled: number; quietHoursStart: string; quietHoursEnd: string; minimumSeverity: string }>()
  let failedOwners = 0
  for (const owner of owners.results ?? []) {
    if (isWithinQuietHours(owner, now)) continue
    try {
      const minimumRank = severityRank(owner.minimumSeverity)
      const events = await db.prepare("SELECT e.event_id AS eventId, e.rule_id AS ruleId, e.rule_type AS ruleType, e.severity, e.title, e.message, e.company_id AS companyId, e.created_at AS createdAt FROM alert_events e WHERE e.owner_player_id = ? AND e.created_at <= ? AND CASE e.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END >= ? AND NOT EXISTS (SELECT 1 FROM automation_delivery_log d WHERE d.owner_player_id = e.owner_player_id AND d.event_id = e.event_id AND d.status = 'delivered' AND d.detail LIKE 'Daily digest%') ORDER BY e.created_at ASC LIMIT 50").bind(owner.ownerPlayerId, cutoff, minimumRank).all<WebhookAlert>()
      if (await deliverAutomationDigest(env, owner.ownerPlayerId, events.results ?? [])) failedOwners += 1
    } catch { failedOwners += 1 }
  }
  return failedOwners
}

function isDiscordChannelWebhook(value: string): boolean {
  try { const url = new URL(value); return /(^|\.)discord(?:app)?\.com$/i.test(url.hostname) && url.pathname.startsWith("/api/webhooks/") } catch { return false }
}
function validateWebhookUrl(value: unknown): string | null { const url = normalizeWebhookUrl(value); return url && !isDiscordChannelWebhook(url) ? url : null }

async function createAlertEvent(env: WorkerEnv, rule: AlertRuleRow, input: AlertEventInput): Promise<boolean> {
  const db = requireDb(env)
  const now = new Date().toISOString()
  const lastTriggered = rule.last_triggered_at ? Date.parse(rule.last_triggered_at) : Number.NaN
  const cooldownHours = normalizeCooldownHours(rule.cooldown_hours)
  if (Number.isFinite(lastTriggered) && Date.now() - lastTriggered < cooldownHours * 3600000) return false
  const dedupeKey = `${rule.rule_id}:${input.dedupeSuffix}`
  const eventId = crypto.randomUUID()
  const companyId = input.companyId ?? rule.company_id
  const result = await db.prepare("INSERT OR IGNORE INTO alert_events (event_id, owner_player_id, rule_id, company_id, rule_type, severity, title, message, previous_value, current_value, change_percent, source_snapshot_at, status, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?)")
    .bind(eventId, rule.owner_player_id, rule.rule_id, companyId, rule.rule_type, input.severity, input.title.slice(0, 120), input.message.slice(0, 500), input.previousValue ?? null, input.currentValue ?? null, input.changePercent ?? null, input.sourceSnapshotAt ?? null, dedupeKey, now).run()
  const inserted = (result.meta?.changes ?? 0) > 0
  if (inserted) {
    await db.prepare("UPDATE alert_rules SET last_triggered_at = ?, updated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(now, now, rule.rule_id, rule.owner_player_id).run()
    await deliverAutomationWebhook(env, rule.owner_player_id, { eventId, ruleId: rule.rule_id, ruleType: rule.rule_type, severity: input.severity, title: input.title.slice(0, 120), message: input.message.slice(0, 500), companyId, createdAt: now }).catch(() => undefined)
  }
  return inserted
}

async function evaluateAutomationForCompany(env: WorkerEnv, playerId: string, companyId: string): Promise<void> {
  await ensureAutomationSchema(env)
  const db = requireDb(env)
  const ruleResult = await db.prepare("SELECT * FROM alert_rules WHERE owner_player_id = ? AND enabled = 1 AND (company_id IS NULL OR company_id = ?)").bind(playerId, companyId).all<AlertRuleRow>()
  const rules = ruleResult.results ?? []
  if (!rules.length) return
  const snapshots = await db.prepare("SELECT profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? AND company_id = ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 2").bind(playerId, companyId).all<{ profileJson: string; employeesJson: string; fetchedAt: string }>()
  const rows = snapshots.results ?? []
  const current = rows[0]
  const previous = rows[1]
  const currentIncome = current ? dailyIncomeFromProfile(parseStoredJson(current.profileJson)) : null
  const previousIncome = previous ? dailyIncomeFromProfile(parseStoredJson(previous.profileJson)) : null
  const now = new Date().toISOString()
  for (const rule of rules) {
    try {
      if (rule.rule_type === "income_drop" && current && previous) {
        const drop = evaluateIncomeDrop(previousIncome, currentIncome, rule.threshold_percent)
        if (drop) await createAlertEvent(env, rule, {
          severity: "warning", title: "Daily income dropped",
          message: `Daily income fell ${Math.abs(drop.changePercent).toFixed(1)}% since the previous successful company refresh.`,
          companyId, previousValue: previousIncome, currentValue: currentIncome, changePercent: drop.changePercent,
          sourceSnapshotAt: current.fetchedAt, dedupeSuffix: `income:${current.fetchedAt}`,
        })
      }
      if (rule.rule_type === "income_increase" && current && previous && currentIncome !== null && previousIncome !== null && previousIncome > 0) {
        const rise = evaluateIncomeIncrease(previousIncome, currentIncome, rule.threshold_percent)
        if (rise) await createAlertEvent(env, rule, {
          severity: "info", title: "Daily income increased",
          message: `Daily income increased ${rise.changePercent.toFixed(1)}% since the previous successful company refresh.`,
          companyId, previousValue: previousIncome, currentValue: currentIncome, changePercent: rise.changePercent,
          sourceSnapshotAt: current.fetchedAt, dedupeSuffix: `income-rise:${current.fetchedAt}`,
        })
      }
      if (rule.rule_type === "rating_drop" && current && previous) {
        const before = ratingFromProfile(parseStoredJson(previous.profileJson)), after = ratingFromProfile(parseStoredJson(current.profileJson))
        if (before !== null && after !== null && before > 0) {
          const drop = evaluatePercentageDrop(before, after, rule.threshold_percent)
          if (drop) await createAlertEvent(env, rule, {
            severity: "warning", title: "Company rating dropped",
            message: `Company rating decreased ${Math.abs(drop.changePercent).toFixed(1)}% between successful snapshots.`,
            companyId, previousValue: before, currentValue: after, changePercent: drop.changePercent,
            sourceSnapshotAt: current.fetchedAt, dedupeSuffix: `rating:${current.fetchedAt}`,
          })
        }
      }
      if (rule.rule_type === "roster_change" && current && previous) {
        const before = rosterCount(parseStoredJson(previous.employeesJson)), after = rosterCount(parseStoredJson(current.employeesJson))
        const change = evaluateRosterChange(before, after, rule.threshold_percent)
        if (change) await createAlertEvent(env, rule, {
          severity: after < before ? "warning" : "info", title: after < before ? "Employee roster contracted" : "Employee roster grew",
          message: `Roster size changed from ${before} to ${after} employees (${change.changePercent > 0 ? "+" : ""}${change.changePercent.toFixed(1)}%) between successful snapshots.`,
          companyId, previousValue: before, currentValue: after, changePercent: change.changePercent,
          sourceSnapshotAt: current.fetchedAt, dedupeSuffix: `roster:${current.fetchedAt}`,
        })
      }
      await db.prepare("UPDATE alert_rules SET last_evaluated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(now, rule.rule_id, playerId).run()
    } catch { /* A malformed rule must not interrupt company refreshes. */ }
  }
}

async function emitRefreshFailureAlerts(env: WorkerEnv, playerId: string, companyId: string | null, error: unknown): Promise<void> {
  await ensureAutomationSchema(env)
  const db = requireDb(env)
  const rows = await db.prepare("SELECT * FROM alert_rules WHERE owner_player_id = ? AND enabled = 1 AND rule_type = 'refresh_failure' AND (company_id IS NULL OR (? IS NOT NULL AND company_id = ?))")
    .bind(playerId, companyId, companyId).all<AlertRuleRow>()
  const now = new Date().toISOString()
  const detail = error instanceof Error ? error.message : "The refresh failed unexpectedly."
  const safeDetail = detail.replace(/ApiKey\s+\S+/gi, "API key [redacted]").replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]").slice(0, 180)
  for (const rule of rows.results ?? []) {
    await createAlertEvent(env, rule, {
      severity: "critical", title: "Company refresh failed",
      message: `The scheduled company refresh did not complete. ${safeDetail || "Check the saved connection and retry."}`,
      companyId, sourceSnapshotAt: now, dedupeSuffix: `refresh-failure:${now.slice(0, 10)}`,
    }).catch(() => false)
  }
}

async function evaluateStaleDataRules(env: WorkerEnv): Promise<number> {
  await ensureAutomationSchema(env)
  const db = requireDb(env)
  const result = await db.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND rule_type = 'stale_data'").all<AlertRuleRow>()
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  let failedRules = 0
  for (const rule of result.results ?? []) {
    try {
      const latest = rule.company_id
        ? await db.prepare("SELECT company_id AS companyId, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? AND company_id = ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 1").bind(rule.owner_player_id, rule.company_id).first<{ companyId: string; fetchedAt: string }>()
        : await db.prepare("SELECT company_id AS companyId, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 1").bind(rule.owner_player_id).first<{ companyId: string; fetchedAt: string }>()
      if (!latest) {
        await createAlertEvent(env, rule, { severity: "warning", title: "No company snapshot available", message: "No successful company snapshot is available for this rule yet. Check the company connection and refresh status.", companyId: rule.company_id, dedupeSuffix: `no-snapshot:${now.slice(0, 10)}` })
      } else if (isSnapshotStale(latest.fetchedAt, nowMs, rule.stale_after_hours)) {
        const ageHours = Math.max(0, Math.floor((nowMs - Date.parse(latest.fetchedAt)) / 3600000))
        await createAlertEvent(env, rule, { severity: "warning", title: "Company data is stale", message: `The last successful company snapshot is ${ageHours} hours old. The configured limit is ${rule.stale_after_hours} hours.`, companyId: latest.companyId, sourceSnapshotAt: latest.fetchedAt, dedupeSuffix: `stale:${now.slice(0, 10)}` })
      }
      await db.prepare("UPDATE alert_rules SET last_evaluated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(now, rule.rule_id, rule.owner_player_id).run()
    } catch { failedRules += 1 /* Keep other rules running if a single stored rule is malformed. */ }
  }
  return failedRules
}

async function runScheduledAutomation(controller: { scheduledTime: number; cron: string }, env: WorkerEnv): Promise<void> {
  if (!env.DB) return
  const db = requireDb(env)
  const isRankingCaptureWindow = controller.cron.trim() === "10 18 * * *"
  const isOfficialVerificationWindow = controller.cron.trim() === "10 0 * * *"
  try { await ensureAutomationSchema(env) } catch {
    const fallbackTasks: Promise<unknown>[] = [refreshRankingProfiles(env, isRankingCaptureWindow, { cron: controller.cron, scheduledTime: controller.scheduledTime }), refreshFactionDirectoryFromAnyKey(env, 35)]
    if (isRankingCaptureWindow) fallbackTasks.push(refreshGlobalRankingCache(env, undefined, true))
    if (isOfficialVerificationWindow) fallbackTasks.push(verifyGlobalRankingsAgainstOfficialSnapshot(env, controller.scheduledTime))
    await Promise.allSettled(fallbackTasks)
    return
  }
  const runId = crypto.randomUUID()
  const startedAt = new Date(controller.scheduledTime).toISOString()
  await db.prepare("INSERT INTO automation_runs (run_id, trigger_name, status, started_at) VALUES (?, ?, 'running', ?)").bind(runId, controller.cron || "scheduled", startedAt).run()
  const isWeeklyLock = new Date(controller.scheduledTime).getUTCDay() === 0
  const tasks: Promise<unknown>[] = [refreshRankingProfiles(env, isRankingCaptureWindow, { cron: controller.cron, scheduledTime: controller.scheduledTime }), refreshFactionDirectoryFromAnyKey(env, isWeeklyLock ? 250 : 35)]
  if (isRankingCaptureWindow) tasks.push(refreshGlobalRankingCache(env, undefined, true))
  if (isOfficialVerificationWindow) tasks.push(verifyGlobalRankingsAgainstOfficialSnapshot(env, controller.scheduledTime))
  if (isWeeklyLock) tasks.push(captureWeeklyFactionStarCounts(env, startedAt))
  const results = await Promise.allSettled(tasks)
  let staleRuleFailures = 0
  let digestFailures = 0
  try { staleRuleFailures = await evaluateStaleDataRules(env) } catch { staleRuleFailures = 1 }
  try { digestFailures = await deliverDailyAutomationDigests(env) } catch { digestFailures = 1 }
  const refresh = results[0]
  const refreshSummary = refresh.status === "fulfilled" ? refresh.value as { companiesChecked?: number; companiesFailed?: number } : { companiesChecked: 0, companiesFailed: 0 }
  const failures = results.filter((item) => item.status === "rejected").map((item) => item.status === "rejected" ? (item.reason instanceof Error ? item.reason.message : "A scheduled task failed.") : "")
  const companiesChecked = Number(refreshSummary.companiesChecked ?? 0)
  const companiesFailed = Number(refreshSummary.companiesFailed ?? 0) + (refresh.status === "rejected" ? 1 : 0)
  const alerts = await db.prepare("SELECT COUNT(*) AS count FROM alert_events WHERE created_at >= ?").bind(startedAt).first<{ count: number }>().catch(() => null)
  const allTasksFailed = results.every((item) => item.status === "rejected")
  const hasFailures = failures.length > 0 || companiesFailed > 0 || staleRuleFailures > 0 || digestFailures > 0
  const status = allTasksFailed ? "failed" : (hasFailures ? "partial" : "succeeded")
  const finishedAt = new Date().toISOString()
  const summary = [...failures, ...(companiesFailed ? [`${companiesFailed} company refresh(es) failed.`] : []), ...(staleRuleFailures ? [`${staleRuleFailures} stale-data rule evaluation(s) failed.`] : []), ...(digestFailures ? [`${digestFailures} daily digest delivery group(s) failed.`] : [])].join(" ").slice(0, 500) || null
  await db.prepare("UPDATE automation_runs SET status = ?, finished_at = ?, companies_checked = ?, companies_failed = ?, alerts_created = ?, error_summary = ? WHERE run_id = ?")
    .bind(status, finishedAt, companiesChecked, companiesFailed, Number(alerts?.count ?? 0), summary, runId).run()
}

type AdminRefreshEndpoint = "company-profile" | "company-employees" | "company-stock" | "global-company-rankings" | "faction-directory"
type AdminEndpointRefreshConfig = { endpoints: AdminRefreshEndpoint[]; scope: "all" | "selected"; targetPlayerIds: string[] }

const ADMIN_REFRESH_ENDPOINTS: AdminRefreshEndpoint[] = [
  "company-profile", "company-employees", "company-stock", "global-company-rankings", "faction-directory",
]

async function ensureAdminJobPayloadSchema(env: WorkerEnv): Promise<void> {
  const db = requireDb(env)
  const columns = await db.prepare("PRAGMA table_info(admin_jobs)").all<{ name: string }>()
  if ((columns.results ?? []).some((column) => column.name === "job_payload_json")) return
  try {
    await db.prepare("ALTER TABLE admin_jobs ADD COLUMN job_payload_json TEXT").run()
  } catch (error) {
    const refreshed = await db.prepare("PRAGMA table_info(admin_jobs)").all<{ name: string }>()
    if (!(refreshed.results ?? []).some((column) => column.name === "job_payload_json")) throw error
  }
}

async function runAdminEndpointRefresh(env: WorkerEnv, config: AdminEndpointRefreshConfig, adminJobId?: string): Promise<Record<string, unknown>> {
  const db = requireDb(env)
  const userEndpoints = config.endpoints.filter((endpoint) => endpoint === "company-profile" || endpoint === "company-employees" || endpoint === "company-stock")
  const endpointStats: Record<string, { attempted: number; succeeded: number; failed: number }> = {}
  for (const endpoint of config.endpoints) endpointStats[endpoint] = { attempted: 0, succeeded: 0, failed: 0 }
  const failures: Array<{ endpoint: string; playerId?: string; companyId?: string; error: string }> = []
  const globalResults: Record<string, unknown> = {}
  let globalSuccesses = 0
  let globalFailures = 0
  let pendingGlobalRankingRunId: string | null = null
  let dispatchGlobalRankingRun = false

  for (const endpoint of config.endpoints.filter((item) => item === "global-company-rankings" || item === "faction-directory")) {
    try {
      if (endpoint === "global-company-rankings") {
        // Rankings are collected from type-specific company lists in queue-sized page batches.
        // The official /company/snapshot endpoint remains verification-only.
        if (env.GLOBAL_RANKINGS_QUEUE) {
          const started = await startGlobalRankingRefresh(env, "admin", adminJobId, true)
          pendingGlobalRankingRunId = started.runId
          dispatchGlobalRankingRun = started.dispatchRequired
          globalResults[endpoint] = { message: "Global company rankings refresh is queued and will publish only after all company-type pages validate.", refreshRunId: started.runId, pending: true }
        } else {
          await db.prepare("CREATE TABLE IF NOT EXISTS global_rankings_cache (cache_id INTEGER PRIMARY KEY CHECK (cache_id = 1), companies_json TEXT NOT NULL, fetched_at TEXT NOT NULL)").run()
          const before = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ fetchedAt: string }>()
          await refreshGlobalRankingCache(env, undefined, true)
          const after = await db.prepare("SELECT fetched_at AS fetchedAt FROM global_rankings_cache WHERE cache_id = 1").first<{ fetchedAt: string }>()
          if (!after?.fetchedAt || after.fetchedAt === before?.fetchedAt) {
            throw new Error("Global company ranking refresh did not write a new cache snapshot. Another refresh may still hold the refresh lock.")
          }
          globalResults[endpoint] = { message: "Shared rankings cache refreshed from type-specific company lists.", fetchedAt: after.fetchedAt }
        }
      } else {
        const row = await db.prepare("SELECT player_id, ciphertext, iv FROM api_keys ORDER BY updated_at DESC LIMIT 1").first<{ player_id: string; ciphertext: string; iv: string }>()
        if (!row) throw new Error("No saved Torn API key is available for the faction-directory refresh.")
        const apiKey = await decryptKey(env, row.ciphertext, row.iv)
        globalResults[endpoint] = await syncFactionDirectorDirectory(env, apiKey, 35, true)
      }
      endpointStats[endpoint].attempted += 1
      endpointStats[endpoint].succeeded += 1
      globalSuccesses += 1
    } catch (error) {
      endpointStats[endpoint].attempted += 1
      endpointStats[endpoint].failed += 1
      globalFailures += 1
      failures.push({ endpoint, error: error instanceof Error ? error.message.slice(0, 180) : "Refresh failed." })
    }
  }

  const targetIds = config.scope === "selected" ? config.targetPlayerIds : []
  let keyQuery
  if (config.scope === "selected") {
    if (!targetIds.length && userEndpoints.length) throw new Error("Select at least one dashboard user for a selected-user refresh.")
    if (targetIds.length) {
      const placeholders = targetIds.map(() => "?").join(",")
      keyQuery = db.prepare("SELECT player_id, company_id, ciphertext, iv, company_name, company_type FROM company_api_keys WHERE player_id IN (" + placeholders + ") ORDER BY player_id, company_id").bind(...targetIds)
    } else {
      keyQuery = db.prepare("SELECT player_id, company_id, ciphertext, iv, company_name, company_type FROM company_api_keys WHERE 1 = 0")
    }
  } else {
    keyQuery = db.prepare("SELECT player_id, company_id, ciphertext, iv, company_name, company_type FROM company_api_keys ORDER BY player_id, company_id")
  }
  const keyRows = await keyQuery.all<{ player_id: string; company_id: string; ciphertext: string; iv: string; company_name: string | null; company_type: string | null }>()
  const connections = keyRows.results ?? []
  const usersWithConnections = new Set(connections.map((row) => row.player_id))
  const selectedWithoutConnection = config.scope === "selected" ? targetIds.filter((id) => !usersWithConnections.has(id)).length : 0

  for (const keyRow of connections) {
    let client: TornApiClient | null = null
    try {
      const apiKey = await decryptKey(env, keyRow.ciphertext, keyRow.iv)
      client = new TornApiClient({ apiKey })
    } catch (error) {
      for (const endpoint of userEndpoints) {
        endpointStats[endpoint].attempted += 1
        endpointStats[endpoint].failed += 1
        failures.push({ endpoint, playerId: keyRow.player_id, companyId: keyRow.company_id, error: error instanceof Error ? error.message.slice(0, 180) : "Saved credential could not be read." })
      }
      continue
    }

    const existing = await db.prepare("SELECT company_name, company_type, profile_json, employees_json FROM companies WHERE player_id = ? AND company_id = ?")
      .bind(keyRow.player_id, keyRow.company_id)
      .first<{ company_name: string; company_type: string | null; profile_json: string; employees_json: string }>()
    let nextProfileJson = existing?.profile_json ?? "{}"
    let nextEmployeesJson = existing?.employees_json ?? "{}"
    let nextCompanyName = existing?.company_name || keyRow.company_name || ("Company #" + keyRow.company_id)
    let nextCompanyType: string | null = existing?.company_type ?? keyRow.company_type ?? null
    let liveProfileUpdated = false
    let liveEmployeesUpdated = false
    let liveStock: unknown = undefined

    for (const endpoint of userEndpoints) {
      endpointStats[endpoint].attempted += 1
      try {
        if (!client) throw new Error("A saved company credential is unavailable.")
        if (endpoint === "company-profile") {
          const profile = await client.getCompanyProfile()
          const returnedId = companyIdFromPayload(profile)
          if (!returnedId || String(returnedId) !== keyRow.company_id) {
            throw new Error("The saved company key returned a different or invalid company ID; no profile data was changed.")
          }
          const root = companyProfileRoot(profile)
          const type = isRecord(root.type) ? root.type : {}
          nextProfileJson = asJson(profile)
          nextCompanyName = typeof root.name === "string" && root.name.trim() ? root.name : nextCompanyName
          nextCompanyType = typeof type.name === "string" ? type.name : nextCompanyType
          liveProfileUpdated = true
        } else if (endpoint === "company-employees") {
          nextEmployeesJson = asJson(await client.getCompanyEmployees())
          liveEmployeesUpdated = true
        } else if (endpoint === "company-stock") {
          liveStock = await client.getCompanyStock()
        }
        endpointStats[endpoint].succeeded += 1
      } catch (error) {
        endpointStats[endpoint].failed += 1
        failures.push({ endpoint, playerId: keyRow.player_id, companyId: keyRow.company_id, error: error instanceof Error ? error.message.slice(0, 180) : "Endpoint refresh failed." })
      }
    }

    const fetchedAt = new Date().toISOString()
    if (liveProfileUpdated || liveEmployeesUpdated) {
      await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at")
        .bind(keyRow.player_id, keyRow.company_id, nextCompanyName, nextCompanyType, nextProfileJson, nextEmployeesJson, fetchedAt).run()
    }
    if (liveStock !== undefined) {
      await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at")
        .bind(keyRow.player_id, keyRow.company_id, asJson(liveStock), fetchedAt).run()
    }
    // Never append immutable history from these on-demand live refresh jobs.
  }

  const attemptedCalls = Object.values(endpointStats).reduce((sum, stats) => sum + stats.attempted, 0)
  const succeededCalls = Object.values(endpointStats).reduce((sum, stats) => sum + stats.succeeded, 0)
  const failedCalls = Object.values(endpointStats).reduce((sum, stats) => sum + stats.failed, 0)
  if (attemptedCalls === 0 || succeededCalls === 0 && failedCalls > 0) {
    const reason = connections.length === 0 && userEndpoints.length
      ? "No saved company API connections matched this user scope."
      : "Every selected refresh endpoint failed."
    throw new Error((reason + " " + failures.slice(0, 3).map((failure) => failure.endpoint + ": " + failure.error).join(" ")).slice(0, 220))
  }
  return {
    scope: config.scope,
    selectedUsers: config.scope === "selected" ? targetIds.length : null,
    companyConnectionsFound: connections.length,
    selectedUsersWithoutCompanyKey: selectedWithoutConnection,
    endpoints: endpointStats,
    successfulEndpointCalls: succeededCalls,
    failedEndpointCalls: failedCalls,
    globalResults,
    failures: failures.slice(0, 30),
    partialFailure: failedCalls > 0 || globalFailures > 0 || (userEndpoints.length > 0 && connections.length === 0) || selectedWithoutConnection > 0,
    globalSuccesses,
    ...(pendingGlobalRankingRunId ? { pendingGlobalRankingRunId, dispatchGlobalRankingRun } : {}),
  }
}

async function runAdminJob(env: WorkerEnv, jobId: string): Promise<void> {
  const db = requireDb(env)
  const job = await db.prepare("SELECT job_type, target_player_id, target_company_id, job_payload_json FROM admin_jobs WHERE job_id = ?").bind(jobId).first<{ job_type: string; target_player_id: string | null; target_company_id: string | null; job_payload_json: string | null }>()
  if (!job) return
  const started = new Date().toISOString()
  await db.prepare("UPDATE admin_jobs SET status = 'running', started_at = ? WHERE job_id = ? AND status = 'queued'").bind(started, jobId).run()
  try {
    let result: Record<string, unknown>
    if (job.job_type === "company-refresh") {
      if (!job.target_player_id || !job.target_company_id) throw new Error("Refresh job is missing its company target.")
      let apiKey = await savedCompanyApiKey(env, job.target_player_id, job.target_company_id)
      if (!apiKey) apiKey = await savedCompanyKey(env, job.target_player_id)
      if (!apiKey) apiKey = await savedKey(env, job.target_player_id)
      if (!apiKey) throw new Error("No saved credential is available for this company.")
      const validated = await validateCompanyKey(apiKey)
      if (String(validated.companyId) !== job.target_company_id) throw new Error("The saved credential returned a different company ID. No data was changed.")
      await persistCompanyConnection(env, job.target_player_id, apiKey, validated, false)
      const root = companyProfileRoot(validated.profile)
      result = { companyId: String(validated.companyId), companyName: typeof root.name === "string" ? root.name : `Company #${validated.companyId}` }
    } else if (job.job_type === "global-refresh") {
      const rankings = await refreshRankingProfiles(env, false)
      await refreshFactionDirectoryFromAnyKey(env, 35, true)
      result = { ...rankings, message: "Live company ranking profiles and a forced faction-directory batch refreshed without adding historical snapshots. Global company rankings remain sourced from the dedicated endpoint refresh; the official /company/snapshot endpoint is verification-only." }
    } else if (job.job_type === "endpoint-refresh") {
      const rawConfig = parseStoredJson(job.job_payload_json)
      if (!isRecord(rawConfig) || !Array.isArray(rawConfig.endpoints) || (rawConfig.scope !== "all" && rawConfig.scope !== "selected")) {
        throw new Error("Endpoint refresh job is missing a valid saved configuration.")
      }
      const endpoints = Array.from(new Set(rawConfig.endpoints.filter((item): item is AdminRefreshEndpoint => typeof item === "string" && ADMIN_REFRESH_ENDPOINTS.includes(item as AdminRefreshEndpoint))))
      if (!endpoints.length) throw new Error("Endpoint refresh job has no supported endpoints.")
      const targetPlayerIds = Array.isArray(rawConfig.targetPlayerIds)
        ? Array.from(new Set(rawConfig.targetPlayerIds.filter((item): item is string => typeof item === "string" && /^\d+$/.test(item))))
        : []
      result = await runAdminEndpointRefresh(env, { endpoints, scope: rawConfig.scope, targetPlayerIds }, jobId)
      if (typeof result.pendingGlobalRankingRunId === "string") {
        await db.prepare("UPDATE admin_jobs SET status = 'running', result_json = ?, error_message = NULL WHERE job_id = ?")
          .bind(asJson(result), jobId).run()
        if (result.dispatchGlobalRankingRun === true) {
          try { await env.GLOBAL_RANKINGS_QUEUE?.send({ runId: result.pendingGlobalRankingRunId }) }
          catch (dispatchError) {
            await markGlobalRankingRunFailed(env, result.pendingGlobalRankingRunId, dispatchError)
            return
          }
        }
        return
      }
    } else {
      throw new Error("Unsupported administrative job type.")
    }
    await db.prepare("UPDATE admin_jobs SET status = 'completed', finished_at = ?, result_json = ?, error_message = NULL WHERE job_id = ?").bind(new Date().toISOString(), asJson(result), jobId).run()
    const actor: Session = { player_id: "351311", player_name: "SharpSplinter", is_admin: 1 }
    await writeAdminAudit(env, actor, "job.completed", "job", jobId, "succeeded", `Administrative job ${job.job_type} completed.`, { jobType: job.job_type, targetPlayerId: job.target_player_id, targetCompanyId: job.target_company_id })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 220) : "The operation failed unexpectedly."
    await db.prepare("UPDATE admin_jobs SET status = 'failed', finished_at = ?, error_message = ? WHERE job_id = ?").bind(new Date().toISOString(), message, jobId).run()
    const actor: Session = { player_id: "351311", player_name: "SharpSplinter", is_admin: 1 }
    await writeAdminAudit(env, actor, "job.failed", "job", jobId, "failed", `Administrative job ${job.job_type} failed.`, { jobType: job.job_type, targetPlayerId: job.target_player_id, targetCompanyId: job.target_company_id, error: message })
  }
}

async function adminBackupForPlayer(env: WorkerEnv, playerId: string): Promise<Record<string, unknown>> {
  const db = requireDb(env)
  await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
  await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
  const player = await db.prepare("SELECT player_id, player_name FROM players WHERE player_id = ?").bind(playerId).first<{ player_id: string; player_name: string }>()
  if (!player) throw new Error("That dashboard member does not exist.")
  const [companyRows, financialRows, snapshots, directorSnapshots, pageRows, sharingRows] = await Promise.all([
    db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC").bind(playerId).all<Record<string, unknown>>(),
    db.prepare("SELECT company_id AS companyId, stock_json AS stockJson, fetched_at AS fetchedAt FROM company_financials WHERE player_id = ? ORDER BY fetched_at DESC").bind(playerId).all<Record<string, unknown>>(),
    db.prepare("SELECT company_id AS companyId, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt FROM company_snapshots WHERE player_id = ? ORDER BY fetched_at ASC").bind(playerId).all<Record<string, unknown>>(),
    db.prepare("SELECT company_id AS companyId, snapshot_day AS snapshotDay, profile_json AS profileJson, stock_json AS stockJson, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? ORDER BY snapshot_day ASC").bind(playerId).all<Record<string, unknown>>(),
    db.prepare("SELECT page_key AS pageKey, data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ?").bind(playerId).all<Record<string, unknown>>(),
    db.prepare("SELECT recipient_player_id AS recipientId, share_financial_data AS shareFinancialData, share_employee_data AS shareEmployeeData, share_trend_data AS shareTrendData, updated_at AS updatedAt FROM company_sharing_recipients WHERE owner_player_id = ? ORDER BY recipient_player_id").bind(playerId).all<Record<string, unknown>>(),
  ])
  const companies = (companyRows.results ?? []).map((row) => ({ companyId: String(row.companyId), companyName: row.companyName ?? null, companyType: row.companyType ?? null, profile: parseStoredJson(row.profileJson), employees: parseStoredJson(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }))
  const financials = (financialRows.results ?? []).map((row) => ({ companyId: String(row.companyId), stock: parseStoredJson(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }))
  const companySnapshots = (snapshots.results ?? []).map((row) => ({ companyId: String(row.companyId), profile: parseStoredJson(row.profileJson), employees: parseStoredJson(row.employeesJson), fetchedAt: String(row.fetchedAt ?? "") }))
  const directorSnapshotData = (directorSnapshots.results ?? []).map((row) => ({ playerId, companyId: String(row.companyId), snapshotDay: String(row.snapshotDay), profile: parseStoredJson(row.profileJson), stock: parseStoredJson(row.stockJson), fetchedAt: String(row.fetchedAt ?? "") }))
  const pageData = (pageRows.results ?? []).map((row) => ({ pageKey: String(row.pageKey), data: parseStoredJson(row.dataJson), updatedAt: String(row.updatedAt ?? "") }))
  const sharingPreferences = (sharingRows.results ?? []).map((row) => ({ recipientId: String(row.recipientId), shareFinancialData: row.shareFinancialData === 1, shareEmployeeData: row.shareEmployeeData === 1, shareTrendData: row.shareTrendData === 1, updatedAt: String(row.updatedAt ?? "") }))
  return { format: "naughty-company-dashboard-admin-backup", version: 1, exportedAt: new Date().toISOString(), player: { id: player.player_id, name: player.player_name }, storage: { companies, financials, companySnapshots, directorSnapshots: directorSnapshotData, pageData, sharingPreferences }, excluded: ["API credentials, session tokens, and administrator settings are never exported."] }
}

function adminBackupCounts(storage: Record<string, unknown>): Record<string, number> {
  const count = (key: string) => Array.isArray(storage[key]) ? (storage[key] as unknown[]).length : 0
  return { companies: count("companies"), financials: count("financials"), companySnapshots: count("companySnapshots"), directorSnapshots: count("directorSnapshots"), pageData: count("pageData"), sharingPreferences: count("sharingPreferences") }
}

async function restoreAdminBackup(env: WorkerEnv, targetPlayerId: string, parsed: Record<string, unknown>): Promise<Record<string, number>> {
  const db = requireDb(env)
  const storage = parsed.storage as Record<string, unknown>
  await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
  await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
  const pageAllowlist = new Set(["company", "employees", "charts", "rankings", "references", "settings"])
  const counts = adminBackupCounts(storage)
  for (const item of (Array.isArray(storage.companies) ? storage.companies : []).slice(0, 100)) {
    if (!isRecord(item)) continue
    const companyId = positiveId(item.companyId ?? item.company_id)
    if (!companyId || item.profile === undefined) continue
    const existing = await db.prepare("SELECT employees_json AS employeesJson, company_name AS companyName, company_type AS companyType, fetched_at AS fetchedAt FROM companies WHERE player_id = ? AND company_id = ?").bind(targetPlayerId, companyId).first<Record<string, unknown>>()
    const profileRoot = companyProfileRoot(item.profile)
    const companyName = typeof item.companyName === "string" ? item.companyName : typeof profileRoot.name === "string" ? profileRoot.name : String(existing?.companyName ?? `Company #${companyId}`)
    const type = isRecord(profileRoot.type) ? profileRoot.type : {}
    const companyType = typeof item.companyType === "string" ? item.companyType : typeof type.name === "string" ? type.name : existing?.companyType ?? null
    const employees = item.employees !== undefined ? item.employees : existing ? parseStoredJson(existing.employeesJson) : []
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : String(existing?.fetchedAt ?? new Date().toISOString())
    await db.prepare("INSERT INTO companies (player_id, company_id, company_name, company_type, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET company_name = excluded.company_name, company_type = excluded.company_type, profile_json = excluded.profile_json, employees_json = excluded.employees_json, fetched_at = excluded.fetched_at").bind(targetPlayerId, String(companyId), companyName, companyType == null ? null : String(companyType), asJson(item.profile), asJson(employees), fetchedAt).run()
  }
  for (const item of (Array.isArray(storage.financials) ? storage.financials : []).slice(0, 100)) {
    if (!isRecord(item)) continue
    const companyId = positiveId(item.companyId)
    if (!companyId || item.stock === undefined) continue
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : new Date().toISOString()
    await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(targetPlayerId, String(companyId), asJson(item.stock), fetchedAt).run()
  }
  for (const item of (Array.isArray(storage.companySnapshots) ? storage.companySnapshots : []).slice(0, 10000)) {
    if (!isRecord(item)) continue
    const companyId = positiveId(item.companyId)
    if (!companyId || item.profile === undefined) continue
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : new Date().toISOString()
    const existing = await db.prepare("SELECT snapshot_id FROM company_snapshots WHERE player_id = ? AND company_id = ? AND fetched_at = ? LIMIT 1").bind(targetPlayerId, String(companyId), fetchedAt).first<{ snapshot_id: number }>()
    if (!existing) await db.prepare("INSERT INTO company_snapshots (player_id, company_id, profile_json, employees_json, fetched_at) VALUES (?, ?, ?, ?, ?)").bind(targetPlayerId, String(companyId), asJson(item.profile), asJson(item.employees ?? []), fetchedAt).run()
  }
  for (const item of (Array.isArray(storage.directorSnapshots) ? storage.directorSnapshots : []).slice(0, 10000)) {
    if (!isRecord(item)) continue
    const companyId = positiveId(item.companyId)
    const day = typeof item.snapshotDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.snapshotDay) ? item.snapshotDay : null
    if (!companyId || !day || item.profile === undefined) continue
    const fetchedAt = typeof item.fetchedAt === "string" && !Number.isNaN(Date.parse(item.fetchedAt)) ? item.fetchedAt : new Date().toISOString()
    await db.prepare("INSERT OR IGNORE INTO faction_director_snapshots (player_id, company_id, snapshot_day, profile_json, stock_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)").bind(targetPlayerId, String(companyId), day, asJson(item.profile), item.stock == null ? null : asJson(item.stock), fetchedAt).run()
  }
  for (const item of (Array.isArray(storage.pageData) ? storage.pageData : []).slice(0, 20)) {
    if (!isRecord(item) || typeof item.pageKey !== "string" || !pageAllowlist.has(item.pageKey)) continue
    await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(targetPlayerId, item.pageKey, asJson(item.data), new Date().toISOString()).run()
  }
  for (const item of (Array.isArray(storage.sharingPreferences) ? storage.sharingPreferences : []).slice(0, 1000)) {
    if (!isRecord(item)) continue
    const recipientId = positiveId(item.recipientId ?? item.recipient_id ?? item.playerId)
    if (!recipientId || recipientId === targetPlayerId) continue
    const recipient = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(recipientId).first<{ player_id: string }>()
    if (!recipient) continue
    await db.prepare("INSERT INTO company_sharing_recipients (owner_player_id, recipient_player_id, share_financial_data, share_employee_data, share_trend_data, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id, recipient_player_id) DO UPDATE SET share_financial_data = excluded.share_financial_data, share_employee_data = excluded.share_employee_data, share_trend_data = excluded.share_trend_data, updated_at = excluded.updated_at").bind(targetPlayerId, String(recipientId), Number(item.shareFinancialData === true || item.share_financial_data === 1), Number(item.shareEmployeeData === true || item.share_employee_data === 1), Number(item.shareTrendData === true || item.share_trend_data === 1), new Date().toISOString()).run()
  }
  return counts
}

async function handleAutomationRequest(request: Request, env: WorkerEnv, origin: string): Promise<Response | null> {
  const url = new URL(request.url)
  const rulesPath = url.pathname === "/api/me/alert-rules" || url.pathname.startsWith("/api/me/alert-rules/")
  const alertsPath = url.pathname === "/api/me/alerts" || url.pathname.startsWith("/api/me/alerts/")
  const preferencesPath = url.pathname === "/api/me/automation-preferences"
  const webhookPath = url.pathname === "/api/me/automation-webhook"
  const webhookTestPath = url.pathname === "/api/me/automation-webhook/test"
  const deliveriesPath = url.pathname === "/api/me/automation-webhook/deliveries"
  const discordLinkPath = url.pathname === "/api/me/discord-link"
  const discordPollHealthPath = url.pathname === "/api/me/discord-alert-poll-health"
  const discordLinkCodePath = url.pathname === "/api/me/discord-link-code"
  const discordRedeemPath = url.pathname === "/api/discord/link/redeem"
  const retryMatch = url.pathname.match(/^\/api\/me\/automation-webhook\/retry\/([a-f0-9-]{36})$/i)
  if (!rulesPath && !alertsPath && !preferencesPath && !webhookPath && !webhookTestPath && !deliveriesPath && !retryMatch && !discordLinkPath && !discordPollHealthPath && !discordLinkCodePath && !discordRedeemPath) return null
  if (discordRedeemPath && request.method === "POST") {
    await ensureAutomationSchema(env)
    const db = requireDb(env)
    const body: unknown = await request.json().catch(() => null)
    const code = isRecord(body) && typeof body.code === "string" ? body.code.trim().toLowerCase() : ""
    const discordUserId = isRecord(body) && typeof body.discordUserId === "string" ? body.discordUserId.trim() : ""
    if (!/^[a-f0-9]{48}$/.test(code) || !/^\d{17,20}$/.test(discordUserId)) return jsonResponse({ error: "Enter a valid dashboard link code from the dashboard." }, 400, origin)
    const now = new Date().toISOString()
    const row = await db.prepare("SELECT owner_player_id AS ownerPlayerId, ciphertext, iv, expires_at AS expiresAt, used_at AS usedAt FROM discord_link_codes WHERE code = ?").bind(code).first<{ ownerPlayerId: string; ciphertext: string; iv: string; expiresAt: string; usedAt: string | null }>()
    if (!row || row.usedAt || row.expiresAt <= now) return jsonResponse({ error: "That dashboard link code has expired or was already used. Generate a new code in the dashboard." }, 400, origin)
    const otherOwner = await db.prepare("SELECT owner_player_id AS ownerPlayerId FROM discord_account_links WHERE discord_user_id = ? AND owner_player_id <> ?").bind(discordUserId, row.ownerPlayerId).first<{ ownerPlayerId: string }>()
    if (otherOwner) return jsonResponse({ error: "That Discord account is already linked to another dashboard account." }, 409, origin)
    const consumed = await db.prepare("UPDATE discord_link_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?").bind(now, code, now).run()
    if (!(consumed.meta?.changes ?? 0)) return jsonResponse({ error: "That dashboard link code has already been used. Generate a new code in the dashboard." }, 409, origin)
    try {
      const token = await decryptKey(env, row.ciphertext, row.iv)
      await db.prepare("DELETE FROM discord_alert_poll_health WHERE owner_player_id = ?").bind(row.ownerPlayerId).run()
      await db.prepare("DELETE FROM discord_alert_poll_history WHERE owner_player_id = ?").bind(row.ownerPlayerId).run()
      await db.prepare("INSERT INTO discord_account_links (owner_player_id, discord_user_id, alerts_enabled, linked_at, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(owner_player_id) DO UPDATE SET discord_user_id = excluded.discord_user_id, linked_at = excluded.linked_at, updated_at = excluded.updated_at").bind(row.ownerPlayerId, discordUserId, now, now).run()
      return jsonResponse({ token, playerId: row.ownerPlayerId }, 200, origin)
    } catch { return jsonResponse({ error: "The dashboard link could not be completed. Generate a new code and try again." }, 503, origin) }
  }
  const session = await authenticate(request, env)
  if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
  // These high-frequency Discord poll endpoints use schemas provisioned by auth migrations.
  // Avoid serial CREATE TABLE/INDEX work on cold Worker isolates for every minute-level poll.
  const skipAutomationSchemaBootstrap =
    (discordLinkPath && request.method === "GET") ||
    (preferencesPath && request.method === "GET") ||
    discordPollHealthPath
  if (!skipAutomationSchemaBootstrap) await ensureAutomationSchema(env)
  const db = requireDb(env)
  if (discordLinkPath && request.method === "GET") {
    const row = await db.prepare("SELECT discord_user_id AS discordUserId, alerts_enabled AS alertsEnabled, linked_at AS linkedAt FROM discord_account_links WHERE owner_player_id = ?").bind(session.player_id).first<{ discordUserId: string; alertsEnabled: number; linkedAt: string }>()
    return jsonResponse({ linked: Boolean(row), alertsEnabled: Boolean(row?.alertsEnabled), linkedAt: row?.linkedAt ?? null }, 200, origin)
  }
  if (discordPollHealthPath && request.method === "GET") {
    const link = await db.prepare("SELECT discord_user_id AS discordUserId, alerts_enabled AS alertsEnabled FROM discord_account_links WHERE owner_player_id = ?").bind(session.player_id).first<{ discordUserId: string; alertsEnabled: number }>()
    if (!link) return jsonResponse({ linked: false, alertsEnabled: false, health: null, history: [] }, 200, origin)
    const [health, history] = await Promise.all([
      db.prepare("SELECT poll_started_at AS pollStartedAt,poll_completed_at AS pollCompletedAt,last_success_at AS lastSuccessAt,status,error_code AS errorCode,error_at AS errorAt,consecutive_failures AS consecutiveFailures,page_count AS pageCount,events_seen AS eventsSeen,delivered,filtered,failed,exhausted,stale_recovered AS staleRecovered,exhausted_deliveries AS exhaustedDeliveries,stale_claims AS staleClaims,updated_at AS updatedAt FROM discord_alert_poll_health WHERE owner_player_id = ? AND discord_user_id = ?").bind(session.player_id, link.discordUserId).first<Record<string, unknown>>(),
      db.prepare("SELECT poll_completed_at AS pollCompletedAt,status,error_code AS errorCode,consecutive_failures AS consecutiveFailures,events_seen AS eventsSeen,delivered,failed,exhausted_deliveries AS exhaustedDeliveries,stale_claims AS staleClaims FROM discord_alert_poll_history WHERE owner_player_id = ? AND discord_user_id = ? ORDER BY poll_completed_at DESC LIMIT 12").bind(session.player_id, link.discordUserId).all<Record<string, unknown>>()
    ])
    return jsonResponse({ linked: true, alertsEnabled: Boolean(link.alertsEnabled), health: health ?? null, history: history.results ?? [] }, 200, origin)
  }
  if (discordPollHealthPath && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body)) return jsonResponse({ error: "Provide private alert poll metrics." }, 400, origin)
    const discordUserId = typeof body.discordUserId === "string" ? body.discordUserId.trim() : ""
    const status = typeof body.status === "string" ? body.status : ""
    const allowedStatuses = ["healthy", "partial", "error", "quiet_hours", "disabled", "initialized"]
    if (!/^\d{17,20}$/.test(discordUserId) || !allowedStatuses.includes(status)) return jsonResponse({ error: "Invalid private alert poll metrics." }, 400, origin)
    const linked = await db.prepare("SELECT discord_user_id AS discordUserId FROM discord_account_links WHERE owner_player_id = ?").bind(session.player_id).first<{ discordUserId: string }>()
    if (!linked) return jsonResponse({ error: "Link a Discord account before reporting private alert poll status." }, 409, origin)
    if (linked.discordUserId !== discordUserId) return jsonResponse({ error: "Poll metrics do not match the linked Discord account." }, 403, origin)
    const isoValue = (value: unknown, fallback: string) => {
      if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return fallback
      return new Date(value).toISOString()
    }
    const countValue = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(1000000, Math.floor(value)) : 0
    const completedAt = isoValue(body.completedAt, new Date().toISOString())
    const startedAt = body.startedAt == null ? null : isoValue(body.startedAt, completedAt)
    const safeCode = typeof body.errorCode === "string" && /^[a-z0-9_]+(?:_http_[1-5][0-9]{2})?$/i.test(body.errorCode) ? body.errorCode.slice(0, 80) : null
    const metrics = {
      pages: countValue(body.pages), eventsSeen: countValue(body.eventsSeen), delivered: countValue(body.delivered),
      filtered: countValue(body.filtered), failed: countValue(body.failed), exhausted: countValue(body.exhausted),
      staleRecovered: countValue(body.staleRecovered), exhaustedDeliveries: countValue(body.exhaustedDeliveries),
      staleClaims: countValue(body.staleClaims)
    }
    const prior = await db.prepare("SELECT status,consecutive_failures AS consecutiveFailures,last_success_at AS lastSuccessAt FROM discord_alert_poll_health WHERE owner_player_id = ? AND discord_user_id = ?").bind(session.player_id, discordUserId).first<{ status: string; consecutiveFailures: number; lastSuccessAt: string | null }>()
    const consecutiveFailures = status === "error" ? (prior?.status === "error" ? Number(prior.consecutiveFailures || 0) + 1 : 1) : 0
    const lastSuccessAt = ["healthy", "partial", "quiet_hours", "disabled", "initialized"].includes(status) ? completedAt : prior?.lastSuccessAt ?? null
    const errorCode = safeCode || (status === "partial" && metrics.failed > 0 ? "discord_dm_delivery_failed" : null)
    const errorAt = errorCode ? completedAt : null
    const reportId = crypto.randomUUID()
    await db.prepare("INSERT INTO discord_alert_poll_health (owner_player_id,discord_user_id,poll_started_at,poll_completed_at,last_success_at,status,error_code,error_at,consecutive_failures,page_count,events_seen,delivered,filtered,failed,exhausted,stale_recovered,exhausted_deliveries,stale_claims,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_player_id) DO UPDATE SET discord_user_id=excluded.discord_user_id,poll_started_at=excluded.poll_started_at,poll_completed_at=excluded.poll_completed_at,last_success_at=excluded.last_success_at,status=excluded.status,error_code=excluded.error_code,error_at=excluded.error_at,consecutive_failures=excluded.consecutive_failures,page_count=excluded.page_count,events_seen=excluded.events_seen,delivered=excluded.delivered,filtered=excluded.filtered,failed=excluded.failed,exhausted=excluded.exhausted,stale_recovered=excluded.stale_recovered,exhausted_deliveries=excluded.exhausted_deliveries,stale_claims=excluded.stale_claims,updated_at=excluded.updated_at")
      .bind(session.player_id, discordUserId, startedAt, completedAt, lastSuccessAt, status, errorCode, errorAt, consecutiveFailures, metrics.pages, metrics.eventsSeen, metrics.delivered, metrics.filtered, metrics.failed, metrics.exhausted, metrics.staleRecovered, metrics.exhaustedDeliveries, metrics.staleClaims, completedAt).run()
    await db.prepare("INSERT INTO discord_alert_poll_history (report_id,owner_player_id,discord_user_id,poll_started_at,poll_completed_at,status,error_code,consecutive_failures,page_count,events_seen,delivered,filtered,failed,exhausted,stale_recovered,exhausted_deliveries,stale_claims) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(reportId, session.player_id, discordUserId, startedAt, completedAt, status, errorCode, consecutiveFailures, metrics.pages, metrics.eventsSeen, metrics.delivered, metrics.filtered, metrics.failed, metrics.exhausted, metrics.staleRecovered, metrics.exhaustedDeliveries, metrics.staleClaims).run()
    await db.prepare("DELETE FROM discord_alert_poll_history WHERE owner_player_id = ? AND discord_user_id = ? AND report_id NOT IN (SELECT report_id FROM discord_alert_poll_history WHERE owner_player_id = ? AND discord_user_id = ? ORDER BY poll_completed_at DESC LIMIT 50)")
      .bind(session.player_id, discordUserId, session.player_id, discordUserId).run()
    return jsonResponse({ recorded: true, status, consecutiveFailures }, 200, origin)
  }
  if (discordLinkPath && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body)) return jsonResponse({ error: "Provide Discord link settings." }, 400, origin)
    const existing = await db.prepare("SELECT discord_user_id AS discordUserId FROM discord_account_links WHERE owner_player_id = ?").bind(session.player_id).first<{ discordUserId: string }>()
    if (typeof body.alertsEnabled === "boolean") {
      if (!existing) return jsonResponse({ error: "Link your Discord account before enabling private alerts." }, 409, origin)
      await db.prepare("UPDATE discord_account_links SET alerts_enabled = ?, updated_at = ? WHERE owner_player_id = ?").bind(Number(body.alertsEnabled), new Date().toISOString(), session.player_id).run()
      return jsonResponse({ linked: true, alertsEnabled: body.alertsEnabled }, 200, origin)
    }
    const discordUserId = typeof body.discordUserId === "string" ? body.discordUserId.trim() : ""
    if (!/^\d{17,20}$/.test(discordUserId)) return jsonResponse({ error: "A valid Discord user ID is required." }, 400, origin)
    const otherOwner = await db.prepare("SELECT owner_player_id AS ownerPlayerId FROM discord_account_links WHERE discord_user_id = ? AND owner_player_id <> ?").bind(discordUserId, session.player_id).first<{ ownerPlayerId: string }>()
    if (otherOwner) return jsonResponse({ error: "That Discord account is already linked to another dashboard account." }, 409, origin)
    const now = new Date().toISOString()
    await db.prepare("DELETE FROM discord_alert_poll_health WHERE owner_player_id = ?").bind(session.player_id).run()
    await db.prepare("DELETE FROM discord_alert_poll_history WHERE owner_player_id = ?").bind(session.player_id).run()
    await db.prepare("INSERT INTO discord_account_links (owner_player_id, discord_user_id, alerts_enabled, linked_at, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(owner_player_id) DO UPDATE SET discord_user_id = excluded.discord_user_id, linked_at = excluded.linked_at, updated_at = excluded.updated_at").bind(session.player_id, discordUserId, now, now).run()
    return jsonResponse({ linked: true, alertsEnabled: false, linkedAt: now }, 200, origin)
  }
  if (discordLinkPath && request.method === "DELETE") {
    await db.prepare("DELETE FROM discord_account_links WHERE owner_player_id = ?").bind(session.player_id).run()
    await db.prepare("DELETE FROM discord_link_codes WHERE owner_player_id = ?").bind(session.player_id).run()
    await db.prepare("DELETE FROM discord_alert_poll_health WHERE owner_player_id = ?").bind(session.player_id).run()
    await db.prepare("DELETE FROM discord_alert_poll_history WHERE owner_player_id = ?").bind(session.player_id).run()
    return jsonResponse({ linked: false, alertsEnabled: false }, 200, origin)
  }
  if (discordLinkCodePath && request.method === "POST") {
    const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (!token) return jsonResponse({ error: "Sign in again before generating a Discord link code." }, 401, origin)
    const bytes = crypto.getRandomValues(new Uint8Array(24))
    const code = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")
    let encrypted: { ciphertext: string; iv: string }
    try { encrypted = await encryptKey(env, token) } catch { return jsonResponse({ error: "Secure link-code storage is not configured." }, 503, origin) }
    const now = new Date(), expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
    await db.prepare("DELETE FROM discord_link_codes WHERE expires_at <= ? OR used_at IS NOT NULL").bind(now.toISOString()).run()
    await db.prepare("INSERT INTO discord_link_codes (code, owner_player_id, ciphertext, iv, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)").bind(code, session.player_id, encrypted.ciphertext, encrypted.iv, expiresAt).run()
    return jsonResponse({ code, expiresAt, expiresInSeconds: 300 }, 200, origin)
  }
  if (preferencesPath && request.method === "GET") {
    const now = new Date().toISOString()
    await db.prepare("INSERT OR IGNORE INTO automation_preferences (owner_player_id, updated_at) VALUES (?, ?)").bind(session.player_id, now).run()
    const preferences = await db.prepare("SELECT browser_notifications_enabled AS browserNotificationsEnabled, quiet_hours_enabled AS quietHoursEnabled, quiet_hours_start AS quietHoursStart, quiet_hours_end AS quietHoursEnd, timezone, minimum_severity AS minimumSeverity, digest_mode AS digestMode, updated_at AS updatedAt FROM automation_preferences WHERE owner_player_id = ?").bind(session.player_id).first<Record<string, unknown>>()
    return jsonResponse({ preferences: preferences ?? { browserNotificationsEnabled: 0, quietHoursEnabled: 0, quietHoursStart: "22:00", quietHoursEnd: "08:00", timezone: "UTC", minimumSeverity: "info", digestMode: "instant" } }, 200, origin)
  }
  if (webhookPath && request.method === "GET") {
    const row = await db.prepare("SELECT enabled, created_at AS createdAt, updated_at AS updatedAt, last_delivered_at AS lastDeliveredAt, last_error AS lastError FROM automation_webhooks WHERE owner_player_id = ?").bind(session.player_id).first<Record<string, unknown>>()
    return jsonResponse({ configured: Boolean(row), webhook: row ? { enabled: Boolean(row.enabled), createdAt: row.createdAt, updatedAt: row.updatedAt, lastDeliveredAt: row.lastDeliveredAt, lastError: row.lastError } : null }, 200, origin)
  }
  if (webhookPath && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    const endpoint = isRecord(body) ? validateWebhookUrl(body.url) : null
    if (!endpoint) return jsonResponse({ error: "Use a public HTTPS webhook URL without credentials, local hostnames, or private IP addresses." }, 400, origin)
    let encrypted: { ciphertext: string; iv: string }
    try { encrypted = await encryptKey(env, endpoint) } catch { return jsonResponse({ error: "Webhook encryption is not configured on this Worker." }, 503, origin) }
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO automation_webhooks (owner_player_id, ciphertext, iv, enabled, created_at, updated_at, last_delivered_at, last_error) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL) ON CONFLICT(owner_player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, enabled = 1, updated_at = excluded.updated_at, last_error = NULL").bind(session.player_id, encrypted.ciphertext, encrypted.iv, now, now).run()
    return jsonResponse({ configured: true, saved: true, updatedAt: now }, 200, origin)
  }
  if (webhookTestPath && request.method === "POST") {
    const body: unknown = await request.json().catch(() => ({}))
    const requestedKind = isRecord(body) ? body.kind : undefined
    const kind: "connection" | "alert" | "summary" = requestedKind === "alert" || requestedKind === "summary" ? requestedKind : "connection"
    const result = await sendWebhookTest(env, session.player_id, kind)
    return jsonResponse({ delivery: result }, 200, origin)
  }
  if (webhookPath && request.method === "DELETE") {
    await db.prepare("DELETE FROM automation_webhooks WHERE owner_player_id = ?").bind(session.player_id).run()
    return jsonResponse({ configured: false, deleted: true }, 200, origin)
  }
  if (deliveriesPath && request.method === "GET") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 20) || 20))
    const rows = await db.prepare("SELECT delivery_id AS deliveryId, event_id AS eventId, status, status_code AS statusCode, detail, created_at AS createdAt, delivered_at AS deliveredAt FROM automation_delivery_log WHERE owner_player_id = ? ORDER BY created_at DESC LIMIT ?").bind(session.player_id, limit).all<Record<string, unknown>>()
    return jsonResponse({ deliveries: rows.results ?? [] }, 200, origin)
  }
  if (retryMatch && request.method === "POST") {
    const event = await db.prepare("SELECT event_id AS eventId, rule_id AS ruleId, rule_type AS ruleType, severity, title, message, company_id AS companyId, created_at AS createdAt FROM alert_events WHERE event_id = ? AND owner_player_id = ?").bind(retryMatch[1], session.player_id).first<WebhookAlert>()
    if (!event) return jsonResponse({ error: "Alert not found." }, 404, origin)
    const result = await deliverAutomationWebhook(env, session.player_id, event)
    return jsonResponse({ delivery: result }, result.attempted && !result.delivered ? 502 : 200, origin)
  }
  if (preferencesPath && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body)) return jsonResponse({ error: "Provide automation notification preferences." }, 400, origin)
    const existing = await db.prepare("SELECT * FROM automation_preferences WHERE owner_player_id = ?").bind(session.player_id).first<Record<string, unknown>>()
    const validTime = (value: unknown, fallback: string) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback
    const validZone = (value: unknown, fallback: string) => { if (typeof value !== "string" || value.length > 80) return fallback; try { new Intl.DateTimeFormat("en", { timeZone: value }); return value } catch { return fallback } }
    const severity = ["info", "warning", "critical"].includes(String(body.minimumSeverity)) ? String(body.minimumSeverity) : String(existing?.minimum_severity ?? "info")
    const digest = ["instant", "daily", "both", "off"].includes(String(body.digestMode)) ? String(body.digestMode) : String(existing?.digest_mode ?? "instant")
    const prefs = { browserNotificationsEnabled: Number(typeof body.browserNotificationsEnabled === "boolean" ? body.browserNotificationsEnabled : Boolean(existing?.browser_notifications_enabled)), quietHoursEnabled: Number(typeof body.quietHoursEnabled === "boolean" ? body.quietHoursEnabled : Boolean(existing?.quiet_hours_enabled)), quietHoursStart: validTime(body.quietHoursStart, String(existing?.quiet_hours_start ?? "22:00")), quietHoursEnd: validTime(body.quietHoursEnd, String(existing?.quiet_hours_end ?? "08:00")), timezone: validZone(body.timezone, String(existing?.timezone ?? "UTC")), minimumSeverity: severity, digestMode: digest }
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO automation_preferences (owner_player_id, browser_notifications_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone, minimum_severity, digest_mode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_player_id) DO UPDATE SET browser_notifications_enabled = excluded.browser_notifications_enabled, quiet_hours_enabled = excluded.quiet_hours_enabled, quiet_hours_start = excluded.quiet_hours_start, quiet_hours_end = excluded.quiet_hours_end, timezone = excluded.timezone, minimum_severity = excluded.minimum_severity, digest_mode = excluded.digest_mode, updated_at = excluded.updated_at").bind(session.player_id, prefs.browserNotificationsEnabled, prefs.quietHoursEnabled, prefs.quietHoursStart, prefs.quietHoursEnd, prefs.timezone, prefs.minimumSeverity, prefs.digestMode, now).run()
    return jsonResponse({ preferences: { ...prefs, updatedAt: now }, saved: true }, 200, origin)
  }
  if (url.pathname === "/api/me/alert-rules" && request.method === "GET") {
    const rows = await db.prepare("SELECT r.rule_id AS ruleId, r.company_id AS companyId, r.rule_type AS ruleType, r.enabled AS enabled, r.threshold_percent AS thresholdPercent, r.cooldown_hours AS cooldownHours, r.stale_after_hours AS staleAfterHours, r.last_triggered_at AS lastTriggeredAt, r.last_evaluated_at AS lastEvaluatedAt, r.created_at AS createdAt, c.company_name AS companyName FROM alert_rules r LEFT JOIN companies c ON c.player_id = r.owner_player_id AND c.company_id = r.company_id WHERE r.owner_player_id = ? ORDER BY r.created_at DESC LIMIT 100").bind(session.player_id).all<Record<string, unknown>>()
    return jsonResponse({ rules: rows.results ?? [] }, 200, origin)
  }
  if (url.pathname === "/api/me/alert-rules" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    const type = isRecord(body) && typeof body.ruleType === "string" ? body.ruleType : ""
    if (!["income_drop", "stale_data", "refresh_failure", "income_increase", "rating_drop", "roster_change"].includes(type)) return jsonResponse({ error: "Choose a supported alert type." }, 400, origin)
    const rawCompanyId = isRecord(body) ? body.companyId : null
    const companyId = rawCompanyId == null || rawCompanyId === "" ? null : positiveId(rawCompanyId)
    if (rawCompanyId != null && rawCompanyId !== "" && !companyId) return jsonResponse({ error: "Choose a valid company." }, 400, origin)
    if (companyId) {
      const owned = await db.prepare("SELECT company_id FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first<{ company_id: string }>()
      if (!owned) return jsonResponse({ error: "That company is not connected to your account." }, 403, origin)
    }
    const ruleId = crypto.randomUUID()
    const now = new Date().toISOString()
    const threshold = normalizeAlertThreshold(isRecord(body) ? body.thresholdPercent : undefined)
    const cooldown = normalizeCooldownHours(isRecord(body) ? body.cooldownHours : undefined)
    const staleAfter = normalizeCooldownHours(isRecord(body) ? body.staleAfterHours : undefined, 30)
    await db.prepare("INSERT INTO alert_rules (rule_id, owner_player_id, company_id, rule_type, enabled, threshold_percent, cooldown_hours, stale_after_hours, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)").bind(ruleId, session.player_id, companyId, type, threshold, cooldown, staleAfter, now, now).run()
    return jsonResponse({ ruleId, created: true }, 201, origin)
  }
  const ruleMatch = url.pathname.match(/^\/api\/me\/alert-rules\/([a-f0-9-]{36})$/i)
  if (ruleMatch && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    const rule = await db.prepare("SELECT * FROM alert_rules WHERE rule_id = ? AND owner_player_id = ?").bind(ruleMatch[1], session.player_id).first<AlertRuleRow>()
    if (!rule) return jsonResponse({ error: "Alert rule not found." }, 404, origin)
    const enabled = isRecord(body) && typeof body.enabled === "boolean" ? Number(body.enabled) : rule.enabled
    const threshold = isRecord(body) && body.thresholdPercent !== undefined ? normalizeAlertThreshold(body.thresholdPercent) : rule.threshold_percent
    const cooldown = isRecord(body) && body.cooldownHours !== undefined ? normalizeCooldownHours(body.cooldownHours) : rule.cooldown_hours
    const staleAfter = isRecord(body) && body.staleAfterHours !== undefined ? normalizeCooldownHours(body.staleAfterHours, 30) : rule.stale_after_hours
    const now = new Date().toISOString()
    await db.prepare("UPDATE alert_rules SET enabled = ?, threshold_percent = ?, cooldown_hours = ?, stale_after_hours = ?, updated_at = ? WHERE rule_id = ? AND owner_player_id = ?").bind(enabled, threshold, cooldown, staleAfter, now, rule.rule_id, session.player_id).run()
    return jsonResponse({ updated: true }, 200, origin)
  }
  if (ruleMatch && request.method === "DELETE") {
    const result = await db.prepare("DELETE FROM alert_rules WHERE rule_id = ? AND owner_player_id = ?").bind(ruleMatch[1], session.player_id).run()
    if (!(result.meta?.changes ?? 0)) return jsonResponse({ error: "Alert rule not found." }, 404, origin)
    return jsonResponse({ deleted: true }, 200, origin)
  }
  if (url.pathname === "/api/me/alerts" && request.method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50) || 50))
    const hasCursor = url.searchParams.has("after")
    const after = url.searchParams.get("after") ?? ""
    const afterEventId = url.searchParams.get("afterEventId") ?? ""
    if (hasCursor && (!after || after.length > 40 || !Number.isFinite(Date.parse(after)))) return jsonResponse({ error: "Invalid alert cursor." }, 400, origin)
    if (afterEventId && !/^[a-f0-9-]{36}$/i.test(afterEventId)) return jsonResponse({ error: "Invalid alert cursor." }, 400, origin)
    if (!hasCursor && afterEventId) return jsonResponse({ error: "Invalid alert cursor." }, 400, origin)
    const eventSelect = "SELECT e.event_id AS eventId, e.rule_id AS ruleId, e.company_id AS companyId, e.rule_type AS ruleType, e.severity, e.title, e.message, e.previous_value AS previousValue, e.current_value AS currentValue, e.change_percent AS changePercent, e.source_snapshot_at AS sourceSnapshotAt, e.status, e.created_at AS createdAt, e.acknowledged_at AS acknowledgedAt, c.company_name AS companyName FROM alert_events e LEFT JOIN companies c ON c.player_id = e.owner_player_id AND c.company_id = e.company_id "
    const eventRows = hasCursor
      ? (afterEventId
        ? db.prepare(eventSelect + "WHERE e.owner_player_id = ? AND (e.created_at > ? OR (e.created_at = ? AND e.event_id > ?)) ORDER BY e.created_at ASC, e.event_id ASC LIMIT ?").bind(session.player_id, after, after, afterEventId, limit)
        : db.prepare(eventSelect + "WHERE e.owner_player_id = ? AND e.created_at > ? ORDER BY e.created_at ASC, e.event_id ASC LIMIT ?").bind(session.player_id, after, limit))
      : db.prepare(eventSelect + "WHERE e.owner_player_id = ? ORDER BY e.created_at DESC LIMIT ?").bind(session.player_id, limit)
    const [rows, unread, latestRun] = await Promise.all([
      eventRows.all<Record<string, unknown>>(),
      db.prepare("SELECT COUNT(*) AS count FROM alert_events WHERE owner_player_id = ? AND status = 'unread'").bind(session.player_id).first<{ count: number }>(),
      db.prepare("SELECT trigger_name AS triggerName, status, started_at AS startedAt, finished_at AS finishedAt, companies_checked AS companiesChecked, companies_failed AS companiesFailed, alerts_created AS alertsCreated, error_summary AS errorSummary FROM automation_runs ORDER BY started_at DESC LIMIT 1").first<Record<string, unknown>>(),
    ])
    return jsonResponse({ events: rows.results ?? [], unreadCount: Number(unread?.count ?? 0), latestRun: latestRun ?? null }, 200, origin)
  }
  const acknowledgeMatch = url.pathname.match(/^\/api\/me\/alerts\/([a-f0-9-]{36})\/acknowledge$/i)
  if (acknowledgeMatch && request.method === "POST") {
    const now = new Date().toISOString()
    const result = await db.prepare("UPDATE alert_events SET status = 'acknowledged', acknowledged_at = ? WHERE event_id = ? AND owner_player_id = ? AND status = 'unread'").bind(now, acknowledgeMatch[1], session.player_id).run()
    if (!(result.meta?.changes ?? 0)) {
      const existing = await db.prepare("SELECT event_id FROM alert_events WHERE event_id = ? AND owner_player_id = ?").bind(acknowledgeMatch[1], session.player_id).first<{ event_id: string }>()
      if (!existing) return jsonResponse({ error: "Alert not found." }, 404, origin)
    }
    return jsonResponse({ acknowledged: true }, 200, origin)
  }
  return jsonResponse({ error: "Automation route not found." }, 404, origin)
}

async function handleUserInsightsRequest(request: Request, env: WorkerEnv, origin: string): Promise<Response | null> {
  const url = new URL(request.url)
  const healthPath = url.pathname === "/api/me/health"
  const historyMatch = url.pathname.match(/^\/api\/me\/companies\/(\d+)\/history$/)
  const rosterPath = url.pathname === "/api/me/member-insights"
  const layoutPath = url.pathname === "/api/me/dashboard-layout"
  const insightStatesPath = url.pathname === "/api/me/insight-states"
  if (!healthPath && !historyMatch && !rosterPath && !layoutPath && !insightStatesPath) return null
  const session = await authenticate(request, env)
  if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
  const db = requireDb(env)

  if (healthPath && request.method === "GET") {
    const probeStartedAt = Date.now()
    const checkedAt = new Date().toISOString()
    try {
      const databaseStartedAt = Date.now()
      const nowUtc = new Date()
      const staleBeforeDate = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), 18, 10, 0, 0))
      if (nowUtc.getTime() < staleBeforeDate.getTime()) staleBeforeDate.setUTCDate(staleBeforeDate.getUTCDate() - 1)
      const staleBefore = staleBeforeDate.toISOString()
      const [summary, rows] = await Promise.all([
        db.prepare("WITH connected AS (SELECT company_id AS companyId FROM companies WHERE player_id = ? UNION SELECT company_id AS companyId FROM company_api_keys WHERE player_id = ?), freshness AS (SELECT c.companyId, MAX(s.fetched_at) AS fetchedAt FROM connected c LEFT JOIN company_snapshots s ON s.player_id = ? AND s.company_id = c.companyId GROUP BY c.companyId) SELECT (SELECT COUNT(*) FROM connected) AS companyCount, (SELECT COUNT(*) FROM company_snapshots WHERE player_id = ?) AS snapshotCount, (SELECT MAX(fetched_at) FROM company_snapshots WHERE player_id = ?) AS latestSnapshotAt, (SELECT COUNT(*) FROM freshness WHERE fetchedAt IS NULL OR fetchedAt < ?) AS staleCompanies").bind(session.player_id, session.player_id, session.player_id, session.player_id, session.player_id, staleBefore).first<Record<string, unknown>>(),
        db.prepare("WITH connected AS (SELECT c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType FROM companies c WHERE c.player_id = ? UNION ALL SELECT k.company_id AS companyId, k.company_name AS companyName, k.company_type AS companyType FROM company_api_keys k WHERE k.player_id = ? AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.player_id = k.player_id AND c.company_id = k.company_id)), snapshot_stats AS (SELECT company_id AS companyId, MAX(fetched_at) AS fetchedAt, COUNT(*) AS snapshotCount FROM company_snapshots WHERE player_id = ? GROUP BY company_id) SELECT c.companyId, c.companyName, c.companyType, s.fetchedAt, COALESCE(s.snapshotCount, 0) AS snapshotCount FROM connected c LEFT JOIN snapshot_stats s ON s.companyId = c.companyId ORDER BY s.fetchedAt DESC LIMIT 100").bind(session.player_id, session.player_id, session.player_id).all<Record<string, unknown>>(),
      ])
      const databaseLatencyMs = Date.now() - databaseStartedAt
      const now = Date.now()
      const companies = (rows.results ?? []).map((row) => {
        const timestamp = row.fetchedAt == null ? Number.NaN : Date.parse(String(row.fetchedAt))
        const preciseAgeHours = Number.isFinite(timestamp) ? Math.max(0, (now - timestamp) / 3600000) : null
        const ageHours = preciseAgeHours === null ? null : Math.round(preciseAgeHours * 10) / 10
        return { ...row, ageHours, freshness: preciseAgeHours === null ? "never" : timestamp < Date.parse(staleBefore) ? "stale" : "fresh" }
      })
      return jsonResponse({ checkedAt, worker: { status: "ok", checkedAt, latencyMs: Date.now() - probeStartedAt }, database: { status: "ok", latencyMs: databaseLatencyMs }, summary: { companyCount: Number(summary?.companyCount ?? 0), snapshotCount: Number(summary?.snapshotCount ?? 0), latestSnapshotAt: summary?.latestSnapshotAt ?? null, staleCompanies: Number(summary?.staleCompanies ?? 0) }, companies }, 200, origin)
    } catch {
      return jsonResponse({ checkedAt, worker: { status: "ok", checkedAt, latencyMs: Date.now() - probeStartedAt }, database: { status: "error", latencyMs: Date.now() - probeStartedAt }, summary: { companyCount: 0, snapshotCount: 0, latestSnapshotAt: null, staleCompanies: 0 }, companies: [], error: "The health check could not query dashboard storage." }, 200, origin)
    }
  }

  if (historyMatch && request.method === "GET") {
    const companyId = historyMatch[1]
    const owned = await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first<Record<string, unknown>>()
      ?? await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType FROM company_api_keys WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first<Record<string, unknown>>()
    if (!owned) return jsonResponse({ error: "That company is not connected to your account." }, 404, origin)
    const requested = url.searchParams.get("days") || "90"
    const range = ["7", "30", "90", "365", "all"].includes(requested) ? requested : "90"
    const cutoff = range === "all" ? null : new Date(Date.now() - Number(range) * DAY * 1000).toISOString()
    const cutoffSql = cutoff ? " AND fetched_at >= ?" : ""
    // Company reporting dates roll over at 18:00 UTC. Align profile snapshots to the same reporting day used by faction_director_snapshots.
    const historyQuery = db.prepare(`SELECT snapshotId, profileJson, employeesJson, fetchedAt FROM (SELECT snapshot_id AS snapshotId, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt, ROW_NUMBER() OVER (PARTITION BY date(fetched_at, '-18 hours') ORDER BY fetched_at DESC, snapshot_id DESC) AS dayRank FROM company_snapshots WHERE player_id = ? AND company_id = ?${cutoffSql}) WHERE dayRank = 1 ORDER BY fetchedAt ASC LIMIT 2000`)
    const raw = await (cutoff ? historyQuery.bind(session.player_id, companyId, cutoff) : historyQuery.bind(session.player_id, companyId)).all<Record<string, unknown>>()
    const byDay = new Map<string, Record<string, unknown>>()
    for (const row of raw.results ?? []) {
      const profile = parseStoredJson(row.profileJson)
      const employees = parseStoredJson(row.employeesJson)
      const root = companyProfileRoot(profile)
      const income = isRecord(root.income) ? root.income : {}
      const profit = isRecord(root.profit) ? root.profit : {}
      const fetchedAtMs = Date.parse(String(row.fetchedAt ?? ""))
      const day = Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10) : ""
      if (!day) continue
      const reportedDailyProfit = numericField(profit.daily ?? root.daily_profit ?? root.dailyProfit)
      byDay.set(day, { day, fetchedAt: row.fetchedAt, snapshotId: row.snapshotId, dailyIncome: dailyIncomeFromProfile(profile), dailyProfit: reportedDailyProfit, dailyProfitSource: reportedDailyProfit === null ? "incomplete" : "reported", calculatedDailyProfit: null, profitReconciliationDelta: null, weeklyIncome: numericField(income.weekly), rating: ratingFromProfile(profile), employeeCount: rosterCount(employees), employeeCapacity: isRecord(root.employees) ? numericField(root.employees.capacity) : null, advertisingBudget: historicalAdvertisingBudget(profile), employeeWages: historicalEmployeeWages(employees), stockOrderExpense: null, stockQuantity: null })
    }
    const stockCutoffDay = cutoff ? cutoff.slice(0, 10) : null
    const stockQuery = db.prepare(`SELECT snapshot_day AS day, stock_json AS stockJson, snapshot_kind AS snapshotKind, fetched_at AS fetchedAt FROM faction_director_snapshots WHERE player_id = ? AND company_id = ?${stockCutoffDay ? " AND snapshot_day >= ?" : ""} ORDER BY snapshot_day ASC`)
    const stockRaw = await (stockCutoffDay ? stockQuery.bind(session.player_id, companyId, stockCutoffDay) : stockQuery.bind(session.player_id, companyId)).all<{ day: string; stockJson: string | null; snapshotKind: string | null; fetchedAt: string | null }>()
    const stockByDay = new Map<string, number>()
    const stockSourceByDay = new Map<string, { snapshotKind: string | null; fetchedAt: string | null }>()
    for (const row of stockRaw.results ?? []) {
      // Preserve canonical snapshot provenance separately from quantity completeness.
      // A present lock-in with incomplete stock still proves the source but not a total.
      stockSourceByDay.set(row.day, {
        snapshotKind: typeof row.snapshotKind === "string" ? row.snapshotKind : null,
        fetchedAt: typeof row.fetchedAt === "string" ? row.fetchedAt : null,
      })
      if (!row.stockJson) continue
      const stock = parseStoredJson(row.stockJson)
      const stockRows = Array.isArray(stock) ? stock : isRecord(stock) && Array.isArray(stock.stock) ? stock.stock : []
      if (!stockRows.length) continue
      const quantities = stockRows.map((item) => {
        if (!isRecord(item)) return null
        return [item.in_stock, item.quantity, item.amount]
          .find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate)) ?? null
      })
      // Preserve uncertainty: a partial/restricted stock payload cannot support a reliable total.
      if (quantities.some((quantity) => quantity === null)) continue
      stockByDay.set(row.day, (quantities as number[]).reduce((sum, quantity) => sum + quantity, 0))
    }
    const financialStockQuery = db.prepare(`SELECT day, stockJson FROM (SELECT date(fetched_at, '-18 hours') AS day, stock_json AS stockJson, fetched_at AS fetchedAt, snapshot_id AS snapshotId, ROW_NUMBER() OVER (PARTITION BY date(fetched_at, '-18 hours') ORDER BY fetched_at DESC, snapshot_id DESC) AS dayRank FROM company_financial_snapshots WHERE player_id = ? AND company_id = ?${cutoffSql}) WHERE dayRank = 1 ORDER BY fetchedAt ASC LIMIT 2000`)
    const financialStockRaw = await (cutoff ? financialStockQuery.bind(session.player_id, companyId, cutoff) : financialStockQuery.bind(session.player_id, companyId)).all<{ day: string; stockJson: string | null }>()
    const stockExpensesByDay = new Map<string, number | null>()
    const financialStockQuantityByDay = new Map<string, number>()
    for (const row of financialStockRaw.results ?? []) {
      const stock = parseStoredJson(row.stockJson)
      const stockRows = Array.isArray(stock) ? stock : isRecord(stock) && Array.isArray(stock.stock) ? stock.stock : []
      if (stockRows.length) {
        const quantities = stockRows.map((item) => {
          if (!isRecord(item)) return null
          return [item.in_stock, item.quantity, item.amount]
            .find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate)) ?? null
        })
        // Use financial history as a fallback only when every stock item has a known quantity.
        if (!quantities.some((quantity) => quantity === null)) {
          financialStockQuantityByDay.set(row.day, (quantities as number[]).reduce((sum, quantity) => sum + quantity, 0))
        }
      }
      stockExpensesByDay.set(row.day, historicalStockOrderExpense(stock))
    }
    for (const point of byDay.values()) {
      const stockSource = stockSourceByDay.get(String(point.day))
      point.stockQuantity = stockByDay.get(String(point.day)) ?? financialStockQuantityByDay.get(String(point.day)) ?? null
      point.stockSnapshotKind = stockSource?.snapshotKind ?? null
      point.stockSnapshotFetchedAt = stockSource?.fetchedAt ?? null
      point.stockOrderExpense = stockExpensesByDay.get(String(point.day)) ?? null
      const hasCompleteProfitInputs = [point.dailyIncome, point.advertisingBudget, point.employeeWages, point.stockOrderExpense]
        .every((value) => typeof value === "number" && Number.isFinite(value))
      if (hasCompleteProfitInputs) {
        const costBasedProfit = Number(point.dailyIncome) - Number(point.advertisingBudget) -
          Number(point.employeeWages) - Number(point.stockOrderExpense)
        point.calculatedDailyProfit = costBasedProfit
        if (typeof point.dailyProfit === "number") {
          if (point.dailyProfitSource === "reported") point.profitReconciliationDelta = point.dailyProfit - costBasedProfit
        } else {
          point.dailyProfit = costBasedProfit
          point.dailyProfitSource = "reconstructed"
        }
      } else if (typeof point.dailyProfit !== "number") {
        point.dailyProfitSource = "incomplete"
      }
    }
    const history = Array.from(byDay.values()).sort((a, b) => String(a.day).localeCompare(String(b.day)))
    const first = history[0] ?? null, latest = history.at(-1) ?? null
    const delta = (key: string) => first && latest && typeof first[key] === "number" && typeof latest[key] === "number" ? Number(latest[key]) - Number(first[key]) : null
    const percent = (key: string) => first && latest && typeof first[key] === "number" && typeof latest[key] === "number" && Number(first[key]) !== 0 ? Math.round((Number(latest[key]) - Number(first[key])) / Number(first[key]) * 1000) / 10 : null
    return jsonResponse({ company: owned, range, history, summary: { snapshotCount: history.length, firstSnapshotAt: first?.fetchedAt ?? null, latestSnapshotAt: latest?.fetchedAt ?? null, dailyIncomeChange: delta("dailyIncome"), dailyIncomeChangePercent: percent("dailyIncome"), weeklyIncomeChange: delta("weeklyIncome"), ratingChange: delta("rating"), employeeCountChange: delta("employeeCount") } }, 200, origin)
  }

  if (rosterPath && request.method === "GET") {
    const requestedCompany = url.searchParams.get("companyId") || ""
    const requestedOwner = url.searchParams.get("ownerPlayerId") || ""
    const ownedCompany = requestedOwner ? null : requestedCompany
      ? await db.prepare("SELECT player_id AS playerId, company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt, 1 AS shareTrendData FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, requestedCompany).first<Record<string, unknown>>()
      : await db.prepare("SELECT player_id AS playerId, company_id AS companyId, company_name AS companyName, company_type AS companyType, profile_json AS profileJson, employees_json AS employeesJson, fetched_at AS fetchedAt, 1 AS shareTrendData FROM companies WHERE player_id = ? ORDER BY fetched_at DESC LIMIT 1").bind(session.player_id).first<Record<string, unknown>>()
    const company = ownedCompany ?? (requestedOwner
      ? await db.prepare("SELECT c.player_id AS playerId, c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType, c.profile_json AS profileJson, c.employees_json AS employeesJson, c.fetched_at AS fetchedAt, s.share_trend_data AS shareTrendData FROM companies c JOIN company_sharing_recipients s ON s.owner_player_id = c.player_id WHERE s.recipient_player_id = ? AND s.owner_player_id = ? AND c.company_id = ? AND s.share_employee_data = 1 LIMIT 1").bind(session.player_id, requestedOwner, requestedCompany).first<Record<string, unknown>>()
      : requestedCompany
        ? await db.prepare("SELECT c.player_id AS playerId, c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType, c.profile_json AS profileJson, c.employees_json AS employeesJson, c.fetched_at AS fetchedAt, s.share_trend_data AS shareTrendData FROM companies c JOIN company_sharing_recipients s ON s.owner_player_id = c.player_id WHERE s.recipient_player_id = ? AND c.company_id = ? AND s.share_employee_data = 1 LIMIT 1").bind(session.player_id, requestedCompany).first<Record<string, unknown>>()
        : await db.prepare("SELECT c.player_id AS playerId, c.company_id AS companyId, c.company_name AS companyName, c.company_type AS companyType, c.profile_json AS profileJson, c.employees_json AS employeesJson, c.fetched_at AS fetchedAt, s.share_trend_data AS shareTrendData FROM companies c JOIN company_sharing_recipients s ON s.owner_player_id = c.player_id WHERE s.recipient_player_id = ? AND s.share_employee_data = 1 ORDER BY c.fetched_at DESC LIMIT 1").bind(session.player_id).first<Record<string, unknown>>())
    if (!company) return jsonResponse({ company: null, roster: [], summary: null, message: requestedCompany ? "Roster data is unavailable or has not been shared with your account." : "Connect a company or ask its director to share employee data to see roster insights." }, 200, origin)
    const canReadHistory = String(company.playerId ?? session.player_id) === session.player_id || Number(company.shareTrendData) === 1
    const profile = parseStoredJson(company.profileJson), rawEmployees = employeesFromPayload(parseStoredJson(company.employeesJson))
    const root = companyProfileRoot(profile), profileEmployees = isRecord(root.employees) ? root.employees : {}
    const roster = rawEmployees.map((employee) => {
      const position = isRecord(employee.position) ? employee.position : {}
      const stats = isRecord(employee.stats) ? employee.stats : {}
      const effectiveness = isRecord(employee.effectiveness) ? employee.effectiveness : {}
      const status = isRecord(employee.status) ? employee.status : {}
      const lastAction = isRecord(employee.last_action) ? employee.last_action : {}
      return { id: String(employee.id ?? ""), name: typeof employee.name === "string" ? employee.name : "Unknown employee", position: typeof position.name === "string" ? position.name : "Unknown position", daysInCompany: numericField(employee.days_in_company), manualLabor: numericField(stats.manual_labor ?? stats.MAN), intelligence: numericField(stats.intelligence ?? stats.INT), endurance: numericField(stats.endurance ?? stats.END), wage: numericField(employee.wage), effectiveness: numericField(effectiveness.total), addictionEffectiveness: numericField(effectiveness.addiction), inactivityEffectiveness: numericField(effectiveness.inactivity), status: typeof status.description === "string" ? status.description : typeof status.state === "string" ? status.state : null, lastAction: typeof lastAction.relative === "string" ? lastAction.relative : typeof lastAction.status === "string" ? lastAction.status : null }
    }).sort((a, b) => a.position.localeCompare(b.position) || a.name.localeCompare(b.name))
    const average = (key: "manualLabor" | "intelligence" | "endurance" | "effectiveness") => { const values = roster.map((item) => item[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value)); return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null }
    const wages = roster.map((item) => item.wage).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    const snapshots = canReadHistory ? await db.prepare("SELECT COUNT(*) AS count, MIN(fetched_at) AS firstAt, MAX(fetched_at) AS latestAt FROM company_snapshots WHERE player_id = ? AND company_id = ?").bind(String(company.playerId ?? session.player_id), String(company.companyId)).first<Record<string, unknown>>() : null
    const positions = new Map<string, number>(); for (const employee of roster) positions.set(employee.position, (positions.get(employee.position) ?? 0) + 1)
    return jsonResponse({ company: { companyId: company.companyId, companyName: company.companyName, companyType: company.companyType, fetchedAt: company.fetchedAt, employeesHired: numericField(profileEmployees.hired), employeeCapacity: numericField(profileEmployees.capacity) }, roster, summary: { rosterCount: roster.length, employeeCapacity: numericField(profileEmployees.capacity), averageManualLabor: average("manualLabor"), averageIntelligence: average("intelligence"), averageEndurance: average("endurance"), averageEffectiveness: average("effectiveness"), knownStatsCount: roster.filter((item) => item.manualLabor !== null && item.intelligence !== null && item.endurance !== null).length, knownWageCount: wages.length, totalKnownWages: wages.reduce((sum, value) => sum + value, 0), positions: Array.from(positions, ([position, count]) => ({ position, count })).sort((a, b) => b.count - a.count || a.position.localeCompare(b.position)), snapshotCount: Number(snapshots?.count ?? 0), firstSnapshotAt: snapshots?.firstAt ?? null, latestSnapshotAt: snapshots?.latestAt ?? null } }, 200, origin)
  }

  if (insightStatesPath && (request.method === "GET" || request.method === "POST")) {
    const companyId = positiveId(url.searchParams.get("companyId"))
    if (!companyId) return jsonResponse({ error: "Provide a valid connected company ID." }, 400, origin)
    const owned = await db.prepare("SELECT company_id AS companyId FROM companies WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first<Record<string, unknown>>()
      ?? await db.prepare("SELECT company_id AS companyId FROM company_api_keys WHERE player_id = ? AND company_id = ? LIMIT 1").bind(session.player_id, companyId).first<Record<string, unknown>>()
    if (!owned) return jsonResponse({ error: "That company is not connected to your account." }, 404, origin)
    await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
    const key = `insight-states:${companyId}`
    if (request.method === "GET") {
      const row = await db.prepare("SELECT data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ? AND page_key = ?").bind(session.player_id, key).first<Record<string, unknown>>()
      let states: unknown = {}; try { states = row?.dataJson ? JSON.parse(String(row.dataJson)) : {} } catch { states = {} }
      return jsonResponse({ states: isRecord(states) ? states : {}, updatedAt: row?.updatedAt ?? null }, 200, origin, { "cache-control": "no-store" })
    }
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body) || !isRecord(body.states)) return jsonResponse({ error: "Provide a valid insight state object." }, 400, origin)
    const entries = Object.entries(body.states)
    if (entries.length > 100) return jsonResponse({ error: "Too many insight states. Limit is 100 per company." }, 400, origin)
    const states: Record<string, { status: string; updatedAt: string }> = {}
    const allowedStatuses = new Set(["open", "monitoring", "resolved", "dismissed"])
    for (const [id, value] of entries) {
      if (!id || id.length > 500 || !isRecord(value) || typeof value.status !== "string" || !allowedStatuses.has(value.status)) return jsonResponse({ error: "An insight state has an invalid ID or status." }, 400, origin)
      const updatedAt = typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString()
      states[id] = { status: value.status, updatedAt }
    }
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(session.player_id, key, asJson(states), now).run()
    return jsonResponse({ saved: true, states, updatedAt: now }, 200, origin, { "cache-control": "no-store" })
  }

  if (layoutPath && (request.method === "GET" || request.method === "POST")) {
    await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
    const key = "dashboard-layout"
    const allowed = new Set(["company-health", "income-performance", "roster-overview", "recent-trends", "actionable-insights", "automation-status", "alerts", "rankings"])
    if (request.method === "GET") {
      const row = await db.prepare("SELECT data_json AS dataJson, updated_at AS updatedAt FROM user_page_data WHERE player_id = ? AND page_key = ?").bind(session.player_id, key).first<Record<string, unknown>>()
      let layout: unknown = null; try { layout = row?.dataJson ? JSON.parse(String(row.dataJson)) : null } catch { layout = null }
      return jsonResponse({ layout, updatedAt: row?.updatedAt ?? null }, 200, origin)
    }
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body) || !Array.isArray(body.widgets) || body.widgets.length > 8) return jsonResponse({ error: "Provide a valid dashboard widget layout." }, 400, origin)
    const rawPreferences = isRecord(body.dashboardPreferences) ? body.dashboardPreferences : {}
    const dashboardPreferences = {
      density: rawPreferences.density === "compact" ? "compact" : "comfortable",
      contentWidth: rawPreferences.contentWidth === "wide" ? "wide" : "standard",
    }
    const seen = new Set<string>(), widgets: { id: string; visible: boolean; order: number }[] = []
    for (const [index, value] of body.widgets.entries()) {
      if (!isRecord(value) || typeof value.id !== "string" || !allowed.has(value.id) || seen.has(value.id)) return jsonResponse({ error: "The layout contains an unknown or duplicate widget." }, 400, origin)
      seen.add(value.id); widgets.push({ id: value.id, visible: value.visible !== false, order: index })
    }
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO user_page_data (player_id, page_key, data_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, page_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at").bind(session.player_id, key, asJson({ widgets, dashboardPreferences }), now).run()
    return jsonResponse({ saved: true, layout: { widgets, dashboardPreferences }, updatedAt: now }, 200, origin)
  }
  return jsonResponse({ error: "Insights route not found." }, 404, origin)
}

async function handleAdminRequest(request: Request, env: WorkerEnv, origin: string, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/api/admin")) return null
  const session = await authenticate(request, env)
  if (!session) return jsonResponse({ error: "An active dashboard session is required." }, 401, origin)
  if (session.is_admin !== 1) {
    await writeAdminAudit(env, session, "authorization.denied", "route", url.pathname, "denied", "A non-administrator session attempted to access an administration route.")
    return jsonResponse({ error: "Administrator access is required." }, 403, origin)
  }
  const db = requireDb(env)
  await ensureAdminJobPayloadSchema(env)
  await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
  await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
  if (url.pathname === "/api/admin/administrators" && request.method === "GET") {
    const rows = await db.prepare(
      "SELECT a.player_id AS playerId, p.player_name AS playerName, a.granted_by AS grantedBy, grantor.player_name AS grantedByName, a.granted_at AS grantedAt, a.revoked_by AS revokedBy, revoker.player_name AS revokedByName, a.revoked_at AS revokedAt FROM administrators a JOIN players p ON p.player_id = a.player_id LEFT JOIN players grantor ON grantor.player_id = a.granted_by LEFT JOIN players revoker ON revoker.player_id = a.revoked_by ORDER BY CASE WHEN a.revoked_at IS NULL THEN 0 ELSE 1 END, p.player_name COLLATE NOCASE"
    ).all<Record<string, unknown>>()
    return jsonResponse({ administrators: rows.results ?? [] }, 200, origin)
  }
  if (url.pathname === "/api/admin/administrators/grant" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    const targetId = isRecord(body) && typeof body.playerId === "string" ? body.playerId.trim() : ""
    if (!/^\d{1,20}$/.test(targetId) || !positiveId(targetId)) return jsonResponse({ error: "Enter a valid Torn player ID." }, 400, origin)
    if (targetId === session.player_id) return jsonResponse({ error: "Your own administrator role is already active." }, 409, origin)
    const target = await db.prepare("SELECT p.player_id, p.player_name, p.faction_id, p.faction_verified_at, st.disabled_at FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.player_id = ?")
      .bind(targetId).first<{ player_id: string; player_name: string; faction_id: string | null; faction_verified_at: string | null; disabled_at: string | null }>()
    if (!target) return jsonResponse({ error: "That player must sign in and verify Naughty Souls membership before receiving an administrator role." }, 404, origin)
    if (target.disabled_at) return jsonResponse({ error: "That member's dashboard access is suspended. Restore member access before granting administrator privileges." }, 409, origin)
    const targetVerificationAge = target.faction_verified_at ? Date.now() - Date.parse(target.faction_verified_at) : Number.POSITIVE_INFINITY
    if (target.faction_id !== NAUGHTY_SOULS_FACTION_ID || !Number.isFinite(targetVerificationAge) || targetVerificationAge < 0 || targetVerificationAge > 5 * 60 * 1000) {
      return jsonResponse({ error: "That member must sign in and refresh their Naughty Souls membership verification before administrator privileges can be granted." }, 409, origin)
    }
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO administrators (player_id, granted_by, granted_at, revoked_by, revoked_at) VALUES (?, ?, ?, NULL, NULL) ON CONFLICT(player_id) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at, revoked_by = NULL, revoked_at = NULL")
      .bind(targetId, session.player_id, now).run()
    await writeAdminAudit(env, session, "administrator.granted", "administrator", targetId, "succeeded", `Granted administrator privileges to ${target.player_name}.`, { playerId: targetId })
    return jsonResponse({ granted: true, playerId: targetId, playerName: target.player_name, grantedAt: now }, 200, origin)
  }
  if (url.pathname === "/api/admin/administrators/revoke" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    const targetId = isRecord(body) && typeof body.playerId === "string" ? body.playerId.trim() : ""
    if (!/^\d{1,20}$/.test(targetId) || !positiveId(targetId)) return jsonResponse({ error: "Enter a valid Torn player ID." }, 400, origin)
    if (targetId === session.player_id) return jsonResponse({ error: "You cannot revoke your own administrator role. Another administrator must do that." }, 409, origin)
    const target = await db.prepare("SELECT p.player_name, a.revoked_at FROM administrators a JOIN players p ON p.player_id = a.player_id WHERE a.player_id = ?")
      .bind(targetId).first<{ player_name: string; revoked_at: string | null }>()
    if (!target || target.revoked_at) return jsonResponse({ error: "That player does not have an active administrator role." }, 404, origin)
    const now = new Date().toISOString()
    // Keep at least one active administrator. The count predicate lives in
    // the UPDATE itself so concurrent revocations cannot strand the portal.
    const revocation = await db.prepare("UPDATE administrators SET revoked_by = ?, revoked_at = ? WHERE player_id = ? AND revoked_at IS NULL AND (SELECT COUNT(*) FROM administrators WHERE revoked_at IS NULL) > 1")
      .bind(session.player_id, now, targetId).run()
    if (Number(revocation.meta?.changes ?? 0) !== 1) {
      await writeAdminAudit(env, session, "administrator.revocation_blocked", "administrator", targetId, "denied", "Blocked administrator revocation because it would remove the last active administrator or the role changed concurrently.", { playerId: targetId })
      return jsonResponse({ error: "The last active administrator cannot be removed. Grant another administrator role first." }, 409, origin)
    }
    await writeAdminAudit(env, session, "administrator.revoked", "administrator", targetId, "succeeded", `Revoked administrator privileges from ${target.player_name}.`, { playerId: targetId })
    return jsonResponse({ revoked: true, playerId: targetId, playerName: target.player_name, revokedAt: now }, 200, origin)
  }
  const memberMatch = url.pathname.match(/^\/api\/admin\/members\/(\d+)(?:\/(status|connection-test|connection-repair))?$/)
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50) || 50))
  if (url.pathname === "/api/admin/faction/weekly-boundaries" && request.method === "GET") {
    const boundaryLimit = Math.min(26, Math.max(1, Number(url.searchParams.get("limit") || 12) || 12))
    const currentSundayMs = utcSundayStart(Date.now())
    const boundaryTimes = Array.from({ length: boundaryLimit }, (_, index) =>
      new Date(currentSundayMs - index * WEEK_MS).toISOString())
    const reportWeekStarts = Array.from(new Set([
      ...boundaryTimes,
      ...boundaryTimes.map((value) => new Date(Date.parse(value) - WEEK_MS).toISOString()),
    ]))
    const boundaryPlaceholders = boundaryTimes.map(() => "?").join(", ")
    const reportPlaceholders = reportWeekStarts.map(() => "?").join(", ")
    const [registryRows, reportRows, membershipRows] = await Promise.all([
      db.prepare(
        `SELECT boundary_at AS boundaryAt, stats_run_id AS statsRunId, gym_energy_run_id AS gymEnergyRunId, created_at AS createdAt
         FROM faction_weekly_boundary_runs
         WHERE faction_id = ? AND boundary_at IN (${boundaryPlaceholders})`
      ).bind(NAUGHTY_SOULS_FACTION_ID, ...boundaryTimes).all<Record<string, unknown>>(),
      db.prepare(
        `SELECT week_start_at AS weekStartAt, week_end_at AS weekEndAt, report_status AS status,
                member_count AS memberCount, complete_member_count AS completeMemberCount, finalized_at AS finalizedAt
         FROM faction_weekly_reports
         WHERE faction_id = ? AND week_start_at IN (${reportPlaceholders})`
      ).bind(NAUGHTY_SOULS_FACTION_ID, ...reportWeekStarts).all<Record<string, unknown>>(),
      db.prepare(
        "SELECT user_id AS userId, estimated_joined_at AS estimatedJoinedAt, first_seen_at AS firstSeenAt, left_observed_at AS leftObservedAt FROM faction_membership_intervals WHERE faction_id = ?"
      ).bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>(),
    ])
    const registryByBoundary = new Map((registryRows.results ?? []).map((row) => [String(row.boundaryAt), row]))
    const reportByWeek = new Map((reportRows.results ?? []).map((row) => [String(row.weekStartAt), row]))
    const runIds = Array.from(new Set((registryRows.results ?? []).flatMap((row) =>
      [String(row.statsRunId ?? ""), String(row.gymEnergyRunId ?? "")].filter(Boolean))))
    const runPlaceholders = runIds.map(() => "?").join(", ")
    const runRows = runIds.length ? await db.prepare(
      `SELECT r.run_id AS runId, r.collection_kind AS collectionKind, r.status,
              r.scheduled_at AS scheduledAt, r.started_at AS startedAt, r.completed_at AS completedAt,
              r.last_enqueued_at AS lastEnqueuedAt, r.last_error AS lastError, r.updated_at AS updatedAt,
              r.target_user_ids_json AS targetUserIdsJson, r.next_index AS nextIndex,
              (SELECT COUNT(*) FROM faction_member_stat_snapshots s WHERE s.run_id = r.run_id) AS capturedStatMembers,
              (SELECT COUNT(*) FROM faction_member_stat_snapshots s WHERE s.run_id = r.run_id AND s.collection_status = 'complete') AS completeStatMembers,
              (SELECT MIN(s.captured_at) FROM faction_member_stat_snapshots s WHERE s.run_id = r.run_id) AS firstStatCapturedAt,
              (SELECT MAX(s.captured_at) FROM faction_member_stat_snapshots s WHERE s.run_id = r.run_id) AS lastStatCapturedAt,
              (SELECT COUNT(*) FROM faction_gym_energy_snapshots g WHERE g.run_id = r.run_id) AS capturedGymMembers,
              (SELECT COUNT(*) FROM faction_gym_energy_snapshots g WHERE g.run_id = r.run_id AND g.collection_status = 'complete') AS completeGymMembers,
              (SELECT MIN(g.captured_at) FROM faction_gym_energy_snapshots g WHERE g.run_id = r.run_id) AS firstGymCapturedAt,
              (SELECT MAX(g.captured_at) FROM faction_gym_energy_snapshots g WHERE g.run_id = r.run_id) AS lastGymCapturedAt
       FROM faction_performance_collection_runs r WHERE r.run_id IN (${runPlaceholders})`
    ).bind(...runIds).all<Record<string, unknown>>() : { results: [] as Record<string, unknown>[] }
    const runsById = new Map((runRows.results ?? []).map((row) => [String(row.runId), row]))
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const diagnosticRun = (runId: unknown, expectedKind: "personalstats" | "gym_energy", cohortMemberCount = 0) => {
      const row = typeof runId === "string" ? runsById.get(runId) : undefined
      if (!row || row.collectionKind !== expectedKind) return null
      const status = String(row.status ?? "unknown")
      const scheduledAt = row.scheduledAt == null ? null : String(row.scheduledAt)
      const lastEnqueuedAt = row.lastEnqueuedAt == null ? null : String(row.lastEnqueuedAt)
      const updatedAt = row.updatedAt == null ? null : String(row.updatedAt)
      const activityAt = lastEnqueuedAt ?? updatedAt ?? (row.startedAt == null ? null : String(row.startedAt)) ?? scheduledAt
      const ageMs = activityAt ? nowMs - Date.parse(activityAt) : Number.POSITIVE_INFINITY
      const staleAfterMs = status === "running" ? 10 * 60 * 1000 : 4 * 60 * 1000
      const stale = (status === "queued" || status === "running") && Number.isFinite(ageMs) && ageMs > staleAfterMs
      let targetMemberCount = 0
      try {
        const targets = row.targetUserIdsJson ? JSON.parse(String(row.targetUserIdsJson)) as unknown : []
        targetMemberCount = Array.isArray(targets) && targets.length ? targets.length : cohortMemberCount
      } catch { targetMemberCount = 0 }
      const statsCollection = expectedKind === "personalstats"
      const capturedMemberCount = Number(statsCollection ? row.capturedStatMembers ?? 0 : row.capturedGymMembers ?? 0)
      const completeMemberCount = Number(statsCollection ? row.completeStatMembers ?? 0 : row.completeGymMembers ?? 0)
      const firstCapturedAt = (statsCollection ? row.firstStatCapturedAt : row.firstGymCapturedAt) == null
        ? null : String(statsCollection ? row.firstStatCapturedAt : row.firstGymCapturedAt)
      const lastCapturedAt = (statsCollection ? row.lastStatCapturedAt : row.lastGymCapturedAt) == null
        ? null : String(statsCollection ? row.lastStatCapturedAt : row.lastGymCapturedAt)
      const timingDeviationSeconds = firstCapturedAt && scheduledAt
        ? Math.round((Date.parse(firstCapturedAt) - Date.parse(scheduledAt)) / 1000)
        : null
      return {
        runId: String(row.runId),
        status,
        scheduledAt,
        startedAt: row.startedAt == null ? null : String(row.startedAt),
        completedAt: row.completedAt == null ? null : String(row.completedAt),
        lastEnqueuedAt,
        updatedAt,
        lastError: row.lastError == null ? null : String(row.lastError),
        targetMemberCount,
        capturedMemberCount,
        completeMemberCount,
        firstCapturedAt,
        lastCapturedAt,
        timingDeviationSeconds,
        late: timingDeviationSeconds !== null && timingDeviationSeconds > 300,
        stale,
        nextIndex: Number(row.nextIndex ?? 0),
      }
    }
    const boundaries = boundaryTimes.map((boundaryAt) => {
      const registry = registryByBoundary.get(boundaryAt)
      const boundaryMs = Date.parse(boundaryAt)
      const knownMemberCount = (membershipRows.results ?? []).filter((row) => {
        const joinedAt = Date.parse(String(row.estimatedJoinedAt ?? row.firstSeenAt ?? ""))
        const leftAt = row.leftObservedAt == null ? Number.POSITIVE_INFINITY : Date.parse(String(row.leftObservedAt))
        return Number.isFinite(joinedAt) && joinedAt <= boundaryMs && leftAt > boundaryMs
      }).length
      const stats = registry ? diagnosticRun(registry.statsRunId, "personalstats") : null
      const gymEnergy = registry ? diagnosticRun(registry.gymEnergyRunId, "gym_energy", knownMemberCount) : null
      const endingWeekStartAt = new Date(boundaryMs - WEEK_MS).toISOString()
      const endingWeekReport = reportByWeek.get(endingWeekStartAt) ?? null
      const startingWeekReport = reportByWeek.get(boundaryAt) ?? null
      const locked = Boolean(endingWeekReport || startingWeekReport)
      const ageMs = nowMs - boundaryMs
      const withinExistingRunRecoveryWindow = ageMs >= 0 && ageMs <= 8 * DAY * 1000
      const withinMissingBoundaryRecoveryWindow = ageMs >= 0 && ageMs <= DAY * 1000
      const recoveryCollections: string[] = []
      let status: string
      let recoveryReason: string | null = null
      if (!registry) {
        status = "missing"
        if (locked) recoveryReason = "A finalized report references this boundary; historical data is immutable."
        else if (!withinMissingBoundaryRecoveryWindow) recoveryReason = "A missing Sunday capture can only be created within 24 hours; later collection cannot reconstruct the original counters."
        else if (knownMemberCount === 0) recoveryReason = "No known membership intervals cover this Sunday, so a safe cohort cannot be reconstructed."
        else recoveryReason = "The Sunday boundary is missing and its known member cohort can still be captured late."
      } else if (!stats || !gymEnergy) {
        status = "broken_registry"
        recoveryReason = "The boundary registry references a missing or mismatched collection run; automatic repair is disabled."
      } else {
        const runs = [stats, gymEnergy]
        const recoverableRun = (run: NonNullable<typeof stats>) =>
          run.status === "failed" || run.status === "partial" || run.stale
        if (locked) {
          status = String(endingWeekReport?.status ?? startingWeekReport?.status ?? "locked") === "complete" ? "locked" : "report_finalized"
          recoveryReason = "A finalized weekly report references this boundary; recovery would make source captures disagree with the immutable report."
        } else if (!withinExistingRunRecoveryWindow) {
          status = "expired"
          recoveryReason = "This boundary is older than the eight-day recovery window. Replaying it would produce misleading historical deltas."
        } else {
          if (recoverableRun(stats)) recoveryCollections.push("personalstats")
          if (recoverableRun(gymEnergy)) recoveryCollections.push("gym_energy")
          if (recoveryCollections.length) {
            status = runs.some((run) => run.stale) ? "stale" : runs.some((run) => run.status === "failed") ? "failed" : "partial"
            recoveryReason = "Only failed, partial, or stale captures can be retried; the frozen Sunday cohort and actual capture timestamps are retained."
          } else if (stats.status === "completed" && gymEnergy.status === "completed") {
            status = "complete"
            recoveryReason = "Both Sunday captures completed successfully."
          } else {
            status = "collecting"
            recoveryReason = "One or both Sunday captures are still within their normal queue retry window."
          }
        }
      }
      const recoveryEligible = !locked && (
        (!registry && withinMissingBoundaryRecoveryWindow && knownMemberCount > 0) ||
        (Boolean(registry && stats && gymEnergy) && withinExistingRunRecoveryWindow && recoveryCollections.length > 0)
      )
      return {
        boundaryAt,
        boundaryExists: Boolean(registry),
        knownMemberCount,
        status,
        stats,
        gymEnergy,
        endingWeekReport: endingWeekReport ? {
          weekStartAt: String(endingWeekReport.weekStartAt),
          weekEndAt: String(endingWeekReport.weekEndAt),
          status: String(endingWeekReport.status),
          finalizedAt: String(endingWeekReport.finalizedAt),
        } : null,
        startingWeekReport: startingWeekReport ? {
          weekStartAt: String(startingWeekReport.weekStartAt),
          weekEndAt: String(startingWeekReport.weekEndAt),
          status: String(startingWeekReport.status),
          finalizedAt: String(startingWeekReport.finalizedAt),
        } : null,
        recoverable: recoveryEligible,
        recoveryCollections,
        recoveryReason,
      }
    })
    return jsonResponse({ generatedAt: now, windowStartAt: boundaryTimes[boundaryTimes.length - 1], boundaries }, 200, origin)
  }
  if (url.pathname === "/api/admin/faction/weekly-boundaries/recover" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    const boundaryAt = isRecord(body) && typeof body.boundaryAt === "string" ? body.boundaryAt : ""
    const requestedRaw = isRecord(body) ? body.collections : undefined
    const requestedCollections = requestedRaw === undefined ? ["personalstats", "gym_energy"] :
      Array.isArray(requestedRaw) ? requestedRaw : null
    if (!boundaryAt || requestedCollections === null || requestedCollections.length === 0 ||
        requestedCollections.some((kind) => kind !== "personalstats" && kind !== "gym_energy")) {
      return jsonResponse({ error: "Provide a Sunday boundary and one or both supported collection kinds." }, 400, origin)
    }
    const boundaryMs = Date.parse(boundaryAt)
    if (!Number.isFinite(boundaryMs) || new Date(utcSundayStart(boundaryMs)).toISOString() !== boundaryAt) {
      return jsonResponse({ error: "Select a Sunday 00:00 UTC boundary." }, 400, origin)
    }
    const currentSundayMs = utcSundayStart(Date.now())
    if (boundaryMs > currentSundayMs) return jsonResponse({ error: "Future Sunday boundaries cannot be recovered." }, 400, origin)
    if (!env.GLOBAL_RANKINGS_QUEUE || !env.TORN_FACTION_API_KEY?.trim()) {
      return jsonResponse({ error: "Faction collection queue or dedicated faction API key is not configured." }, 503, origin)
    }
    const relatedWeekStarts = [
      new Date(boundaryMs - WEEK_MS).toISOString(),
      boundaryAt,
    ]
    const reportPlaceholders = relatedWeekStarts.map(() => "?").join(", ")
    const finalized = await db.prepare(
      `SELECT week_start_at AS weekStartAt, report_status AS status FROM faction_weekly_reports
       WHERE faction_id = ? AND week_start_at IN (${reportPlaceholders}) LIMIT 2`
    ).bind(NAUGHTY_SOULS_FACTION_ID, ...relatedWeekStarts).all<Record<string, unknown>>()
    if ((finalized.results ?? []).length) {
      await writeAdminAudit(env, session, "faction.weekly_boundary.recovery_blocked", "faction_weekly_boundary", boundaryAt, "denied",
        "Blocked recovery because a finalized weekly report references this Sunday boundary.", { relatedReports: (finalized.results ?? []).map((row) => ({ weekStartAt: row.weekStartAt, status: row.status })) })
      return jsonResponse({ error: "A finalized weekly report references this boundary. Its source captures and member results are immutable." }, 409, origin)
    }
    const ageMs = Date.now() - boundaryMs
    const registry = await db.prepare(
      "SELECT stats_run_id AS statsRunId, gym_energy_run_id AS gymEnergyRunId FROM faction_weekly_boundary_runs WHERE faction_id = ? AND boundary_at = ?"
    ).bind(NAUGHTY_SOULS_FACTION_ID, boundaryAt).first<{ statsRunId: string; gymEnergyRunId: string }>()
    if (!registry) {
      if (ageMs < 0 || ageMs > DAY * 1000) {
        return jsonResponse({ error: "A missing Sunday capture can only be created within 24 hours. The original historical counter values cannot be reconstructed later." }, 409, origin)
      }
      const enqueued = await enqueueFactionWeeklyBoundaryRun(env, boundaryMs)
      if (!enqueued) {
        return jsonResponse({ error: "No known membership cohort covers this Sunday, or the boundary could not be queued. No capture was created." }, 409, origin)
      }
      const created = await db.prepare(
        "SELECT stats_run_id AS statsRunId, gym_energy_run_id AS gymEnergyRunId FROM faction_weekly_boundary_runs WHERE faction_id = ? AND boundary_at = ?"
      ).bind(NAUGHTY_SOULS_FACTION_ID, boundaryAt).first<{ statsRunId: string; gymEnergyRunId: string }>()
      if (!created) return jsonResponse({ error: "The Sunday boundary could not be verified after queueing." }, 503, origin)
      const createdKinds = ["personalstats", "gym_energy"]
      await writeAdminAudit(env, session, "faction.weekly_boundary.created", "faction_weekly_boundary", boundaryAt, "succeeded",
        "Created and queued a missing Sunday boundary for its known membership cohort.", { collections: createdKinds })
      return jsonResponse({ boundaryAt, created: true, queuedCollections: createdKinds, runIds: { personalstats: created.statsRunId, gym_energy: created.gymEnergyRunId } }, 200, origin)
    }
    if (ageMs < 0 || ageMs > 8 * DAY * 1000) {
      return jsonResponse({ error: "Existing Sunday captures can only be retried within eight days. Replaying older counters would produce misleading historical deltas." }, 409, origin)
    }
    const selected = new Set(requestedCollections as string[])
    const runRows = await db.prepare(
      "SELECT run_id AS runId, collection_kind AS collectionKind, status, last_enqueued_at AS lastEnqueuedAt, started_at AS startedAt, scheduled_at AS scheduledAt, updated_at AS updatedAt FROM faction_performance_collection_runs WHERE run_id IN (?, ?) AND faction_id = ?"
    ).bind(registry.statsRunId, registry.gymEnergyRunId, NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>()
    const runsByKind = new Map((runRows.results ?? []).map((row) => [String(row.collectionKind), row]))
    const now = new Date().toISOString()
    const queued: Array<{ collection: string; runId: string }> = []
    const skipped: Array<{ collection: string; reason: string }> = []
    for (const collection of ["personalstats", "gym_energy"]) {
      if (!selected.has(collection)) continue
      const run = runsByKind.get(collection)
      if (!run || String(run.runId) !== String(collection === "personalstats" ? registry.statsRunId : registry.gymEnergyRunId)) {
        skipped.push({ collection, reason: "The registry run is missing or has the wrong collection kind." })
        continue
      }
      const status = String(run.status)
      const activityAt = run.lastEnqueuedAt ?? run.updatedAt ?? run.startedAt ?? run.scheduledAt
      const ageSinceActivity = activityAt ? Date.now() - Date.parse(String(activityAt)) : Number.POSITIVE_INFINITY
      const staleAfter = status === "running" ? 10 * 60 * 1000 : 4 * 60 * 1000
      const stale = (status === "queued" || status === "running") && Number.isFinite(ageSinceActivity) && ageSinceActivity > staleAfter
      if (status === "completed") {
        skipped.push({ collection, reason: "The capture already completed." })
        continue
      }
      if (!(status === "failed" || status === "partial" || stale)) {
        skipped.push({ collection, reason: "The collection is still within its normal retry window." })
        continue
      }
      const reset = await db.prepare(
        "UPDATE faction_performance_collection_runs SET status = 'queued', next_index = 0, started_at = NULL, completed_at = NULL, last_enqueued_at = NULL, last_error = NULL, updated_at = ? WHERE run_id = ? AND status = ? AND updated_at = ?"
      ).bind(now, String(run.runId), status, run.updatedAt == null ? "" : String(run.updatedAt)).run()
      if (Number(reset.meta?.changes ?? 0) !== 1) {
        skipped.push({ collection, reason: "The run changed concurrently; reload diagnostics before retrying." })
        continue
      }
      try {
        await env.GLOBAL_RANKINGS_QUEUE.send({ kind: FACTION_PERFORMANCE_QUEUE_KIND, runId: String(run.runId) })
        const enqueuedAt = new Date().toISOString()
        await db.prepare(
          "UPDATE faction_performance_collection_runs SET last_enqueued_at = ?, updated_at = ? WHERE run_id = ? AND status = 'queued'"
        ).bind(enqueuedAt, enqueuedAt, String(run.runId)).run()
        queued.push({ collection, runId: String(run.runId) })
      } catch {
        await writeAdminAudit(env, session, "faction.weekly_boundary.recovery_failed", "faction_weekly_boundary", boundaryAt, "failed",
          "A collection run was reset but its queue message could not be delivered.", { collection, runId: run.runId })
        return jsonResponse({ error: "The run was reset but the queue message could not be delivered. Reload diagnostics and retry after the queue-dispatch window." }, 503, origin)
      }
    }
    if (!queued.length) {
      return jsonResponse({ error: skipped.map((item) => item.collection + ": " + item.reason).join(" ") || "No selected collection needed recovery.", skipped }, 409, origin)
    }
    await writeAdminAudit(env, session, "faction.weekly_boundary.recovered", "faction_weekly_boundary", boundaryAt, "succeeded",
      "Requeued incomplete Sunday boundary captures without changing any finalized report.", { queued, skipped })
    return jsonResponse({ boundaryAt, created: false, queued, skipped }, 200, origin)
  }
  if (url.pathname === "/api/admin/member-activity" && request.method === "GET") {
    const daysRaw = Number(url.searchParams.get("days") || 30), days = [7, 30, 90, 365].includes(daysRaw) ? daysRaw : 30
    const cutoff = new Date(Date.now() - days * DAY * 1000).toISOString()
    const [summary, recent] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS totalMembers, SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS activeMembers, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS newMembers, SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM companies c WHERE c.player_id = players.player_id) AND NOT EXISTS (SELECT 1 FROM company_api_keys k WHERE k.player_id = players.player_id) THEN 1 ELSE 0 END) AS withoutCompany FROM players").bind(cutoff, cutoff).first<Record<string, unknown>>(),
      db.prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, p.created_at AS createdAt, p.updated_at AS lastActiveAt, (SELECT COUNT(*) FROM company_snapshots s WHERE s.player_id = p.player_id) AS snapshotCount, (SELECT MAX(c.fetched_at) FROM companies c WHERE c.player_id = p.player_id) AS latestCompanyAt FROM players p ORDER BY p.updated_at DESC LIMIT 50").all<Record<string, unknown>>(),
    ])
    return jsonResponse({ rangeDays: days, summary: { totalMembers: Number(summary?.totalMembers ?? 0), activeMembers: Number(summary?.activeMembers ?? 0), newMembers: Number(summary?.newMembers ?? 0), withoutCompany: Number(summary?.withoutCompany ?? 0) }, members: recent.results ?? [], generatedAt: new Date().toISOString() }, 200, origin)
  }
  if (url.pathname === "/api/admin/automation/runs" && request.method === "GET") {
    await ensureAutomationSchema(env)
    const requestedRange = url.searchParams.get("days") || "30"
    const range = ["7", "30", "90", "365", "all"].includes(requestedRange) ? requestedRange : "30"
    const cutoff = range === "all" ? null : new Date(Date.now() - Number(range) * DAY * 1000).toISOString()
    const where = cutoff ? "WHERE started_at >= ?" : ""
    const runQuery = db.prepare(`SELECT run_id AS runId, trigger_name AS triggerName, status, started_at AS startedAt, finished_at AS finishedAt, companies_checked AS companiesChecked, companies_failed AS companiesFailed, alerts_created AS alertsCreated, error_summary AS errorSummary FROM automation_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    const summaryQuery = db.prepare(`SELECT COUNT(*) AS totalRuns, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeededRuns, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedRuns, SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partialRuns, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS runningRuns, SUM(CASE WHEN status IN ('succeeded', 'failed', 'partial') THEN 1 ELSE 0 END) AS completedRuns, AVG(CASE WHEN finished_at IS NOT NULL THEN CASE WHEN julianday(finished_at) >= julianday(started_at) THEN (julianday(finished_at) - julianday(started_at)) * 86400 ELSE 0 END END) AS avgDurationSeconds, SUM(companies_failed) AS companiesFailed, SUM(alerts_created) AS alertsCreated, MAX(started_at) AS latestRunAt FROM automation_runs ${where}`)
    const failuresWhere = cutoff ? "WHERE started_at >= ? AND status IN ('failed', 'partial') AND error_summary IS NOT NULL AND TRIM(error_summary) <> ''" : "WHERE status IN ('failed', 'partial') AND error_summary IS NOT NULL AND TRIM(error_summary) <> ''"
    const failuresQuery = db.prepare(`SELECT error_summary AS errorSummary, COUNT(*) AS occurrences FROM automation_runs ${failuresWhere} GROUP BY error_summary ORDER BY occurrences DESC, MAX(started_at) DESC LIMIT 3`)
    const [rows, rawSummary, failureRows] = await Promise.all([
      cutoff ? runQuery.bind(cutoff, limit).all<Record<string, unknown>>() : runQuery.bind(limit).all<Record<string, unknown>>(),
      cutoff ? summaryQuery.bind(cutoff).first<Record<string, unknown>>() : summaryQuery.first<Record<string, unknown>>(),
      cutoff ? failuresQuery.bind(cutoff).all<Record<string, unknown>>() : failuresQuery.all<Record<string, unknown>>(),
    ])
    const summary = rawSummary ?? {}
    const completedRuns = Number(summary.completedRuns ?? 0)
    const succeededRuns = Number(summary.succeededRuns ?? 0)
    const insights = {
      totalRuns: Number(summary.totalRuns ?? 0),
      succeededRuns,
      failedRuns: Number(summary.failedRuns ?? 0),
      partialRuns: Number(summary.partialRuns ?? 0),
      runningRuns: Number(summary.runningRuns ?? 0),
      completedRuns,
      successRate: completedRuns > 0 ? Math.round((succeededRuns / completedRuns) * 1000) / 10 : null,
      avgDurationSeconds: summary.avgDurationSeconds == null ? null : Math.round(Number(summary.avgDurationSeconds)),
      companiesFailed: Number(summary.companiesFailed ?? 0),
      alertsCreated: Number(summary.alertsCreated ?? 0),
      latestRunAt: summary.latestRunAt ?? null,
      recurringFailures: failureRows.results ?? [],
    }
    return jsonResponse({ runs: rows.results ?? [], insights, range }, 200, origin)
  }
  if (url.pathname === "/api/admin/overview" && request.method === "GET") {
    const metrics = await db.prepare("SELECT (SELECT COUNT(*) FROM players) AS members, (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM company_api_keys) AS companyKeys, (SELECT COUNT(*) FROM company_snapshots) AS companySnapshots, (SELECT COUNT(*) FROM faction_director_snapshots) AS directorSnapshots, (SELECT COUNT(*) FROM dashboard_member_status WHERE disabled_at IS NOT NULL) AS disabledMembers, (SELECT COUNT(*) FROM admin_jobs WHERE status IN ('queued','running')) AS activeJobs, (SELECT COUNT(*) FROM admin_jobs WHERE status = 'failed') AS failedJobs, (SELECT MAX(fetched_at) FROM companies) AS latestCompanyRefresh").first<Record<string, unknown>>()
    const recent = await db.prepare("SELECT id, actor_player_id AS actorPlayerId, actor_player_name AS actorPlayerName, action, target_type AS targetType, target_id AS targetId, outcome, summary, created_at AS createdAt FROM admin_audit_log ORDER BY id DESC LIMIT 8").all<Record<string, unknown>>()
    return jsonResponse({ metrics: metrics ?? {}, maintenanceMode: await readAdminBoolean(env, "maintenanceMode", false), recentActivity: recent.results ?? [], generatedAt: new Date().toISOString() }, 200, origin)
  }
  if (url.pathname === "/api/admin/members" && request.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100)
    const like = `%${q}%`
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0)
    const base = "FROM players p LEFT JOIN companies c ON c.player_id = p.player_id AND c.fetched_at = (SELECT MAX(c2.fetched_at) FROM companies c2 WHERE c2.player_id = p.player_id) LEFT JOIN faction_member_cache f ON f.player_id = p.player_id AND f.is_director = 1 LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE (? = '' OR p.player_id LIKE ? OR p.player_name LIKE ? OR COALESCE(c.company_name, f.company_name, '') LIKE ?)"
    const [rows, count] = await Promise.all([
      db.prepare(`SELECT p.player_id AS playerId, p.player_name AS playerName, p.created_at AS createdAt, p.updated_at AS updatedAt, COALESCE(c.company_id, f.company_id) AS companyId, COALESCE(c.company_name, f.company_name) AS companyName, COALESCE(c.company_type, f.company_type) AS companyType, f.company_type_id AS companyTypeId, st.disabled_at AS disabledAt, st.disable_reason AS disableReason, (SELECT COUNT(*) FROM api_keys ak WHERE ak.player_id = p.player_id) AS loginKeySaved, (SELECT COUNT(*) FROM company_api_keys cak WHERE cak.player_id = p.player_id) AS companyKeyCount, (SELECT COUNT(*) FROM company_snapshots cs WHERE cs.player_id = p.player_id) AS snapshotCount ${base} ORDER BY p.player_name COLLATE NOCASE LIMIT ? OFFSET ?`).bind(q, like, like, like, limit, offset).all<Record<string, unknown>>(),
      db.prepare(`SELECT COUNT(*) AS total ${base}`).bind(q, like, like, like).first<{ total: number }>(),
    ])
    const members = (rows.results ?? []).map((r) => ({ playerId: String(r.playerId), playerName: String(r.playerName), createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null, companyId: r.companyId == null ? null : String(r.companyId), companyName: r.companyName == null ? null : String(r.companyName), companyType: r.companyType == null ? null : String(r.companyType), companyTypeId: r.companyTypeId ?? null, disabled: r.disabledAt != null, disabledAt: r.disabledAt ?? null, disableReason: r.disableReason ?? null, loginKeySaved: Number(r.loginKeySaved ?? 0) > 0, companyKeyCount: Number(r.companyKeyCount ?? 0), snapshotCount: Number(r.snapshotCount ?? 0) }))
    return jsonResponse({ members, total: Number(count?.total ?? 0), limit, offset }, 200, origin)
  }
  if (memberMatch && request.method === "GET" && !memberMatch[2]) {
    const playerId = memberMatch[1]
    const member = await db.prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, p.created_at AS createdAt, p.updated_at AS updatedAt, st.disabled_at AS disabledAt, st.disable_reason AS disableReason FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.player_id = ?").bind(playerId).first<Record<string, unknown>>()
    if (!member) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin)
    const [companies, counts] = await Promise.all([
      db.prepare("SELECT cak.company_id AS companyId, COALESCE(c.company_name, cak.company_name) AS companyName, COALESCE(c.company_type, cak.company_type) AS companyType, cak.last_four AS lastFour, cak.updated_at AS keyUpdatedAt, c.fetched_at AS fetchedAt FROM company_api_keys cak LEFT JOIN companies c ON c.player_id = cak.player_id AND c.company_id = cak.company_id WHERE cak.player_id = ? ORDER BY cak.updated_at DESC").bind(playerId).all<Record<string, unknown>>(),
      db.prepare("SELECT (SELECT COUNT(*) FROM company_snapshots WHERE player_id = ?) AS companySnapshots, (SELECT COUNT(*) FROM faction_director_snapshots WHERE player_id = ?) AS directorSnapshots, (SELECT COUNT(*) FROM user_page_data WHERE player_id = ?) AS pageRecords, (SELECT COUNT(*) FROM company_financials WHERE player_id = ?) AS financialRecords, (SELECT COUNT(*) FROM api_keys WHERE player_id = ?) AS loginKeyCount, (SELECT COUNT(*) FROM company_keys WHERE player_id = ?) AS legacyCompanyKeyCount").bind(playerId, playerId, playerId, playerId, playerId, playerId).first<Record<string, unknown>>(),
    ])
    const profile = await db.prepare("SELECT company_id AS companyId, company_name AS companyName, company_type AS companyType, fetched_at AS fetchedAt FROM companies WHERE player_id = ? ORDER BY fetched_at DESC LIMIT 1").bind(playerId).first<Record<string, unknown>>()
    return jsonResponse({ member: { ...member, disabled: member.disabledAt != null, company: profile ?? null }, connections: { companies: companies.results ?? [], loginKeySaved: Number(counts?.loginKeyCount ?? 0) > 0, legacyCompanyKeySaved: Number(counts?.legacyCompanyKeyCount ?? 0) > 0 }, history: { companySnapshots: Number(counts?.companySnapshots ?? 0), directorSnapshots: Number(counts?.directorSnapshots ?? 0), pageRecords: Number(counts?.pageRecords ?? 0), financialRecords: Number(counts?.financialRecords ?? 0) } }, 200, origin)
  }
  if (memberMatch && memberMatch[2] === "status" && request.method === "POST") {
    const targetId = memberMatch[1]
    if (targetId === ADMIN_PLAYER_ID) return jsonResponse({ error: "The primary administrator account cannot be disabled from the admin panel." }, 409, origin)
    const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(targetId).first<{ player_id: string }>()
    if (!target) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin)
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body) || typeof body.disabled !== "boolean") return jsonResponse({ error: "Choose whether to disable or restore this member." }, 400, origin)
    const disabled = body.disabled
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 180) : ""
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO dashboard_member_status (player_id, disabled_at, disabled_by, disable_reason, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET disabled_at = excluded.disabled_at, disabled_by = excluded.disabled_by, disable_reason = excluded.disable_reason, updated_at = excluded.updated_at").bind(targetId, disabled ? now : null, disabled ? session.player_id : null, disabled ? reason || "Disabled by dashboard administrator." : null, now).run()
    if (disabled) await db.prepare("DELETE FROM sessions WHERE player_id = ?").bind(targetId).run()
    await writeAdminAudit(env, session, disabled ? "member.disabled" : "member.restored", "member", targetId, "succeeded", disabled ? "Dashboard member access disabled and active sessions revoked." : "Dashboard member access restored.", { reason: disabled ? reason : null, sessionsRevoked: disabled })
    return jsonResponse({ playerId: targetId, disabled, sessionsRevoked: disabled, updatedAt: now }, 200, origin)
  }
  if (memberMatch && (memberMatch[2] === "connection-test" || memberMatch[2] === "connection-repair") && request.method === "POST") {
    const targetId = memberMatch[1]
    const body: unknown = await request.json().catch(() => null)
    const requestedCompanyId = isRecord(body) && (typeof body.companyId === "string" || typeof body.companyId === "number") ? String(body.companyId) : ""
    const isRepair = memberMatch[2] === "connection-repair"
    try {
      let apiKey = requestedCompanyId ? await savedCompanyApiKey(env, targetId, requestedCompanyId) : null
      if (!apiKey && !requestedCompanyId) apiKey = await savedCompanyKey(env, targetId)
      if (!apiKey) apiKey = await savedKey(env, targetId)
      if (!apiKey) return jsonResponse({ error: "No saved credential is available for this account. Ask the member to reconnect; never request their key in chat." }, 409, origin)
      const validated = await validateCompanyKey(apiKey)
      if (requestedCompanyId && String(validated.companyId) !== requestedCompanyId) throw new Error("The saved credential returned a different company ID. No data was changed.")
      if (isRepair) await persistCompanyConnection(env, targetId, apiKey, validated, false)
      const root = companyProfileRoot(validated.profile)
      const summary = { playerId: targetId, companyId: String(validated.companyId), companyName: typeof root.name === "string" ? root.name : `Company #${validated.companyId}`, profileValid: true, employeesAvailable: validated.employees !== null, stockAvailable: validated.stock !== null, repaired: isRepair, checkedAt: new Date().toISOString() }
      await writeAdminAudit(env, session, isRepair ? "connection.repaired" : "connection.tested", "member", targetId, "succeeded", isRepair ? "Company connection validated and saved." : "Saved company connection test passed.", { companyId: String(validated.companyId) })
      return jsonResponse(summary, 200, origin)
    } catch (error) {
      await writeAdminAudit(env, session, isRepair ? "connection.repair_failed" : "connection.test_failed", "member", targetId, "failed", isRepair ? "Company connection repair failed." : "Saved company connection test failed.", { companyId: requestedCompanyId || null, error: error instanceof Error ? error.message.slice(0, 180) : "Unknown error" })
      return jsonResponse({ error: error instanceof Error ? error.message : "Company connection could not be verified." }, 502, origin)
    }
  }
  if (url.pathname === "/api/admin/jobs" && request.method === "GET") {
    const rows = await db.prepare("SELECT job_id AS jobId, job_type AS jobType, target_player_id AS targetPlayerId, target_company_id AS targetCompanyId, job_payload_json AS jobPayloadJson, status, requested_by AS requestedBy, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, result_json AS resultJson, error_message AS errorMessage FROM admin_jobs ORDER BY created_at DESC LIMIT ?").bind(limit).all<Record<string, unknown>>()
    return jsonResponse({ jobs: (rows.results ?? []).map((row) => ({ ...row, refreshConfig: parseStoredJson(row.jobPayloadJson), result: parseStoredJson(row.resultJson), jobPayloadJson: undefined, resultJson: undefined })) }, 200, origin)
  }
  if (url.pathname === "/api/admin/jobs" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body) || (body.jobType !== "global-refresh" && body.jobType !== "company-refresh" && body.jobType !== "endpoint-refresh")) return jsonResponse({ error: "Choose a supported administrative job type." }, 400, origin)
    if (!await readAdminBoolean(env, "manualRefreshEnabled", true)) return jsonResponse({ error: "Manual refresh operations are disabled in global settings." }, 409, origin)
    let refreshConfig: AdminEndpointRefreshConfig | null = null
    if (body.jobType === "endpoint-refresh") {
      if (!Array.isArray(body.endpoints) || !body.endpoints.length || body.endpoints.length > ADMIN_REFRESH_ENDPOINTS.length) {
        return jsonResponse({ error: "Choose one or more supported endpoint refresh targets." }, 400, origin)
      }
      const endpoints = Array.from(new Set(body.endpoints.filter((item): item is AdminRefreshEndpoint => typeof item === "string" && ADMIN_REFRESH_ENDPOINTS.includes(item as AdminRefreshEndpoint))))
      if (endpoints.length !== body.endpoints.length) return jsonResponse({ error: "One or more selected refresh endpoints are unsupported." }, 400, origin)
      const scope = body.scope === "selected" ? "selected" : body.scope === "all" ? "all" : null
      if (!scope) return jsonResponse({ error: "Choose whether to refresh all users or selected users." }, 400, origin)
      const userEndpoints = endpoints.some((endpoint) => endpoint === "company-profile" || endpoint === "company-employees" || endpoint === "company-stock")
      const rawIds = Array.isArray(body.targetPlayerIds) ? body.targetPlayerIds : []
      if (rawIds.length > 100) return jsonResponse({ error: "Select no more than 100 dashboard users per job. Run another job for additional users." }, 400, origin)
      const targetPlayerIds = Array.from(new Set(rawIds.map((value) => positiveId(value)).filter((value): value is string => Boolean(value))))
      if (scope === "selected" && userEndpoints && (!targetPlayerIds.length || targetPlayerIds.length !== new Set(rawIds).size)) {
        return jsonResponse({ error: "Selected-user refreshes require valid dashboard user IDs." }, 400, origin)
      }
      if (scope === "all" && targetPlayerIds.length) return jsonResponse({ error: "Do not include selected user IDs when the refresh scope is all users." }, 400, origin)
      if (scope === "selected" && userEndpoints) {
        const placeholders = targetPlayerIds.map(() => "?").join(",")
        const found = await db.prepare("SELECT player_id FROM players WHERE player_id IN (" + placeholders + ")").bind(...targetPlayerIds).all<{ player_id: string }>()
        if ((found.results ?? []).length !== targetPlayerIds.length) return jsonResponse({ error: "One or more selected dashboard users do not exist." }, 404, origin)
      }
      refreshConfig = { endpoints, scope, targetPlayerIds: scope === "selected" ? targetPlayerIds : [] }
    }
    const targetPlayerId = body.jobType === "company-refresh" ? positiveId(body.targetPlayerId) : null
    const targetCompanyId = body.jobType === "company-refresh" ? positiveId(body.targetCompanyId) : null
    if (body.jobType === "company-refresh" && (!targetPlayerId || !targetCompanyId)) return jsonResponse({ error: "Select a member and one of their saved company IDs for a company refresh." }, 400, origin)
    if (targetPlayerId) {
      const target = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(targetPlayerId).first<{ player_id: string }>()
      if (!target) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin)
    }
    const payloadJson = refreshConfig ? asJson(refreshConfig) : null
    const duplicate = await db.prepare("SELECT job_id FROM admin_jobs WHERE status IN ('queued','running') AND job_type = ? AND COALESCE(target_player_id,'') = ? AND COALESCE(target_company_id,'') = ? AND COALESCE(job_payload_json,'') = COALESCE(?, '') LIMIT 1").bind(body.jobType, targetPlayerId ? String(targetPlayerId) : "", targetCompanyId ? String(targetCompanyId) : "", payloadJson).first<{ job_id: string }>()
    if (duplicate) return jsonResponse({ error: "An equivalent refresh job is already queued or running.", jobId: duplicate.job_id }, 409, origin)
    const jobId = randomToken().slice(0, 20)
    const now = new Date().toISOString()
    await db.prepare("INSERT INTO admin_jobs (job_id, job_type, target_player_id, target_company_id, job_payload_json, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)").bind(jobId, body.jobType, targetPlayerId ? String(targetPlayerId) : null, targetCompanyId ? String(targetCompanyId) : null, payloadJson, session.player_id, now).run()
    await writeAdminAudit(env, session, "job.queued", "job", jobId, "succeeded", "Queued " + body.jobType + ".", refreshConfig ? { endpoints: refreshConfig.endpoints, scope: refreshConfig.scope, targetPlayerCount: refreshConfig.targetPlayerIds.length } : { targetPlayerId: targetPlayerId ? String(targetPlayerId) : null, targetCompanyId: targetCompanyId ? String(targetCompanyId) : null })
    const task = runAdminJob(env, jobId)
    if (ctx?.waitUntil) ctx.waitUntil(task)
    else await task
    return jsonResponse({ jobId, status: "queued", createdAt: now }, 202, origin)
  }
  if (url.pathname === "/api/admin/settings" && request.method === "GET") {
    const rows = await db.prepare("SELECT setting_key AS settingKey, value_json AS valueJson, updated_at AS updatedAt, updated_by AS updatedBy FROM admin_settings").all<Record<string, unknown>>()
    const settings: Record<string, boolean> = { maintenanceMode: false, manualRefreshEnabled: true, historyImportEnabled: true }
    for (const row of rows.results ?? []) {
      if (row.settingKey === "maintenanceMode" || row.settingKey === "manualRefreshEnabled" || row.settingKey === "historyImportEnabled") {
        const value = parseStoredJson(row.valueJson)
        if (typeof value === "boolean") settings[String(row.settingKey)] = value
      }
    }
    return jsonResponse({ settings, updatedAt: new Date().toISOString() }, 200, origin)
  }
  if (url.pathname === "/api/admin/settings" && request.method === "POST") {
    const body: unknown = await request.json().catch(() => null)
    if (!isRecord(body) || !isRecord(body.settings)) return jsonResponse({ error: "Provide a settings object." }, 400, origin)
    const allowed = ["maintenanceMode", "manualRefreshEnabled", "historyImportEnabled"] as const
    const unknown = Object.keys(body.settings).filter((key) => !allowed.includes(key as typeof allowed[number]))
    if (unknown.length) return jsonResponse({ error: `Unsupported settings: ${unknown.join(", ")}.` }, 400, origin)
    for (const key of allowed) {
      if (body.settings[key] !== undefined && typeof body.settings[key] !== "boolean") return jsonResponse({ error: `Setting ${key} must be true or false.` }, 400, origin)
    }
    const changed: string[] = []
    for (const key of allowed) {
      if (body.settings[key] === undefined) continue
      await db.prepare("INSERT INTO admin_settings (setting_key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by").bind(key, JSON.stringify(body.settings[key]), new Date().toISOString(), session.player_id).run()
      changed.push(key)
    }
    await writeAdminAudit(env, session, "settings.updated", "settings", "global", "succeeded", "Updated global dashboard settings.", { changed })
    return jsonResponse({ saved: true, changed, settings: { maintenanceMode: await readAdminBoolean(env, "maintenanceMode", false), manualRefreshEnabled: await readAdminBoolean(env, "manualRefreshEnabled", true), historyImportEnabled: await readAdminBoolean(env, "historyImportEnabled", true) } }, 200, origin)
  }
  if (url.pathname === "/api/admin/history/summary" && request.method === "GET") {
    const stats = await db.prepare("SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM company_financials) AS financialRecords, (SELECT COUNT(*) FROM company_snapshots) AS companySnapshots, (SELECT COUNT(*) FROM faction_director_snapshots) AS directorSnapshots, (SELECT COUNT(*) FROM user_page_data) AS pageRecords").first<Record<string, unknown>>()
    const latest = await db.prepare("SELECT MAX(fetched_at) AS latestCompanySnapshot FROM company_snapshots").first<{ latestCompanySnapshot: string | null }>()
    return jsonResponse({ stats: stats ?? {}, latestCompanySnapshot: latest?.latestCompanySnapshot ?? null, backupMode: "owner-matched merge; credentials and sessions excluded" }, 200, origin)
  }
  if (url.pathname === "/api/admin/history/backup" && request.method === "GET") {
    const playerId = positiveId(url.searchParams.get("playerId"))
    if (!playerId) return jsonResponse({ error: "Select a valid dashboard member to export." }, 400, origin)
    try {
      const backup = await adminBackupForPlayer(env, String(playerId))
      await writeAdminAudit(env, session, "history.backup_exported", "member", String(playerId), "succeeded", "Exported a dashboard member backup; credentials and sessions were excluded.", { counts: adminBackupCounts(backup.storage as Record<string, unknown>) })
      return jsonResponse(backup, 200, origin, { "content-disposition": `attachment; filename="ncd-admin-backup-${playerId}.json"` })
    } catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : "Could not export this member's data." }, 404, origin) }
  }
  if (url.pathname === "/api/admin/history/restore" && request.method === "POST") {
    const targetPlayerId = positiveId(url.searchParams.get("playerId"))
    if (!targetPlayerId) return jsonResponse({ error: "Select the dashboard member whose history should be restored." }, 400, origin)
    const restoreTarget = await db.prepare("SELECT player_id FROM players WHERE player_id = ?").bind(String(targetPlayerId)).first<{ player_id: string }>()
    if (!restoreTarget) return jsonResponse({ error: "That dashboard member does not exist." }, 404, origin)
    if (!await readAdminBoolean(env, "historyImportEnabled", true)) return jsonResponse({ error: "History imports and restores are disabled in global settings." }, 409, origin)
    const raw = await request.text()
    if (raw.length > 10_000_000) return jsonResponse({ error: "The JSON backup is too large. Keep imports under 10 MB." }, 413, origin)
    let parsed: unknown
    try { parsed = JSON.parse(raw) as unknown } catch { return jsonResponse({ error: "Upload a valid JSON backup." }, 400, origin) }
    if (!isRecord(parsed) || !isRecord(parsed.player) || String(parsed.player.id ?? "") !== String(targetPlayerId) || !((parsed.format === "naughty-company-dashboard-admin-backup" || parsed.format === "naughty-company-dashboard-backup") && parsed.version === 1) || !isRecord(parsed.storage)) {
      await writeAdminAudit(env, session, "history.restore_rejected", "member", String(targetPlayerId), "failed", "Rejected a backup with an unsupported format or owner mismatch.")
      return jsonResponse({ error: "Backup format or owner does not match the selected dashboard member. The restore was not applied." }, 400, origin)
    }
    const storage = parsed.storage
    const counts = adminBackupCounts(storage)
    const limits: Record<string, number> = { companies: 100, financials: 100, companySnapshots: 10000, directorSnapshots: 10000, pageData: 20, sharingPreferences: 1000 }
    for (const key of Object.keys(limits)) if (Array.isArray(storage[key]) && (storage[key] as unknown[]).length > limits[key]) return jsonResponse({ error: `Backup exceeds the supported ${key} limit.` }, 413, origin)
    if (url.searchParams.get("preview") === "1") {
      await writeAdminAudit(env, session, "history.restore_previewed", "member", String(targetPlayerId), "succeeded", "Validated a dashboard history restore without applying it.", { counts })
      return jsonResponse({ preview: true, targetPlayerId: String(targetPlayerId), counts, warnings: ["Restore merges records and does not delete existing records.", "API credentials, sessions, and administrator settings are excluded.", "Confirm the target Torn ID and backup timestamp before applying."] }, 200, origin)
    }
    const confirmation = request.headers.get("x-admin-confirm-restore")
    if (confirmation !== "yes") return jsonResponse({ error: "Restore requires explicit confirmation after preview." }, 428, origin)
    try {
      const restored = await restoreAdminBackup(env, String(targetPlayerId), parsed)
      await writeAdminAudit(env, session, "history.restore_applied", "member", String(targetPlayerId), "succeeded", "Restored a validated owner-matched backup by merging historical records.", { counts: restored, exportedAt: parsed.exportedAt ?? null })
      return jsonResponse({ restored: true, targetPlayerId: String(targetPlayerId), counts: restored, message: "Backup records were merged. Existing unrelated records, API credentials, and sessions were left intact." }, 200, origin)
    } catch (error) {
      await writeAdminAudit(env, session, "history.restore_failed", "member", String(targetPlayerId), "failed", "A validated history restore failed.", { counts, error: error instanceof Error ? error.message.slice(0, 180) : "Unknown error" })
      return jsonResponse({ error: "Restore could not be completed. Existing records were not intentionally deleted; inspect the audit log before retrying." }, 500, origin)
    }
  }
  if (url.pathname === "/api/admin/audit" && request.method === "GET") {
    const before = Math.max(0, Number(url.searchParams.get("before") || 0) || 0)
    const rows = before ? await db.prepare("SELECT id, actor_player_id AS actorPlayerId, actor_player_name AS actorPlayerName, action, target_type AS targetType, target_id AS targetId, outcome, summary, details_json AS detailsJson, created_at AS createdAt FROM admin_audit_log WHERE id < ? ORDER BY id DESC LIMIT ?").bind(before, limit).all<Record<string, unknown>>() : await db.prepare("SELECT id, actor_player_id AS actorPlayerId, actor_player_name AS actorPlayerName, action, target_type AS targetType, target_id AS targetId, outcome, summary, details_json AS detailsJson, created_at AS createdAt FROM admin_audit_log ORDER BY id DESC LIMIT ?").bind(limit).all<Record<string, unknown>>()
    return jsonResponse({ events: (rows.results ?? []).map((row) => ({ ...row, details: parseStoredJson(row.detailsJson), detailsJson: undefined })) }, 200, origin)
  }
  return jsonResponse({ error: "Administration route not found." }, 404, origin)
}

async function runFiveMinuteScheduledJobs(env: WorkerEnv, scheduledTime: number): Promise<void> {
  // Membership checks, faction performance collection and Halloween snapshots
  // are isolated: one source outage must not suppress the other scheduled work.
  try { await revalidateFactionMembershipBatch(env, scheduledTime) } catch { /* Retry stale members on a later tick. */ }
  try { await enqueueFactionPerformanceCollections(env, scheduledTime) } catch { /* Idempotent schedule buckets retry on a later tick. */ }
  try { await enqueueFactionWeeklyBoundaryRun(env, scheduledTime) } catch { /* The unique Sunday boundary is retried on a later five-minute tick. */ }
  try { await finalizeFactionWeeklyReport(env, utcSundayStart(scheduledTime) - WEEK_MS) } catch { /* Finalization retries after the ending boundary batches reach a terminal state. */ }
  try { await enqueueScheduledHalloweenSnapshots(env, scheduledTime) } catch { /* Retry the next event sweep. */ }
}

export default {
  async queue(batch: { messages: QueueMessage[]; queue?: string }, env: WorkerEnv): Promise<void> {
    await handleGlobalRankingQueueBatch(batch, env)
  },
  async scheduled(controller: { scheduledTime: number; cron: string }, env: WorkerEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    if (controller.cron.trim() === "*/5 * * * *") {
      ctx.waitUntil(runFiveMinuteScheduledJobs(env, controller.scheduledTime))
      return
    }
    ctx.waitUntil(runScheduledAutomation(controller, env))
  },
  async fetch(request: Request, env: WorkerEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const origin = allowedOrigin(request, env)
    if (!origin) return jsonResponse({ error: "Origin not allowed." }, 403)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, X-Admin-Confirm-Restore", "access-control-max-age": "86400", vary: "Origin" } })
    const url = new URL(request.url)
    const adminResponse = await handleAdminRequest(request, env, origin, ctx)
    if (adminResponse) return adminResponse
    const automationResponse = await handleAutomationRequest(request, env, origin)
    if (automationResponse) return automationResponse
    const insightsResponse = await handleUserInsightsRequest(request, env, origin)
    if (insightsResponse) return insightsResponse
    if (url.pathname === "/health" && request.method === "GET") {
      const checkedAt = new Date().toISOString()
      try { await requireDb(env).prepare("SELECT 1 AS ok").first<{ ok: number }>(); return jsonResponse({ ok: true, service: "naughty-company-api", database: "ok", checkedAt }, 200, origin) }
      catch { return jsonResponse({ ok: false, service: "naughty-company-api", database: "error", checkedAt }, 503, origin) }
    }
    if (url.pathname === "/api/auth/sign-in" && request.method === "POST") {
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        if (!apiKey) return jsonResponse({ error: "A Torn API key is required." }, 400, origin)

        // The login key proves the player's identity and Naughty Souls membership.
        // Company permissions are deliberately not part of faction portal sign-in.
        const player = await validateTornKey(apiKey)
        if (player.factionId !== NAUGHTY_SOULS_FACTION_ID) {
          return jsonResponse({ error: "ACCESS DENIED: Naughty Souls faction membership is required." }, 403, origin)
        }
        const db = requireDb(env)
        const memberStatus = await db.prepare("SELECT disabled_at FROM dashboard_member_status WHERE player_id = ?").bind(player.id).first<{ disabled_at: string | null }>()
        if (memberStatus?.disabled_at) return jsonResponse({ error: "Dashboard access for this account has been disabled. Contact the dashboard administrator." }, 403, origin)

        const now = new Date().toISOString()
        await db.prepare("INSERT INTO players (player_id, player_name, created_at, updated_at, faction_id, faction_verified_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET player_name = excluded.player_name, updated_at = excluded.updated_at, faction_id = excluded.faction_id, faction_verified_at = excluded.faction_verified_at").bind(player.id, player.name, now, now, player.factionId, now).run()

        // Bootstrap the original owner ID once. A later explicit revocation is
        // retained because INSERT OR IGNORE never reactivates a revoked row.
        if (player.id === ADMIN_PLAYER_ID) {
          await db.prepare("INSERT OR IGNORE INTO administrators (player_id, granted_by, granted_at) VALUES (?, ?, ?)").bind(player.id, player.id, now).run()
        }
        const adminRole = await db.prepare("SELECT player_id FROM administrators WHERE player_id = ? AND revoked_at IS NULL").bind(player.id).first<{ player_id: string }>()
        if (await readAdminBoolean(env, "maintenanceMode", false) && !adminRole) {
          return jsonResponse({ error: "The dashboard is in maintenance mode. Please try again later." }, 503, origin)
        }

        await saveKey(env, player.id, apiKey)
        const token = randomToken()
        const expiresAt = Math.floor(Date.now() / 1000) + 30 * DAY
        await db.prepare("INSERT INTO sessions (token_hash, player_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), player.id, expiresAt, now).run()
        const meta = await db.prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(player.id).first<{ last_four: string; updated_at: string }>()
        return jsonResponse({
          token,
          expiresAt,
          player,
          isAdmin: Boolean(adminRole),
          key: { saved: true, lastFour: meta?.last_four, updatedAt: meta?.updated_at },
        }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const key = await requireDb(env).prepare("SELECT last_four, updated_at FROM api_keys WHERE player_id = ?").bind(session.player_id).first<{ last_four: string; updated_at: string }>()
      return jsonResponse({
        player: { id: session.player_id, name: session.player_name },
        isAdmin: session.is_admin === 1,
        key: key ? { saved: true, lastFour: key.last_four, updatedAt: key.updated_at } : { saved: false },
      }, 200, origin)
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

    if (url.pathname === "/api/me/private-live/key" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) return jsonResponse({ error: "Private live connections are available only to current Naughty Souls members." }, 403, origin)
      const db = requireDb(env)
      const [key, snapshot] = await Promise.all([
        db.prepare("SELECT last_four, include_networth, share_with_faction, consent_version, consented_at, last_validated_at, last_attempt_at, last_collected_at, last_error, created_at, updated_at FROM member_private_live_keys WHERE player_id = ? AND faction_id = ?")
          .bind(session.player_id, NAUGHTY_SOULS_FACTION_ID).first<Record<string, unknown>>(),
        db.prepare("SELECT captured_at, bars_json, cooldowns_json, networth_json, source_timestamps_json FROM faction_member_private_live_snapshots WHERE player_id = ? AND faction_id = ?")
          .bind(session.player_id, NAUGHTY_SOULS_FACTION_ID).first<Record<string, unknown>>(),
      ])
      return jsonResponse({
        connected: Boolean(key),
        key: key ? {
          lastFour: String(key.last_four ?? ""),
          includeNetworth: Number(key.include_networth) === 1,
          shareWithFaction: Number(key.share_with_faction) === 1,
          consentVersion: String(key.consent_version ?? ""),
          consentedAt: key.consented_at ?? null,
          lastValidatedAt: key.last_validated_at ?? null,
          lastAttemptAt: key.last_attempt_at ?? null,
          lastCollectedAt: key.last_collected_at ?? null,
          lastError: key.last_error ?? null,
          updatedAt: key.updated_at ?? null,
        } : null,
        snapshot: snapshot ? {
          capturedAt: snapshot.captured_at,
          bars: safeStoredJson(snapshot.bars_json),
          cooldowns: safeStoredJson(snapshot.cooldowns_json),
          networth: safeStoredJson(snapshot.networth_json),
          sourceTimestamps: safeStoredJson(snapshot.source_timestamps_json),
        } : null,
      }, 200, origin)
    }

    if (url.pathname === "/api/me/private-live/key" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) return jsonResponse({ error: "Private live connections are available only to current Naughty Souls members." }, 403, origin)
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        const consent = isRecord(body) && body.consent === true
        const shareWithFaction = isRecord(body) && body.shareWithFaction === true
        const consentVersion = isRecord(body) && typeof body.consentVersion === "string" ? body.consentVersion : ""
        const includeNetworth = isRecord(body) && body.includeNetworth === true
        if (!apiKey || apiKey.length > 256 || /\s/.test(apiKey)) return jsonResponse({ error: "Enter a valid Torn API key." }, 400, origin)
        if (!consent || !shareWithFaction || consentVersion !== "faction-private-live-v1") {
          return jsonResponse({ error: "Review and accept the private live data-sharing terms before connecting your key." }, 400, origin)
        }

        // Never trust a player ID supplied in the request. The key must belong
        // to the already-authenticated session owner before any data is read.
        await validatePrivateLiveKeyOwner(apiKey, session.player_id)
        const live = await fetchPrivateLiveBase(apiKey)
        let networth: ReturnType<typeof parsePrivateLiveNetworth> | null = null
        let networthSourceTimestamp: number | null = null
        let networthWarning: string | null = null
        if (includeNetworth) {
          try {
            const networthPayload = await fetchPrivateLiveSelection(apiKey, "networth")
            networth = parsePrivateLiveNetworth(networthPayload)
            if (isRecord(networthPayload) && typeof networthPayload.timestamp === "number" && Number.isFinite(networthPayload.timestamp)) {
              networthSourceTimestamp = networthPayload.timestamp
            }
          } catch (error) {
            if (error instanceof TornApiClientError && error.code === 16) {
              includeNetworth = false
              networthWarning = "Torn did not grant this key access to detailed networth. Bars and cooldowns were connected; optional networth was left off."
            } else throw error
          }
        }

        const encrypted = await encryptKey(env, apiKey)
        const now = new Date().toISOString()
        const db = requireDb(env)
        await db.prepare("INSERT INTO member_private_live_keys (player_id, faction_id, ciphertext, iv, last_four, include_networth, share_with_faction, consent_version, consented_at, last_validated_at, last_attempt_at, last_collected_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(player_id) DO UPDATE SET faction_id = excluded.faction_id, ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, include_networth = excluded.include_networth, share_with_faction = 1, consent_version = excluded.consent_version, consented_at = excluded.consented_at, last_validated_at = excluded.last_validated_at, last_attempt_at = excluded.last_attempt_at, last_collected_at = excluded.last_collected_at, last_error = NULL, updated_at = excluded.updated_at")
          .bind(session.player_id, NAUGHTY_SOULS_FACTION_ID, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), includeNetworth ? 1 : 0, "faction-private-live-v1", now, now, now, now, now, now).run()
        await db.prepare("INSERT INTO faction_member_private_live_snapshots (player_id, faction_id, captured_at, bars_json, cooldowns_json, networth_json, source_timestamps_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET faction_id = excluded.faction_id, captured_at = excluded.captured_at, bars_json = excluded.bars_json, cooldowns_json = excluded.cooldowns_json, networth_json = excluded.networth_json, source_timestamps_json = excluded.source_timestamps_json")
          .bind(session.player_id, NAUGHTY_SOULS_FACTION_ID, now, asJson(live.bars), asJson(live.cooldowns), networth ? asJson(networth) : null, asJson({ capturedAt: now, networthSourceTimestamp })).run()
        return jsonResponse({
          saved: true,
          connected: true,
          lastFour: apiKey.slice(-4),
          includeNetworth,
          shareWithFaction: true,
          warning: networthWarning,
          consentedAt: now,
          capturedAt: now,
        }, 200, origin)
      } catch (error) {
        return tornError(error, origin)
      }
    }

    if (url.pathname === "/api/me/private-live/refresh" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) return jsonResponse({ error: "Private live connections are available only to current Naughty Souls members." }, 403, origin)
      const db = requireDb(env)
      const key = await db.prepare("SELECT ciphertext, iv, include_networth FROM member_private_live_keys WHERE player_id = ? AND faction_id = ? AND share_with_faction = 1")
        .bind(session.player_id, NAUGHTY_SOULS_FACTION_ID).first<{ ciphertext: string; iv: string; include_networth: number }>()
      if (!key) return jsonResponse({ error: "Connect your own private live Torn key before refreshing." }, 404, origin)
      const nowMs = Date.now()
      const now = new Date(nowMs).toISOString()
      const claimBefore = new Date(nowMs - 30 * 1000).toISOString()
      const claim = await db.prepare("UPDATE member_private_live_keys SET last_attempt_at = ?, last_error = NULL, updated_at = ? WHERE player_id = ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?)")
        .bind(now, now, session.player_id, claimBefore).run()
      if (Number(claim.meta?.changes ?? 0) < 1) {
        return jsonResponse({ error: "Private live data was refreshed recently. Please wait 30 seconds before trying again." }, 429, origin, { "retry-after": "30" })
      }
      try {
        const apiKey = await decryptKey(env, key.ciphertext, key.iv)
        const live = await fetchPrivateLiveBase(apiKey)
        let includeNetworth = Number(key.include_networth) === 1
        let networth: ReturnType<typeof parsePrivateLiveNetworth> | null = null
        let networthSourceTimestamp: number | null = null
        let networthWarning: string | null = null
        if (includeNetworth) {
          try {
            const networthPayload = await fetchPrivateLiveSelection(apiKey, "networth")
            networth = parsePrivateLiveNetworth(networthPayload)
            if (isRecord(networthPayload) && typeof networthPayload.timestamp === "number" && Number.isFinite(networthPayload.timestamp)) {
              networthSourceTimestamp = networthPayload.timestamp
            }
          } catch (error) {
            if (error instanceof TornApiClientError && error.code === 16) {
              includeNetworth = false
              networthWarning = "The key no longer has networth access. Bars and cooldowns remain connected; optional detailed networth was switched off."
            } else throw error
          }
        }
        const capturedAt = new Date().toISOString()
        await db.prepare("INSERT INTO faction_member_private_live_snapshots (player_id, faction_id, captured_at, bars_json, cooldowns_json, networth_json, source_timestamps_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET faction_id = excluded.faction_id, captured_at = excluded.captured_at, bars_json = excluded.bars_json, cooldowns_json = excluded.cooldowns_json, networth_json = excluded.networth_json, source_timestamps_json = excluded.source_timestamps_json")
          .bind(session.player_id, NAUGHTY_SOULS_FACTION_ID, capturedAt, asJson(live.bars), asJson(live.cooldowns), networth ? asJson(networth) : null, asJson({ capturedAt, networthSourceTimestamp })).run()
        await db.prepare("UPDATE member_private_live_keys SET include_networth = ?, last_validated_at = ?, last_collected_at = ?, last_error = NULL, updated_at = ? WHERE player_id = ?")
          .bind(includeNetworth ? 1 : 0, capturedAt, capturedAt, capturedAt, session.player_id).run()
        return jsonResponse({ refreshed: true, capturedAt, includeNetworth, warning: networthWarning }, 200, origin)
      } catch (error) {
        const safe = privateLiveSafeError(error)
        if (privateLiveKeyMustBeRevoked(error)) {
          await db.prepare("DELETE FROM faction_member_private_live_snapshots WHERE player_id = ?").bind(session.player_id).run()
          await db.prepare("DELETE FROM member_private_live_keys WHERE player_id = ?").bind(session.player_id).run()
          return jsonResponse({ connected: false, error: safe.message + " The saved private live key was disconnected." }, safe.status, origin)
        }
        await db.prepare("UPDATE member_private_live_keys SET last_error = ?, updated_at = ? WHERE player_id = ?")
          .bind(safe.message, new Date().toISOString(), session.player_id).run().catch(() => undefined)
        return jsonResponse({ error: safe.message }, safe.status, origin)
      }
    }

    if (url.pathname === "/api/me/private-live/key" && request.method === "DELETE") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      await requireDb(env).prepare("DELETE FROM faction_member_private_live_snapshots WHERE player_id = ?").bind(session.player_id).run()
      await requireDb(env).prepare("DELETE FROM member_private_live_keys WHERE player_id = ?").bind(session.player_id).run()
      return jsonResponse({ disconnected: true, factionSnapshotRemoved: true }, 200, origin)
    }

    if (url.pathname === "/api/me/halloween/key" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const row = await requireDb(env).prepare("SELECT last_four, access_level, consent_version, consented_at, last_validated_at, created_at, updated_at FROM halloween_historical_keys WHERE player_id = ?")
        .bind(session.player_id).first<{ last_four: string; access_level: string; consent_version: string; consented_at: string; last_validated_at: string; created_at: string; updated_at: string }>()
      return jsonResponse({ connected: Boolean(row), key: row ? { lastFour: row.last_four, accessLevel: row.access_level, consentVersion: row.consent_version, consentedAt: row.consented_at, lastValidatedAt: row.last_validated_at, updatedAt: row.updated_at } : null }, 200, origin)
    }
    if (url.pathname === "/api/me/halloween/key" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      try {
        const body: unknown = await request.json().catch(() => null)
        const apiKey = isRecord(body) && typeof body.apiKey === "string" ? body.apiKey.trim() : ""
        const consent = isRecord(body) && body.consent === true
        const consentVersion = isRecord(body) && typeof body.consentVersion === "string" ? body.consentVersion : ""
        if (!apiKey) return jsonResponse({ error: "A Full Access Torn API key is required." }, 400, origin)
        if (!consent || consentVersion !== "halloween-history-v1") return jsonResponse({ error: "Please review and accept the historical Halloween data-sharing terms before saving this key." }, 400, origin)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 12000)
        let payload: unknown
        let response: Response
        try {
          response = await fetch("https://api.torn.com/v2/key/info", {
            headers: { Authorization: "ApiKey " + apiKey, Accept: "application/json" },
            signal: controller.signal,
          })
          payload = await response.json().catch(() => null)
        } finally { clearTimeout(timeout) }
        const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null
        if (!response.ok || error) {
          const code = typeof error?.code === "number" ? error.code : undefined
          return jsonResponse({ error: code === 9 ? "Torn's API is temporarily unavailable or rate limited. Please retry later." : "Torn could not validate that API key. Check the key and try again." }, code === 9 ? 429 : 400, origin)
        }
        const root = isRecord(payload) && isRecord(payload.info) ? payload.info : null
        const keyOwner = isRecord(root?.user) ? root.user.id : undefined
        const access = isRecord(root?.access) ? root.access : null
        const selections = isRecord(root?.selections) ? root.selections : null
        const userSelections = Array.isArray(selections?.user) ? selections.user : []
        if (String(keyOwner ?? "") !== session.player_id) return jsonResponse({ error: "That key belongs to a different Torn player. Use a key created on your own account." }, 403, origin)
        if (access?.type !== "Full Access" || !userSelections.includes("log")) return jsonResponse({ error: "Historical Halloween log collection requires your own Full Access key with user log access. Custom Access keys are not accepted." }, 400, origin)
        const encrypted = await encryptKey(env, apiKey)
        const now = new Date().toISOString()
        await requireDb(env).prepare("INSERT INTO halloween_historical_keys (player_id, ciphertext, iv, last_four, access_level, consent_version, consented_at, last_validated_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'Full Access', ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, last_four = excluded.last_four, access_level = 'Full Access', consent_version = excluded.consent_version, consented_at = excluded.consented_at, last_validated_at = excluded.last_validated_at, updated_at = excluded.updated_at")
          .bind(session.player_id, encrypted.ciphertext, encrypted.iv, apiKey.slice(-4), "halloween-history-v1", now, now, now, now).run()
        return jsonResponse({ saved: true, lastFour: apiKey.slice(-4), accessLevel: "Full Access", consentedAt: now, lastValidatedAt: now }, 200, origin)
      } catch (error) { return tornError(error, origin) }
    }
    if (url.pathname === "/api/me/halloween/key" && request.method === "DELETE") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      await requireDb(env).prepare("DELETE FROM halloween_historical_keys WHERE player_id = ?").bind(session.player_id).run()
      await requireDb(env).prepare("UPDATE halloween_collection_jobs SET status = 'cancelled', last_error = ?, updated_at = ? WHERE player_id = ? AND status IN ('queued', 'running')")
        .bind("The member disconnected their historical Full Access key.", new Date().toISOString(), session.player_id).run()
      return jsonResponse({ deleted: true, historicalRecordsRetained: true }, 200, origin)
    }
    if (url.pathname === "/api/me/halloween/event-window" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const yearValue = Number(url.searchParams.get("year") || new Date().getUTCFullYear())
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100) return jsonResponse({ error: "A valid Halloween event year is required." }, 400, origin)
      const personal = await getHalloweenMemberEventWindow(env, session.player_id, yearValue)
      if (!personal) return jsonResponse({ error: "No Halloween event window is configured for that year." }, 404, origin)
      const db = requireDb(env)
      const [job, snapshot, liveJob, log] = await Promise.all([
        db.prepare("SELECT job_id FROM halloween_collection_jobs WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ job_id: string }>(),
        db.prepare("SELECT captured_at FROM halloween_live_snapshots WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ captured_at: string }>(),
        db.prepare("SELECT job_id FROM halloween_live_snapshot_jobs WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ job_id: string }>(),
        db.prepare("SELECT log_id FROM halloween_event_logs WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ log_id: string }>(),
      ])
      return jsonResponse({
        event: { eventYear: personal.event.eventYear, calendarStartAt: personal.event.startAt, calendarEndAt: personal.event.endAt },
        myWindow: personal.window,
        locked: Boolean(job || snapshot || liveJob || log),
        timeZone: "TCT (UTC)",
      }, 200, origin)
    }
    if (url.pathname === "/api/me/halloween/event-window" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const body: unknown = await request.json().catch(() => null)
      const yearValue = isRecord(body) ? Number(body.year) : Number.NaN
      const startTime = isRecord(body) && typeof body.startTime === "string" ? body.startTime : ""
      const timeMatch = startTime.match(/^(\d{2}):(\d{2})$/)
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100 || !timeMatch) return jsonResponse({ error: "Choose a valid event year and start time." }, 400, origin)
      const startMinuteOfDay = Number(timeMatch[1]) * 60 + Number(timeMatch[2])
      if (startMinuteOfDay < 600 || startMinuteOfDay > 960 || startMinuteOfDay % 15 !== 0) {
        return jsonResponse({ error: "Start times must be between 10:00 and 16:00 TCT in 15-minute increments." }, 400, origin)
      }
      const db = requireDb(env)
      const event = await db.prepare("SELECT event_year AS eventYear, start_at AS startAt, end_at AS endAt FROM halloween_event_windows WHERE event_year = ?")
        .bind(yearValue).first<HalloweenEventDefinition>()
      if (!event) return jsonResponse({ error: "No Halloween event window is configured for that year." }, 404, origin)
      let personalWindow: HalloweenMemberEventWindow
      try { personalWindow = buildHalloweenMemberEventWindow(event, startMinuteOfDay) }
      catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : "The event window is invalid." }, 409, origin) }
      const existingSlot = await db.prepare("SELECT start_minute_of_day AS startMinuteOfDay FROM halloween_member_event_slots WHERE player_id = ? AND event_year = ?")
        .bind(session.player_id, yearValue).first<{ startMinuteOfDay: number }>()
      const [job, snapshot, liveJob, log] = await Promise.all([
        db.prepare("SELECT job_id FROM halloween_collection_jobs WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ job_id: string }>(),
        db.prepare("SELECT captured_at FROM halloween_live_snapshots WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ captured_at: string }>(),
        db.prepare("SELECT job_id FROM halloween_live_snapshot_jobs WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ job_id: string }>(),
        db.prepare("SELECT log_id FROM halloween_event_logs WHERE player_id = ? AND event_year = ? LIMIT 1").bind(session.player_id, yearValue).first<{ log_id: string }>(),
      ])
      if (job || snapshot || liveJob || log) {
        if (Number(existingSlot?.startMinuteOfDay) === startMinuteOfDay) return jsonResponse({ saved: true, locked: true, myWindow: personalWindow }, 200, origin)
        return jsonResponse({ error: "Your event time is locked because collection or snapshot capture has already started. Contact an administrator to correct it safely." }, 409, origin)
      }
      const now = new Date().toISOString()
      await db.prepare("INSERT INTO halloween_member_event_slots (event_year, player_id, start_minute_of_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_year, player_id) DO UPDATE SET start_minute_of_day = excluded.start_minute_of_day, updated_at = excluded.updated_at")
        .bind(yearValue, session.player_id, startMinuteOfDay, now, now).run()
      return jsonResponse({ saved: true, locked: false, myWindow: personalWindow }, 200, origin)
    }
    if (url.pathname === "/api/me/halloween/live" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const yearValue = Number(url.searchParams.get("year") || new Date().getUTCFullYear())
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100) return jsonResponse({ error: "A valid Halloween event year is required." }, 400, origin)
      const db = requireDb(env)
      const event = await db.prepare("SELECT event_year AS eventYear, start_at AS startAt, end_at AS endAt, live_collection_enabled AS liveCollectionEnabled FROM halloween_event_windows WHERE event_year = ?")
        .bind(yearValue).first<{ eventYear: number; startAt: string; endAt: string; liveCollectionEnabled: number }>()
      if (!event) return jsonResponse({ error: "No Halloween event window is configured for that year." }, 404, origin)
      const rows = await db.prepare(
        "SELECT p.player_id AS playerId, p.player_name AS playerName, es.start_minute_of_day AS startMinuteOfDay, (SELECT s.treats_current FROM halloween_live_snapshots s WHERE s.event_year = ? AND s.player_id = p.player_id ORDER BY s.captured_at DESC LIMIT 1) AS treatsCurrent, (SELECT s.treats_total FROM halloween_live_snapshots s WHERE s.event_year = ? AND s.player_id = p.player_id ORDER BY s.captured_at DESC LIMIT 1) AS treatsTotal, (SELECT s.upgrades_json FROM halloween_live_snapshots s WHERE s.event_year = ? AND s.player_id = p.player_id ORDER BY s.captured_at DESC LIMIT 1) AS upgradesJson, (SELECT s.captured_at FROM halloween_live_snapshots s WHERE s.event_year = ? AND s.player_id = p.player_id ORDER BY s.captured_at DESC LIMIT 1) AS capturedAt, (SELECT s.snapshot_kind FROM halloween_live_snapshots s WHERE s.event_year = ? AND s.player_id = p.player_id ORDER BY s.captured_at DESC LIMIT 1) AS snapshotKind, (SELECT s.source_timestamp FROM halloween_live_snapshots s WHERE s.event_year = ? AND s.player_id = p.player_id ORDER BY s.captured_at DESC LIMIT 1) AS sourceTimestamp FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id LEFT JOIN halloween_member_event_slots es ON es.player_id = p.player_id AND es.event_year = ? WHERE p.faction_id = ? AND st.disabled_at IS NULL"
      ).bind(yearValue, yearValue, yearValue, yearValue, yearValue, yearValue, yearValue, NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>()
      const leaderboard = (rows.results ?? []).map((row) => {
        const memberWindow = row.startMinuteOfDay == null ? null : buildHalloweenMemberEventWindow(event, Number(row.startMinuteOfDay))
        const snapshotMs = row.capturedAt == null ? Number.NaN : Date.parse(String(row.capturedAt))
        const hasSnapshotInWindow = Boolean(memberWindow?.startAt && memberWindow.endAt && Number.isFinite(snapshotMs) && snapshotMs >= Date.parse(memberWindow.startAt) && snapshotMs < Date.parse(memberWindow.endAt))
        let upgrades: unknown[] | null = null
        if (hasSnapshotInWindow && row.upgradesJson != null) {
          try { const parsed = JSON.parse(String(row.upgradesJson)); upgrades = Array.isArray(parsed) ? parsed : null } catch { upgrades = null }
        }
        return {
          playerId: String(row.playerId),
          playerName: String(row.playerName),
          eventWindowConfigured: Boolean(memberWindow),
          startTime: memberWindow?.startTime ?? null,
          eventStartAt: memberWindow?.startAt ?? null,
          eventEndAt: memberWindow?.endAt ?? null,
          currentTreats: hasSnapshotInWindow && row.treatsCurrent != null ? Number(row.treatsCurrent) : null,
          totalTreats: hasSnapshotInWindow && row.treatsTotal != null ? Number(row.treatsTotal) : null,
          upgradesUnlocked: upgrades === null ? null : upgrades.length,
          upgrades,
          capturedAt: hasSnapshotInWindow ? row.capturedAt : null,
          snapshotKind: hasSnapshotInWindow ? row.snapshotKind : null,
          sourceTimestamp: hasSnapshotInWindow && row.sourceTimestamp != null ? Number(row.sourceTimestamp) : null,
          coverage: hasSnapshotInWindow ? "captured" : "not_collected",
        }
      }).sort((a, b) => (b.totalTreats ?? -1) - (a.totalTreats ?? -1) || a.playerName.localeCompare(b.playerName))
      const personal = await getHalloweenMemberEventWindow(env, session.player_id, yearValue)
      return jsonResponse({ event, myWindow: personal?.window ?? null, leaderboard, mySnapshot: leaderboard.find((row) => row.playerId === session.player_id) ?? null }, 200, origin)
    }
    if (url.pathname === "/api/me/halloween/live-snapshot" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const body: unknown = await request.json().catch(() => null)
      const yearValue = isRecord(body) ? Number(body.year) : new Date().getUTCFullYear()
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100) return jsonResponse({ error: "A valid Halloween event year is required." }, 400, origin)
      try {
        const snapshot = await runHalloweenLiveSnapshot(env, session.player_id, yearValue, "manual")
        return jsonResponse({ captured: true, snapshot }, 200, origin)
      } catch (error) { return jsonResponse({ error: error instanceof Error ? error.message : "Could not capture the Halloween summary." }, 409, origin) }
    }
    if (url.pathname === "/api/me/halloween/archive" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const db = requireDb(env)
      const yearValue = Number(url.searchParams.get("year") || new Date().getUTCFullYear())
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100) return jsonResponse({ error: "A valid Halloween event year is required." }, 400, origin)
      const event = await db.prepare("SELECT event_year AS eventYear, start_at AS startAt, end_at AS endAt FROM halloween_event_windows WHERE event_year = ?")
        .bind(yearValue).first<{ eventYear: number; startAt: string; endAt: string }>()
      if (!event) return jsonResponse({ error: "No Halloween event window is configured for that year." }, 404, origin)
      const members = await db.prepare(
        "SELECT p.player_id AS playerId, p.player_name AS playerName, es.start_minute_of_day AS startMinuteOfDay, EXISTS(SELECT 1 FROM halloween_historical_keys k WHERE k.player_id = p.player_id) AS keyConnected, (SELECT j.status FROM halloween_collection_jobs j WHERE j.player_id = p.player_id AND j.event_year = ? ORDER BY j.updated_at DESC LIMIT 1) AS collectionStatus, (SELECT j.pages_collected FROM halloween_collection_jobs j WHERE j.player_id = p.player_id AND j.event_year = ? ORDER BY j.updated_at DESC LIMIT 1) AS pagesCollected, (SELECT COUNT(*) FROM halloween_event_logs l WHERE l.event_year = ? AND l.player_id = p.player_id) AS storedLogCount, (SELECT COALESCE(SUM(l.is_hit), 0) FROM halloween_event_logs l WHERE l.event_year = ? AND l.player_id = p.player_id) AS storedHitCount, (SELECT MAX(l.collected_at) FROM halloween_event_logs l WHERE l.event_year = ? AND l.player_id = p.player_id) AS lastCollectedAt FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id LEFT JOIN halloween_member_event_slots es ON es.player_id = p.player_id AND es.event_year = ? WHERE p.faction_id = ? AND st.disabled_at IS NULL"
      ).bind(yearValue, yearValue, yearValue, yearValue, yearValue, yearValue, NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>()
      const leaderboard = (members.results ?? []).map((row) => {
        const status = typeof row.collectionStatus === "string" ? row.collectionStatus : null
        const statusText = status ?? (row.keyConnected ? "ready" : "not_collected")
        const complete = statusText === "complete"
        return {
          playerId: String(row.playerId),
          playerName: String(row.playerName),
          eventWindowConfigured: row.startMinuteOfDay != null,
          startTime: row.startMinuteOfDay == null ? null : formatHalloweenStartTime(Number(row.startMinuteOfDay)),
          keyConnected: row.keyConnected === 1,
          collectionStatus: statusText,
          pagesCollected: Number(row.pagesCollected ?? 0),
          logsCollected: Number(row.storedLogCount ?? 0),
          totalHits: complete ? Number(row.storedHitCount ?? 0) : null,
          lastCollectedAt: row.lastCollectedAt ?? null,
          coverage: complete ? "complete" : statusText === "running" || statusText === "queued" ? "collecting" : statusText === "failed" ? "partial" : "not_collected",
        }
      }).sort((a, b) => (b.totalHits ?? -1) - (a.totalHits ?? -1) || a.playerName.localeCompare(b.playerName))
      const personal = await getHalloweenMemberEventWindow(env, session.player_id, yearValue)
      return jsonResponse({ event, myWindow: personal?.window ?? null, leaderboard, myCollection: leaderboard.find((row) => row.playerId === session.player_id) ?? null }, 200, origin)
    }
    const halloweenMemberMatch = url.pathname.match(/^\/api\/me\/halloween\/members\/(\d+)$/)
    if (halloweenMemberMatch && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const targetId = halloweenMemberMatch[1]
      const yearValue = Number(url.searchParams.get("year") || new Date().getUTCFullYear())
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100) return jsonResponse({ error: "A valid Halloween event year is required." }, 400, origin)
      const db = requireDb(env)
      const member = await db.prepare("SELECT player_id AS playerId, player_name AS playerName FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.player_id = ? AND p.faction_id = ? AND st.disabled_at IS NULL")
        .bind(targetId, NAUGHTY_SOULS_FACTION_ID).first<{ playerId: string; playerName: string }>()
      if (!member) return jsonResponse({ error: "That member is not currently verified as a Naughty Souls member." }, 404, origin)
      const [job, logs, daily] = await Promise.all([
        db.prepare("SELECT status, logs_collected AS logsCollected, pages_collected AS pagesCollected, last_error AS lastError, updated_at AS updatedAt, completed_at AS completedAt FROM halloween_collection_jobs WHERE player_id = ? AND event_year = ? ORDER BY updated_at DESC LIMIT 1")
          .bind(targetId, yearValue).first<Record<string, unknown>>(),
        db.prepare("SELECT log_id AS logId, event_timestamp AS timestamp, log_type_id AS logTypeId, category, title, labels_json AS labelsJson, is_hit AS isHit, log_json AS logJson, collected_at AS collectedAt FROM halloween_event_logs WHERE player_id = ? AND event_year = ? ORDER BY event_timestamp DESC, log_id DESC LIMIT 250")
          .bind(targetId, yearValue).all<Record<string, unknown>>(),
        db.prepare("SELECT date(event_timestamp, 'unixepoch') AS eventDay, SUM(is_hit) AS totalHits, COUNT(*) AS relevantLogs FROM halloween_event_logs WHERE player_id = ? AND event_year = ? GROUP BY date(event_timestamp, 'unixepoch') ORDER BY eventDay")
          .bind(targetId, yearValue).all<Record<string, unknown>>(),
      ])
      return jsonResponse({
        member,
        collection: job ? { ...job, coverage: job.status === "complete" ? "complete" : job.status === "failed" ? "partial" : "collecting" } : { status: "not_collected", coverage: "not_collected" },
        dailyActivity: daily.results ?? [],
        logs: (logs.results ?? []).map((row) => {
          let parsed: unknown = null
          try { parsed = JSON.parse(String(row.logJson ?? "null")) } catch { parsed = null }
          let labels: unknown = []
          try { labels = JSON.parse(String(row.labelsJson ?? "[]")) } catch { labels = [] }
          return { logId: row.logId, timestamp: row.timestamp, title: row.title, category: row.category, labels, isHit: row.isHit === 1, details: parsed }
        }),
      }, 200, origin)
    }
    if (url.pathname === "/api/me/halloween/collect" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const body: unknown = await request.json().catch(() => null)
      const yearValue = isRecord(body) ? Number(body.year) : new Date().getUTCFullYear()
      if (!Number.isInteger(yearValue) || yearValue < 2000 || yearValue > 2100) return jsonResponse({ error: "A valid Halloween event year is required." }, 400, origin)
      const db = requireDb(env)
      const key = await db.prepare("SELECT player_id FROM halloween_historical_keys WHERE player_id = ?").bind(session.player_id).first<{ player_id: string }>()
      if (!key) return jsonResponse({ error: "Connect your own Full Access key before collecting historical Halloween logs." }, 409, origin)
      const event = await db.prepare("SELECT start_at AS startAt, end_at AS endAt, historical_collection_enabled AS enabled FROM halloween_event_windows WHERE event_year = ?")
        .bind(yearValue).first<{ startAt: string; endAt: string; enabled: number }>()
      if (!event || event.enabled !== 1) return jsonResponse({ error: "Historical collection is not enabled for that event year." }, 409, origin)
      const personal = await getHalloweenMemberEventWindow(env, session.player_id, yearValue)
      if (!personal?.window.configured || !personal.window.startAt || !personal.window.endAt) return jsonResponse({ error: "Select your personal Trick or Treat start time before collecting historical logs." }, 409, origin)
      const active = await db.prepare("SELECT job_id AS jobId, status, logs_collected AS logsCollected FROM halloween_collection_jobs WHERE player_id = ? AND event_year = ? AND status IN ('queued', 'running') ORDER BY updated_at DESC LIMIT 1")
        .bind(session.player_id, yearValue).first<{ jobId: string; status: string; logsCollected: number }>()
      if (active) return jsonResponse({ queued: true, jobId: active.jobId, status: active.status, logsCollected: Number(active.logsCollected ?? 0), resumed: true }, 200, origin)
      const finished = await db.prepare("SELECT job_id AS jobId, status, logs_collected AS logsCollected FROM halloween_collection_jobs WHERE player_id = ? AND event_year = ? AND status = 'complete' ORDER BY updated_at DESC LIMIT 1")
        .bind(session.player_id, yearValue).first<{ jobId: string; status: string; logsCollected: number }>()
      if (finished) return jsonResponse({ queued: false, jobId: finished.jobId, status: "complete", logsCollected: Number(finished.logsCollected ?? 0), alreadyComplete: true }, 200, origin)
      const jobId = crypto.randomUUID()
      const cursorTs = Math.floor(Date.parse(personal.window.startAt) / 1000)
      if (!Number.isFinite(cursorTs) || Date.parse(personal.window.endAt) <= Date.parse(personal.window.startAt)) return jsonResponse({ error: "The personal event window is invalid." }, 409, origin)
      const now = new Date().toISOString()
      await db.prepare("INSERT INTO halloween_collection_jobs (job_id, player_id, event_year, status, cursor_ts, window_start_at, window_end_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
        .bind(jobId, session.player_id, yearValue, cursorTs, personal.window.startAt, personal.window.endAt, now, now).run()
      try {
        await sendHalloweenCollectionJob(env, jobId)
      } catch {
        await db.prepare("UPDATE halloween_collection_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE job_id = ?")
          .bind("The background collection queue is unavailable. Try again later.", new Date().toISOString(), jobId).run()
        return jsonResponse({ error: "The background collection queue is unavailable. Try again later." }, 503, origin)
      }
      return jsonResponse({ queued: true, jobId, status: "queued", logsCollected: 0 }, 202, origin)
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
    if (url.pathname === "/api/auth/company-key" && request.method === "DELETE") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const companyId = url.searchParams.get("companyId") ?? ""
      if (!/^\d{1,12}$/.test(companyId) || !Number.isSafeInteger(Number(companyId)) || Number(companyId) <= 0) return jsonResponse({ error: "A valid company ID is required." }, 400, origin)
      const db = requireDb(env)
      const companyKey = await savedCompanyApiKey(env, session.player_id, companyId)
      if (!companyKey) return jsonResponse({ error: "No saved API key exists for this company." }, 404, origin)
      const loginKey = await savedKey(env, session.player_id)
      if (loginKey && loginKey === companyKey) return jsonResponse({ error: "This company connection uses your login key. Replace your login key first if you want to disconnect this company." }, 409, origin)
      const otherCompany = await db.prepare("SELECT company_id FROM company_api_keys WHERE player_id = ? AND company_id != ? LIMIT 1").bind(session.player_id, companyId).first<{ company_id: string }>()
      if (!otherCompany && loginKey) {
        try {
          const loginCompany = await validateCompanyKey(loginKey)
          if (String(loginCompany.companyId) === companyId) return jsonResponse({ error: "Your saved login key also connects to this company. Replace your login key first if you want to disconnect it." }, 409, origin)
        } catch { /* A login key without company access cannot recreate this connection. */ }
      }
      const legacyKey = await savedCompanyKey(env, session.player_id)
      if (legacyKey === companyKey) await db.prepare("DELETE FROM company_keys WHERE player_id = ?").bind(session.player_id).run()
      await db.prepare("DELETE FROM company_api_keys WHERE player_id = ? AND company_id = ?").bind(session.player_id, companyId).run()
      const keyMeta = await companyKeyMeta(env, session.player_id)
      return jsonResponse({ deleted: true, companyId, companyDataRetained: true, companyKeySaved: keyMeta.saved }, 200, origin)
    }
    if (url.pathname === "/api/auth/key" && request.method === "DELETE") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      await requireDb(env).prepare("DELETE FROM api_keys WHERE player_id = ?").bind(session.player_id).run()
      await requireDb(env).prepare("DELETE FROM company_keys WHERE player_id = ?").bind(session.player_id).run()
      await requireDb(env).prepare("DELETE FROM company_api_keys WHERE player_id = ?").bind(session.player_id).run()
      return jsonResponse({ deleted: true, companyDataRetained: true }, 200, origin)
    }
    if (url.pathname === "/api/auth/sign-out-all" && request.method === "POST") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const result = await requireDb(env).prepare("DELETE FROM sessions WHERE player_id = ?").bind(session.player_id).run()
      return jsonResponse({ signedOutEverywhere: true, sessionsRevoked: Number(result.meta?.changes ?? 0) }, 200, origin)
    }
    if (url.pathname === "/api/auth/sign-out" && request.method === "POST") {
      const token = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
      if (token && env.DB) await requireDb(env).prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run()
      return jsonResponse({ signedOut: true }, 200, origin)
    }
    if (url.pathname === "/api/dashboard-members" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      const rows = await requireDb(env).prepare("SELECT p.player_id AS playerId, p.player_name AS playerName, p.faction_verified_at AS membershipVerifiedAt, (SELECT c.company_name FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyName, (SELECT c.company_type FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS companyType, (SELECT c.profile_json FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1) AS profileJson, (SELECT f.company_type_id FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyTypeId, (SELECT f.company_name FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyName, (SELECT f.company_type FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1) AS cachedCompanyType FROM players p LEFT JOIN dashboard_member_status st ON st.player_id = p.player_id WHERE p.faction_id = ? AND st.disabled_at IS NULL ORDER BY p.player_name COLLATE NOCASE").bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>()
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
        const rows = await db.prepare("SELECT p.player_id AS playerId, p.player_name AS directorName, COALESCE(NULLIF((SELECT c.company_name FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1), ''), (SELECT f.company_name FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1)) AS companyName, COALESCE(NULLIF((SELECT c.company_type FROM companies c WHERE c.player_id = p.player_id ORDER BY c.fetched_at DESC LIMIT 1), ''), (SELECT f.company_type FROM faction_member_cache f WHERE f.player_id = p.player_id AND f.is_director = 1 ORDER BY f.updated_at DESC LIMIT 1)) AS companyType, COALESCE(r.share_financial_data, 0) AS shareFinancialData, COALESCE(r.share_employee_data, 0) AS shareEmployeeData, COALESCE(r.share_trend_data, 0) AS shareTrendData FROM players p LEFT JOIN company_sharing_recipients r ON r.recipient_player_id = p.player_id AND r.owner_player_id = ? WHERE p.player_id != ? ORDER BY p.player_name COLLATE NOCASE").bind(session.player_id, session.player_id).all<Record<string, unknown>>()
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
    if (url.pathname === "/api/faction/activity" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) {
        return jsonResponse({ error: "Faction activity is available only to current Naughty Souls members." }, 403, origin)
      }
      const db = requireDb(env)
      try {
        type RosterRun = { runId: string; capturedAt: string; scheduledAt: string; memberCount: number }
        type ActivityRosterRow = {
          userId: string
          name: string | null
          position: string | null
          level: number | null
          lastActionStatus: string | null
          statusDescription: string | null
          statusDetails: string | null
          statusState: string | null
          statusUntil: string | null
          reviveSetting: string | null
          isOnWall: number | null
          isInOc: number | null
          hasEarlyDischarge: number | null
        }
        type MembershipChange = {
          userId: string
          memberName: string | null
          firstSeenAt: string
          leftObservedAt: string | null
        }
        type ActivityEvent = {
          id: string
          eventType: string
          occurredAt: string
          userId: string
          memberName: string
          detail: string
          previousValue: string | null
          currentValue: string | null
        }

        const rosterRuns = await db.prepare(
          "SELECT s.run_id AS runId, s.captured_at AS capturedAt, s.scheduled_at AS scheduledAt, s.member_count AS memberCount FROM faction_roster_snapshots s JOIN faction_performance_collection_runs c ON c.run_id = s.run_id AND c.status = 'completed' WHERE s.faction_id = ? ORDER BY s.captured_at DESC, s.run_id DESC LIMIT 2"
        ).bind(NAUGHTY_SOULS_FACTION_ID).all<RosterRun>()
        const runs = rosterRuns.results ?? []
        const latest = runs[0] ?? null
        const previous = runs[1] ?? null
        if (!latest) {
          return jsonResponse({
            factionId: NAUGHTY_SOULS_FACTION_ID,
            generatedAt: new Date().toISOString(),
            comparisonStatus: "waiting_for_roster",
            latestCapturedAt: null,
            previousCapturedAt: null,
            events: [],
            eventCount: 0,
          }, 200, origin, { "cache-control": "private, max-age=30" })
        }

        const [latestRows, previousRows, intervalRows] = await Promise.all([
          db.prepare(
            "SELECT user_id AS userId, name, position, level, last_action_status AS lastActionStatus, status_description AS statusDescription, status_details AS statusDetails, status_state AS statusState, status_until AS statusUntil, revive_setting AS reviveSetting, is_on_wall AS isOnWall, is_in_oc AS isInOc, has_early_discharge AS hasEarlyDischarge FROM faction_member_roster_snapshots WHERE run_id = ? ORDER BY name COLLATE NOCASE, user_id"
          ).bind(latest.runId).all<ActivityRosterRow>(),
          previous ? db.prepare(
            "SELECT user_id AS userId, name, position, level, last_action_status AS lastActionStatus, status_description AS statusDescription, status_details AS statusDetails, status_state AS statusState, status_until AS statusUntil, revive_setting AS reviveSetting, is_on_wall AS isOnWall, is_in_oc AS isInOc, has_early_discharge AS hasEarlyDischarge FROM faction_member_roster_snapshots WHERE run_id = ? ORDER BY name COLLATE NOCASE, user_id"
          ).bind(previous.runId).all<ActivityRosterRow>() : Promise.resolve({ results: [] as ActivityRosterRow[] }),
          previous ? db.prepare(
            "SELECT user_id AS userId, member_name AS memberName, first_seen_at AS firstSeenAt, left_observed_at AS leftObservedAt FROM faction_membership_intervals WHERE faction_id = ? AND ((first_seen_at > ? AND first_seen_at <= ?) OR (left_observed_at > ? AND left_observed_at <= ?)) ORDER BY COALESCE(left_observed_at, first_seen_at) DESC, user_id"
          ).bind(NAUGHTY_SOULS_FACTION_ID, previous.capturedAt, latest.capturedAt, previous.capturedAt, latest.capturedAt).all<MembershipChange>() : Promise.resolve({ results: [] as MembershipChange[] }),
        ])

        const events: ActivityEvent[] = []
        const pushEvent = (
          eventType: string,
          occurredAt: string,
          userId: string,
          memberName: string | null,
          detail: string,
          previousValue: string | null = null,
          currentValue: string | null = null,
        ) => {
          if (!occurredAt) return
          events.push({
            id: [eventType, userId, occurredAt].join(":"),
            eventType,
            occurredAt,
            userId,
            memberName: memberName || "Unknown member",
            detail,
            previousValue,
            currentValue,
          })
        }
        const normalizeBoolean = (value: unknown): string => value === 1 || value === true || value === "1"
          ? "Yes"
          : value === 0 || value === false || value === "0"
            ? "No"
            : "Unknown"
        const displayValue = (value: unknown): string => value == null || String(value).trim() === ""
          ? "Unknown"
          : String(value)
        const newByUser = new Map((latestRows.results ?? []).map(row => [String(row.userId), row]))
        const oldByUser = new Map((previousRows.results ?? []).map(row => [String(row.userId), row]))

        for (const interval of intervalRows.results ?? []) {
          if (interval.firstSeenAt > previous!.capturedAt && interval.firstSeenAt <= latest.capturedAt) {
            pushEvent("member_added", interval.firstSeenAt, String(interval.userId), interval.memberName,
              "First observed in a completed faction roster.")
          }
          if (interval.leftObservedAt && interval.leftObservedAt > previous!.capturedAt && interval.leftObservedAt <= latest.capturedAt) {
            pushEvent("member_removed", interval.leftObservedAt, String(interval.userId), interval.memberName,
              "Departure observed by the faction roster collector.")
          }
        }

        if (previous) {
          for (const [userId, current] of newByUser) {
            const old = oldByUser.get(userId)
            if (!old) continue
            const memberName = current.name || old.name
            const oldActivity = displayValue(old.lastActionStatus)
            const newActivity = displayValue(current.lastActionStatus)
            if (oldActivity !== newActivity) {
              pushEvent("activity_changed", latest.capturedAt, userId, memberName,
                "Public last-action state changed.", oldActivity, newActivity)
            }
            const statusSummary = (row: ActivityRosterRow) =>
              [row.statusDescription, row.statusState, row.statusDetails]
                .map(value => value?.trim() || "")
                .filter(Boolean)
                .join(" · ") || "Unknown"
            const oldStatus = statusSummary(old)
            const newStatus = statusSummary(current)
            if (oldStatus !== newStatus || displayValue(old.statusUntil) !== displayValue(current.statusUntil)) {
              const oldTimer = displayValue(old.statusUntil)
              const newTimer = displayValue(current.statusUntil)
              const oldLabel = oldTimer === "Unknown" ? oldStatus : oldStatus + " · " + oldTimer
              const newLabel = newTimer === "Unknown" ? newStatus : newStatus + " · " + newTimer
              pushEvent("status_changed", latest.capturedAt, userId, memberName,
                "Public member status or timer changed.", oldLabel, newLabel)
            }
            const flagChanges: Array<[string, string, unknown, unknown]> = [
              ["wall_changed", "Wall status", old.isOnWall, current.isOnWall],
              ["oc_changed", "Organized crime status", old.isInOc, current.isInOc],
              ["early_discharge_changed", "Early-discharge status", old.hasEarlyDischarge, current.hasEarlyDischarge],
            ]
            for (const [eventType, label, from, to] of flagChanges) {
              if (normalizeBoolean(from) !== normalizeBoolean(to)) {
                pushEvent(eventType, latest.capturedAt, userId, memberName, label + " changed.",
                  normalizeBoolean(from), normalizeBoolean(to))
              }
            }
            const oldRevive = displayValue(old.reviveSetting)
            const newRevive = displayValue(current.reviveSetting)
            if (oldRevive !== newRevive) {
              pushEvent("revive_setting_changed", latest.capturedAt, userId, memberName,
                "Configured faction revive setting changed.", oldRevive, newRevive)
            }
            const oldPosition = displayValue(old.position)
            const newPosition = displayValue(current.position)
            if (oldPosition !== newPosition) {
              pushEvent("position_changed", latest.capturedAt, userId, memberName,
                "Faction position changed.", oldPosition, newPosition)
            }
          }
        }

        const orderedEvents = events.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id)).slice(0, 100)
        const eventCounts = Object.fromEntries(Array.from(new Set(orderedEvents.map(event => event.eventType)))
          .map(eventType => [eventType, orderedEvents.filter(event => event.eventType === eventType).length]))
        return jsonResponse({
          factionId: NAUGHTY_SOULS_FACTION_ID,
          generatedAt: new Date().toISOString(),
          comparisonStatus: previous ? "compared" : "waiting_for_previous_roster",
          latestRoster: latest,
          previousRoster: previous,
          eventCount: orderedEvents.length,
          eventCounts,
          events: orderedEvents,
        }, 200, origin, { "cache-control": "private, max-age=30" })
      } catch {
        return jsonResponse({ error: "Faction activity history is unavailable. Verify the completed roster snapshots and faction membership intervals." }, 503, origin)
      }
    }
    if (url.pathname === "/api/faction/weekly-history" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) {
        return jsonResponse({ error: "Faction weekly history is available only to current Naughty Souls members." }, 403, origin)
      }
      const db = requireDb(env)
      try {
        const weeks = url.searchParams.get("weekStart")
        if (!weeks) {
          const reports = await db.prepare(
            "SELECT week_start_at AS weekStartAt, week_end_at AS weekEndAt, report_status AS status, member_count AS memberCount, complete_member_count AS completeMemberCount, stats_start_captured_at AS statsStartCapturedAt, stats_end_captured_at AS statsEndCapturedAt, gym_start_captured_at AS gymStartCapturedAt, gym_end_captured_at AS gymEndCapturedAt, summary_json AS summaryJson, finalized_at AS finalizedAt FROM faction_weekly_reports WHERE faction_id = ? ORDER BY week_start_at DESC LIMIT 26"
          ).bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>()
          return jsonResponse({
            reports: (reports.results ?? []).map((row) => ({
              weekStartAt: row.weekStartAt,
              weekEndAt: row.weekEndAt,
              status: row.status,
              memberCount: row.memberCount,
              completeMemberCount: row.completeMemberCount,
              statsStartCapturedAt: row.statsStartCapturedAt,
              statsEndCapturedAt: row.statsEndCapturedAt,
              gymStartCapturedAt: row.gymStartCapturedAt,
              gymEndCapturedAt: row.gymEndCapturedAt,
              summary: parseStoredJson(row.summaryJson),
              finalizedAt: row.finalizedAt,
            })),
          }, 200, origin, { "cache-control": "private, max-age=30" })
        }

        const weekStartMs = Date.parse(weeks)
        if (!Number.isFinite(weekStartMs) || new Date(utcSundayStart(weekStartMs)).toISOString() !== weeks) {
          return jsonResponse({ error: "Select a valid Sunday 00:00 UTC report boundary." }, 400, origin)
        }
        const metricParam = (url.searchParams.get("metric") || "xantaken").trim()
        const allowedMetrics = [...WEEKLY_METRIC_NAMES, "gymEnergy"] as readonly string[]
        const metric = allowedMetrics.includes(metricParam) ? metricParam as WeeklyRankingMetric : "xantaken"
        const currentReport = await db.prepare(
          "SELECT week_start_at AS weekStartAt, week_end_at AS weekEndAt, report_status AS status, member_count AS memberCount, complete_member_count AS completeMemberCount, summary_json AS summaryJson, finalized_at AS finalizedAt FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at = ?"
        ).bind(NAUGHTY_SOULS_FACTION_ID, weeks).first<Record<string, unknown>>()
        if (!currentReport) return jsonResponse({ error: "That completed weekly report is not available." }, 404, origin)
        const loadRows = async (weekStartAt: string) => db.prepare(
          "SELECT user_id AS userId, member_name AS name, position, level, participation, result_status AS status, metrics_json AS metricsJson, starting_networth AS startingNetworth, ending_networth AS endingNetworth, gym_energy AS gymEnergy, known_metric_count AS knownMetricCount, anomaly_metrics_json AS anomalyMetricsJson, baseline_captured_at AS baselineCapturedAt, ending_captured_at AS endingCapturedAt, ending_is_boundary AS endingIsBoundary, baseline_snapshot_id AS baselineSnapshotId, ending_snapshot_id AS endingSnapshotId, gym_baseline_captured_at AS gymEnergyBaselineCapturedAt, gym_ending_captured_at AS gymEnergyEndingCapturedAt, gym_ending_is_boundary AS gymEnergyEndingIsBoundary FROM faction_weekly_member_results WHERE faction_id = ? AND week_start_at = ? ORDER BY member_name COLLATE NOCASE, user_id"
        ).bind(NAUGHTY_SOULS_FACTION_ID, weekStartAt).all<Record<string, unknown>>()
        const mapStoredMember = (row: Record<string, unknown>): WeeklyMemberResult => {
          const rawMetrics = parseStoredJson(row.metricsJson)
          const metrics = Object.fromEntries(WEEKLY_METRIC_NAMES.map((name) => [
            name,
            isRecord(rawMetrics) && typeof rawMetrics[name] === "number" && Number.isFinite(rawMetrics[name]) ? rawMetrics[name] : null,
          ])) as WeeklyMemberResult["metrics"]
          const rawAnomalies = parseStoredJson(row.anomalyMetricsJson)
          const anomalyMetrics = Array.isArray(rawAnomalies)
            ? rawAnomalies.filter((value): value is WeeklyRankingMetric => typeof value === "string" && (value === "gymEnergy" || (WEEKLY_METRIC_NAMES as readonly string[]).includes(value)))
            : []
          const optionalNumber = (value: unknown) => value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null
          return {
            userId: String(row.userId),
            name: String(row.name ?? "Unknown member"),
            position: typeof row.position === "string" ? row.position : null,
            level: optionalNumber(row.level),
            participation: row.participation === "full_week" || row.participation === "partial_week" ? row.participation : "unknown",
            status: row.status === "complete" || row.status === "partial" || row.status === "incomplete" || row.status === "waiting_for_baseline" || row.status === "waiting_for_update" || row.status === "anomaly" ? row.status : "incomplete",
            metrics,
            startingNetworth: optionalNumber(row.startingNetworth),
            endingNetworth: optionalNumber(row.endingNetworth),
            gymEnergy: optionalNumber(row.gymEnergy),
            knownMetricCount: Number(row.knownMetricCount ?? 0),
            anomalyMetrics,
            baselineCapturedAt: typeof row.baselineCapturedAt === "string" ? row.baselineCapturedAt : null,
            endingCapturedAt: typeof row.endingCapturedAt === "string" ? row.endingCapturedAt : null,
            baselineSnapshotId: optionalNumber(row.baselineSnapshotId),
            endingSnapshotId: optionalNumber(row.endingSnapshotId),
            endingIsBoundary: Number(row.endingIsBoundary) === 1,
            gymEnergyBaselineCapturedAt: typeof row.gymEnergyBaselineCapturedAt === "string" ? row.gymEnergyBaselineCapturedAt : null,
            gymEnergyEndingCapturedAt: typeof row.gymEnergyEndingCapturedAt === "string" ? row.gymEnergyEndingCapturedAt : null,
            gymEnergyEndingIsBoundary: Number(row.gymEnergyEndingIsBoundary) === 1,
          }
        }
        const currentRows = await loadRows(weeks)
        const currentMembers = rankWeeklyMembers((currentRows.results ?? []).map(mapStoredMember), metric)
        const compareTo = url.searchParams.get("compareTo")
        let priorReport: Record<string, unknown> | null = null
        let priorRanked = new Map<string, WeeklyMemberResult & { rank: number | null }>()
        if (compareTo) {
          const compareMs = Date.parse(compareTo)
          if (!Number.isFinite(compareMs) || new Date(utcSundayStart(compareMs)).toISOString() !== compareTo || compareMs >= weekStartMs) {
            return jsonResponse({ error: "Choose an earlier completed Sunday report to compare." }, 400, origin)
          }
          priorReport = await db.prepare(
            "SELECT week_start_at AS weekStartAt, week_end_at AS weekEndAt, report_status AS status, finalized_at AS finalizedAt FROM faction_weekly_reports WHERE faction_id = ? AND week_start_at = ?"
          ).bind(NAUGHTY_SOULS_FACTION_ID, compareTo).first<Record<string, unknown>>()
          if (!priorReport) return jsonResponse({ error: "The comparison report is not available." }, 404, origin)
          const previousRows = await loadRows(compareTo)
          priorRanked = new Map(rankWeeklyMembers((previousRows.results ?? []).map(mapStoredMember), metric).map((member) => [member.userId, member]))
        }
        const members = currentMembers.map((member) => {
          const previous = priorRanked.get(member.userId)
          const metricValue = metric === "gymEnergy" ? member.gymEnergy : member.metrics[metric]
          const previousValue = previous ? (metric === "gymEnergy" ? previous.gymEnergy : previous.metrics[metric]) : null
          const hasValues = metricValue !== null && previousValue !== null
          return {
            ...member,
            comparison: {
              previousValue,
              weeklyChange: hasValues ? metricValue - previousValue : null,
              previousRank: previous?.rank ?? null,
              rankMovement: member.rank !== null && previous?.rank !== null && previous?.rank !== undefined ? previous.rank - member.rank : null,
            },
          }
        })
        return jsonResponse({
          report: {
            weekStartAt: currentReport.weekStartAt,
            weekEndAt: currentReport.weekEndAt,
            status: currentReport.status,
            memberCount: currentReport.memberCount,
            completeMemberCount: currentReport.completeMemberCount,
            summary: parseStoredJson(currentReport.summaryJson),
            finalizedAt: currentReport.finalizedAt,
          },
          comparedReport: priorReport,
          selectedMetric: metric,
          members,
        }, 200, origin, { "cache-control": "private, max-age=60" })
      } catch {
        return jsonResponse({ error: "Weekly history storage is unavailable. Apply migration 0021 and verify the weekly report finalizer." }, 503, origin)
      }
    }
    if (url.pathname === "/api/faction/weekly-rankings" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) {
        return jsonResponse({ error: "Faction weekly rankings are available only to current Naughty Souls members." }, 403, origin)
      }
      const db = requireDb(env)
      try {
        const nowMs = Date.now()
        const week = utcSundayWindow(nowMs)
        const requestedMetric = (url.searchParams.get("metric") || "xantaken").trim()
        const allowedRankingMetrics = [...WEEKLY_METRIC_NAMES, "gymEnergy"] as readonly string[]
        const selectedMetric = allowedRankingMetrics.includes(requestedMetric)
          ? requestedMetric as WeeklyRankingMetric
          : "xantaken"
        const [membersRows, boundary, statRows, gymRows] = await Promise.all([
          db.prepare(
            "SELECT user_id AS userId, member_name AS name, position, level, estimated_joined_at AS estimatedJoinedAt, first_seen_at AS firstSeenAt, left_observed_at AS leftObservedAt FROM faction_membership_intervals WHERE faction_id = ? AND first_seen_at < ? AND (left_observed_at IS NULL OR left_observed_at > ?) ORDER BY member_name COLLATE NOCASE, user_id"
          ).bind(NAUGHTY_SOULS_FACTION_ID, week.endAt, week.startAt).all<WeeklyMembership>(),
          db.prepare(
            "SELECT b.stats_run_id AS statsRunId, b.gym_energy_run_id AS gymEnergyRunId, sr.status AS statsStatus, gr.status AS gymEnergyStatus, sr.completed_at AS statsCompletedAt, gr.completed_at AS gymEnergyCompletedAt, (SELECT MIN(s.captured_at) FROM faction_member_stat_snapshots s WHERE s.run_id = b.stats_run_id) AS statsCapturedAt, (SELECT MIN(g.captured_at) FROM faction_gym_energy_snapshots g WHERE g.run_id = b.gym_energy_run_id) AS gymEnergyCapturedAt FROM faction_weekly_boundary_runs b LEFT JOIN faction_performance_collection_runs sr ON sr.run_id = b.stats_run_id LEFT JOIN faction_performance_collection_runs gr ON gr.run_id = b.gym_energy_run_id WHERE b.faction_id = ? AND b.boundary_at = ?"
          ).bind(NAUGHTY_SOULS_FACTION_ID, week.startAt).first<Record<string, unknown>>(),
          db.prepare(
            "SELECT snapshot_id AS snapshotId, run_id AS runId, user_id AS userId, captured_at AS capturedAt, scheduled_at AS scheduledAt, collection_status AS collectionStatus, xantaken, lsdtaken, drugsused, overdosed, alcoholused, boostersused, energydrinkused, refills, statenhancersused, networth, cantaken, exttaken, kettaken, opitaken, shrtaken, spetaken, pcptaken, victaken FROM faction_member_stat_snapshots WHERE faction_id = ? AND captured_at >= ? AND captured_at <= ? ORDER BY user_id, captured_at, snapshot_id"
          ).bind(NAUGHTY_SOULS_FACTION_ID, week.startAt, week.generatedAt).all<WeeklySnapshot>(),
          db.prepare(
            "SELECT snapshot_id AS snapshotId, run_id AS runId, user_id AS userId, captured_at AS capturedAt, gym_energy_total AS gymEnergyTotal, collection_status AS collectionStatus FROM faction_gym_energy_snapshots WHERE faction_id = ? AND captured_at >= ? AND captured_at <= ? ORDER BY user_id, captured_at, snapshot_id"
          ).bind(NAUGHTY_SOULS_FACTION_ID, week.startAt, week.generatedAt).all<WeeklySnapshot>(),
        ])
        const statSnapshots = statRows.results ?? []
        const gymSnapshots = gymRows.results ?? []
        const calculated = (membersRows.results ?? []).map((member) => calculateWeeklyMemberResult({
          member,
          statSnapshots,
          gymSnapshots,
          weekStart: week.startAt,
          weekEnd: week.endAt,
          now: week.generatedAt,
          statsBoundaryRunId: boundary?.statsRunId == null ? null : String(boundary.statsRunId),
          gymBoundaryRunId: boundary?.gymEnergyRunId == null ? null : String(boundary.gymEnergyRunId),
        }))
        const members = rankWeeklyMembers(calculated, selectedMetric)
        const statSummary = Object.fromEntries(WEEKLY_METRIC_NAMES.map((metric) => {
          const known = calculated.map((member) => member.metrics[metric]).filter((value): value is number => value !== null)
          return [metric, { total: known.reduce((sum, value) => sum + value, 0), knownMembers: known.length }]
        }))
        const knownGymEnergy = calculated.map((member) => member.gymEnergy).filter((value): value is number => value !== null)
        const summary = {
          ...statSummary,
          gymEnergy: { total: knownGymEnergy.reduce((sum, value) => sum + value, 0), knownMembers: knownGymEnergy.length },
        }
        return jsonResponse({
          factionId: NAUGHTY_SOULS_FACTION_ID,
          generatedAt: week.generatedAt,
          week,
          selectedMetric,
          boundary: boundary ? (() => {
            const statsCapturedAt = boundary.statsCapturedAt == null ? null : String(boundary.statsCapturedAt)
            const gymEnergyCapturedAt = boundary.gymEnergyCapturedAt == null ? null : String(boundary.gymEnergyCapturedAt)
            const statsTimingDeviationSeconds = statsCapturedAt ? Math.round((Date.parse(statsCapturedAt) - Date.parse(week.startAt)) / 1000) : null
            const gymEnergyTimingDeviationSeconds = gymEnergyCapturedAt ? Math.round((Date.parse(gymEnergyCapturedAt) - Date.parse(week.startAt)) / 1000) : null
            return {
              scheduledAt: week.startAt,
              statsStatus: boundary.statsStatus ?? "queued",
              gymEnergyStatus: boundary.gymEnergyStatus ?? "queued",
              statsCompletedAt: boundary.statsCompletedAt ?? null,
              gymEnergyCompletedAt: boundary.gymEnergyCompletedAt ?? null,
              statsCapturedAt,
              gymEnergyCapturedAt,
              statsTimingDeviationSeconds,
              gymEnergyTimingDeviationSeconds,
              statsLate: statsTimingDeviationSeconds === null ? null : statsTimingDeviationSeconds > 300,
              gymEnergyLate: gymEnergyTimingDeviationSeconds === null ? null : gymEnergyTimingDeviationSeconds > 300,
            }
          })() : { scheduledAt: week.startAt, statsStatus: "not_scheduled", gymEnergyStatus: "not_scheduled", statsCompletedAt: null, gymEnergyCompletedAt: null, statsCapturedAt: null, gymEnergyCapturedAt: null, statsTimingDeviationSeconds: null, gymEnergyTimingDeviationSeconds: null, statsLate: null, gymEnergyLate: null },
          summary,
          completeMembers: calculated.filter((member) => member.status === "complete").length,
          totalMembers: calculated.length,
          members,
        }, 200, origin, { "cache-control": "private, max-age=30" })
      } catch {
        return jsonResponse({ error: "Weekly ranking storage is not initialized or is temporarily unavailable. Apply the latest faction-performance migrations and verify the weekly boundary collector." }, 503, origin)
      }
    }
    if (url.pathname === "/api/faction/performance" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) {
        return jsonResponse({ error: "Faction performance is available only to current Naughty Souls members." }, 403, origin)
      }
      const db = requireDb(env)
      try {
        const [collectionRows, rosterHeader, rosterRows, statRows, gymRows, privateLiveRows] = await Promise.all([
          db.prepare(
            "SELECT collection_kind AS collectionKind, last_success_at AS lastSuccessAt, last_run_id AS lastRunId, last_error AS lastError, updated_at AS updatedAt FROM faction_performance_collection_state WHERE faction_id = ? ORDER BY collection_kind",
          ).bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>(),
          db.prepare(
            "SELECT s.run_id AS runId, s.captured_at AS capturedAt, s.scheduled_at AS scheduledAt, s.member_count AS memberCount FROM faction_roster_snapshots s JOIN faction_performance_collection_runs c ON c.run_id = s.run_id AND c.status = 'completed' WHERE s.faction_id = ? ORDER BY s.captured_at DESC LIMIT 1",
          ).bind(NAUGHTY_SOULS_FACTION_ID).first<Record<string, unknown>>(),
          db.prepare(
            "SELECT m.user_id AS userId, m.name, m.position, m.level, m.days_in_faction AS daysInFaction, m.captured_at AS rosterCapturedAt, m.last_action_status AS lastActionStatus, m.last_action_timestamp AS lastActionTimestamp, m.last_action_relative AS lastActionRelative, m.status_description AS statusDescription, m.status_details AS statusDetails, m.status_state AS statusState, m.status_until AS statusUntil, m.status_color AS statusColor, m.is_revivable AS isRevivable, m.revive_setting AS reviveSetting, m.is_on_wall AS isOnWall, m.is_in_oc AS isInOc, m.has_early_discharge AS hasEarlyDischarge FROM faction_member_roster_snapshots m JOIN faction_roster_snapshots r ON r.run_id = m.run_id JOIN faction_performance_collection_runs c ON c.run_id = r.run_id AND c.status = 'completed' WHERE r.faction_id = ? AND r.run_id = (SELECT s.run_id FROM faction_roster_snapshots s JOIN faction_performance_collection_runs cr ON cr.run_id = s.run_id AND cr.status = 'completed' WHERE s.faction_id = ? ORDER BY s.captured_at DESC LIMIT 1) ORDER BY m.name COLLATE NOCASE, m.user_id",
          ).bind(NAUGHTY_SOULS_FACTION_ID, NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>(),
          db.prepare(
            "SELECT s.user_id AS userId, s.captured_at AS statsCapturedAt, s.collection_status AS statsCollectionStatus, s.xantaken, s.lsdtaken, s.drugsused, s.overdosed, s.alcoholused, s.boostersused, s.energydrinkused, s.refills, s.statenhancersused, s.networth, s.cantaken, s.exttaken, s.kettaken, s.opitaken, s.shrtaken, s.spetaken, s.pcptaken, s.victaken, s.missing_metrics_json AS missingMetricsJson FROM faction_member_stat_snapshots s WHERE s.faction_id = ? AND NOT EXISTS (SELECT 1 FROM faction_member_stat_snapshots newer WHERE newer.faction_id = s.faction_id AND newer.user_id = s.user_id AND (newer.captured_at > s.captured_at OR (newer.captured_at = s.captured_at AND newer.snapshot_id > s.snapshot_id)))",
          ).bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>(),
          db.prepare(
            "SELECT g.user_id AS userId, g.captured_at AS gymEnergyCapturedAt, g.gym_energy_total AS gymEnergyTotal, g.in_faction AS gymEnergyInFaction, g.collection_status AS gymEnergyCollectionStatus FROM faction_gym_energy_snapshots g WHERE g.faction_id = ? AND NOT EXISTS (SELECT 1 FROM faction_gym_energy_snapshots newer WHERE newer.faction_id = g.faction_id AND newer.user_id = g.user_id AND (newer.captured_at > g.captured_at OR (newer.captured_at = g.captured_at AND newer.snapshot_id > g.snapshot_id)))",
          ).bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>(),
          db.prepare(
            "SELECT s.player_id AS userId, s.captured_at AS privateCapturedAt, s.bars_json AS barsJson, s.cooldowns_json AS cooldownsJson, s.networth_json AS networthJson, s.source_timestamps_json AS sourceTimestampsJson, k.include_networth AS includeNetworth, k.last_error AS lastError FROM faction_member_private_live_snapshots s JOIN member_private_live_keys k ON k.player_id = s.player_id AND k.faction_id = s.faction_id AND k.share_with_faction = 1 LEFT JOIN dashboard_member_status st ON st.player_id = s.player_id WHERE s.faction_id = ? AND st.disabled_at IS NULL",
          ).bind(NAUGHTY_SOULS_FACTION_ID).all<Record<string, unknown>>(),
        ])
        const statsByUser = new Map((statRows.results ?? []).map((row) => [String(row.userId), row]))
        const gymByUser = new Map((gymRows.results ?? []).map((row) => [String(row.userId), row]))
        const privateLiveByUser = new Map((privateLiveRows.results ?? []).map((row) => [String(row.userId), row]))
        const members = (rosterRows.results ?? []).map((roster) => {
          const userId = String(roster.userId)
          let missingMetrics: unknown = []
          const stats = statsByUser.get(userId) ?? null
          if (stats?.missingMetricsJson) {
            try { missingMetrics = JSON.parse(String(stats.missingMetricsJson)) as unknown } catch { missingMetrics = [] }
          }
          return {
            ...roster,
            isRevivable: roster.isRevivable == null ? null : roster.isRevivable === 1,
            isOnWall: roster.isOnWall == null ? null : roster.isOnWall === 1,
            isInOc: roster.isInOc == null ? null : roster.isInOc === 1,
            hasEarlyDischarge: roster.hasEarlyDischarge == null ? null : roster.hasEarlyDischarge === 1,
            stats: stats ? { ...stats, missingMetrics } : null,
            gymEnergy: gymByUser.get(userId) ?? null,
            privateLive: (() => {
              const live = privateLiveByUser.get(userId)
              if (!live) return null
              return {
                capturedAt: String(live.privateCapturedAt ?? ""),
                bars: parseStoredJson(live.barsJson),
                cooldowns: parseStoredJson(live.cooldownsJson),
                networth: Number(live.includeNetworth) === 1 ? parseStoredJson(live.networthJson) : null,
                sourceTimestamps: parseStoredJson(live.sourceTimestampsJson),
              }
            })(),
          }
        })
        const collection = (collectionRows.results ?? []).map((row) => ({
          collectionKind: String(row.collectionKind),
          lastSuccessAt: row.lastSuccessAt == null ? null : String(row.lastSuccessAt),
          lastRunId: row.lastRunId == null ? null : String(row.lastRunId),
          lastError: row.lastError == null ? null : String(row.lastError),
          updatedAt: String(row.updatedAt ?? ""),
        }))
        return jsonResponse({
          factionId: NAUGHTY_SOULS_FACTION_ID,
          generatedAt: new Date().toISOString(),
          roster: rosterHeader ?? null,
          collection,
          members,
        }, 200, origin, { "cache-control": "private, max-age=30" })
      } catch {
        return jsonResponse({
          error: "Faction performance storage is not initialized or is temporarily unavailable. Apply migration 0019 and verify the collection worker.",
        }, 503, origin)
      }
    }

    if (url.pathname === "/api/faction/stats" && request.method === "GET") {
      const session = await authenticate(request, env)
      if (!session) return jsonResponse({ error: "Session expired. Sign in again with your Torn API key." }, 401, origin)
      if (session.faction_id !== NAUGHTY_SOULS_FACTION_ID) {
        return jsonResponse({ error: "Faction stats are available only to current Naughty Souls members." }, 403, origin)
      }
      const db = requireDb(env)
      try {
        const [snapshot, state] = await Promise.all([
          db.prepare(
            "SELECT run_id AS runId, captured_at AS capturedAt, scheduled_at AS scheduledAt, collection_status AS status, stats_json AS statsJson, missing_stat_names_json AS missingStatNamesJson, unexpected_stat_names_json AS unexpectedStatNamesJson, returned_stat_count AS returnedStatCount FROM faction_stats_snapshots WHERE faction_id = ? ORDER BY captured_at DESC, snapshot_id DESC LIMIT 1"
          ).bind(NAUGHTY_SOULS_FACTION_ID).first<Record<string, unknown>>(),
          db.prepare(
            "SELECT last_success_at AS lastSuccessAt, last_run_id AS lastRunId, last_error AS lastError, updated_at AS updatedAt FROM faction_stats_collection_state WHERE faction_id = ?"
          ).bind(NAUGHTY_SOULS_FACTION_ID).first<Record<string, unknown>>(),
        ])
        return jsonResponse({
          factionId: NAUGHTY_SOULS_FACTION_ID,
          generatedAt: new Date().toISOString(),
          snapshot: snapshot ? {
            runId: String(snapshot.runId),
            capturedAt: String(snapshot.capturedAt),
            scheduledAt: String(snapshot.scheduledAt),
            status: String(snapshot.status),
            returnedStatCount: Number(snapshot.returnedStatCount),
          } : null,
          stats: snapshot ? parseStoredJson(snapshot.statsJson) ?? [] : [],
          missingStatNames: snapshot ? parseStoredJson(snapshot.missingStatNamesJson) ?? [] : [],
          unexpectedStatNames: snapshot ? parseStoredJson(snapshot.unexpectedStatNamesJson) ?? [] : [],
          collection: state ? {
            lastSuccessAt: state.lastSuccessAt == null ? null : String(state.lastSuccessAt),
            lastRunId: state.lastRunId == null ? null : String(state.lastRunId),
            lastError: state.lastError == null ? null : String(state.lastError),
            updatedAt: String(state.updatedAt ?? ""),
          } : null,
        }, 200, origin, { "cache-control": "private, max-age=30" })
      } catch {
        return jsonResponse({
          error: "Faction stats storage is not initialized or is temporarily unavailable. Apply migration 0022 and verify the faction stats collector.",
        }, 503, origin)
      }
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
        // Global company rankings are captured only by the 18:10 UTC scheduled job.
        // The 00:10 UTC official Torn snapshot is verification-only and never replaces this cache.
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
        return jsonResponse({ companies, generatedAt: cached?.fetchedAt ?? "", source: "Daily cached Torn API v2 /company/{typeId}/companies lists", scope: "all-torn", companyType: requestedType || null, companyTypeId: requestedTypeId, incomeDataUpdatesAt: "18:10 UTC daily", starRatingUpdatesAt: "18:10 UTC Sundays", cacheAvailable: Boolean(cached) }, 200, origin, { "cache-control": "private, max-age=300" })
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
      if (request.method === "POST" && !await readAdminBoolean(env, "historyImportEnabled", true)) return jsonResponse({ error: "History imports are disabled by the dashboard administrator." }, 409, origin)
      const db = requireDb(env)
      await db.prepare("CREATE TABLE IF NOT EXISTS user_page_data (player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, page_key TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (player_id, page_key))").run()
      await db.prepare("CREATE TABLE IF NOT EXISTS company_sharing_recipients (owner_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, recipient_player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE, share_financial_data INTEGER NOT NULL DEFAULT 0 CHECK (share_financial_data IN (0, 1)), share_employee_data INTEGER NOT NULL DEFAULT 0 CHECK (share_employee_data IN (0, 1)), share_trend_data INTEGER NOT NULL DEFAULT 0 CHECK (share_trend_data IN (0, 1)), updated_at TEXT NOT NULL, PRIMARY KEY (owner_player_id, recipient_player_id), CHECK (owner_player_id != recipient_player_id))").run()
      const parseStored = (value: unknown): unknown => { try { return JSON.parse(String(value)) as unknown } catch { return null } }
      const allowedPages = new Set(["company", "employees", "charts", "rankings", "references", "settings", "dashboard-layout"])
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
      const keys = await requireDb(env).prepare("SELECT company_id, company_name, company_type, last_four, updated_at FROM company_api_keys WHERE player_id = ? ORDER BY updated_at DESC").bind(session.player_id).all<Record<string, unknown>>()
      const merged = new Map<string, Record<string, unknown>>()
      for (const row of rows.results ?? []) merged.set(String(row.company_id), row)
      for (const row of keys.results ?? []) { const id = String(row.company_id); const current = merged.get(id); merged.set(id, { company_id: id, company_name: current?.company_name ?? row.company_name, company_type: current?.company_type ?? row.company_type, fetched_at: current?.fetched_at ?? row.updated_at, has_api_key: true, key_last_four: row.last_four, key_updated_at: row.updated_at }) }
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
      if (!await readAdminBoolean(env, "manualRefreshEnabled", true)) return jsonResponse({ error: "Manual refreshes are disabled by the dashboard administrator." }, 409, origin)
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
        // On-demand refreshes update live caches only; immutable history is captured by approved snapshot paths.
        await db.prepare("INSERT INTO company_financials (player_id, company_id, stock_json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, company_id) DO UPDATE SET stock_json = excluded.stock_json, fetched_at = excluded.fetched_at").bind(session.player_id, String(companyId), asJson(stock), now).run()
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
