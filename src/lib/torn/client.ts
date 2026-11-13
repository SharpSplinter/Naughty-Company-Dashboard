import { buildPersonalStatsPath, type PersonalStatsRequest } from "./personalstats"
import type {
  TornClientOptions,
  TornCompanyData,
  TornCompanyEmployees,
  TornCompanyProfile,
  TornCompanyResponse,
  TornCompanySelections,
} from "./types"

const DEFAULT_BASE_URL = "https://api.torn.com/v2"
const DEFAULT_TIMEOUT_MS = 10_000

function extractCompanyId(payload: unknown): number | null {
  if (!isRecord(payload)) return null
  const company = isRecord(payload.company) ? payload.company : isRecord(payload.profile) ? payload.profile : payload
  const candidates = [company.id, company.company_id, company.companyId, company.ID, payload.company_id, payload.companyId]
  for (const candidate of candidates) {
    const id = typeof candidate === "number" ? candidate : typeof candidate === "string" && /^\d+$/.test(candidate) ? Number(candidate) : NaN
    if (Number.isSafeInteger(id) && id > 0) return id
  }
  return null
}

export class TornApiClientError extends Error {
  readonly status: number
  readonly code?: number
  readonly retryAfter?: string

  constructor(
    message: string,
    options: { status: number; code?: number; retryAfter?: string },
  ) {
    super(message)
    this.name = "TornApiClientError"
    this.status = options.status
    this.code = options.code
    this.retryAfter = options.retryAfter
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateCompanyId(companyId: number): void {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new TornApiClientError("Company ID must be a positive integer.", {
      status: 400,
    })
  }
}

function apiErrorMessage(code: number | undefined): string {
  switch (code) {
    case 2:
      return "The Torn API key is invalid."
    case 3:
      return "Torn rejected the requested API data type."
    case 4:
      return "Torn rejected the requested API fields."
    case 5:
      return "Torn rate limit reached for this user. Retry after the limit resets."
    case 7:
      return "The requested Torn data is not available to this API key."
    case 8:
      return "Torn temporarily blocked requests from this IP address."
    case 9:
      return "Torn's API service is currently disabled. This is not a rate-limit response."
    case 10:
      return "This Torn API key cannot be used while its owner is in federal jail."
    case 13:
      return "This Torn API key is temporarily disabled because its owner has been inactive."
    case 14:
      return "Torn's daily API read limit has been reached."
    case 16:
      return "The Torn API key does not have the required access level."
    case 17:
      return "Torn reported a temporary backend error. Please retry later."
    case 18:
      return "This Torn API key has been paused by its owner."
    default:
      return "Torn API request failed."
  }
}

function apiErrorStatus(responseStatus: number, code: number | undefined): number {
  if (responseStatus === 429 || code === 5 || code === 8 || code === 14) return 429
  if (code === 2) return 401
  if (code === 3 || code === 7 || code === 10 || code === 13 || code === 16 || code === 18) return 403
  if (code === 4 || code === 6) return 400
  if (code === 9 || code === 15) return 503
  if (code === 17 || responseStatus >= 500) return 502
  if (responseStatus === 401 || responseStatus === 403) return responseStatus
  return 502
}

function apiErrorOutcome(code: number | undefined, status: number): TornRequestOutcome {
  if (code === 5 || code === 8 || code === 14 || status === 429) return "rate_limited"
  if (code === 9) return "api_disabled"
  if (code === 2) return "invalid_key"
  if (code === 3 || code === 7 || code === 16 || code === 18 || status === 403) return "permission_denied"
  if (code === 4 || code === 6) return "invalid_request"
  if (code === 10 || code === 13) return "account_restricted"
  if (status >= 500) return "upstream_error"
  return "http_error"
}

function normalizedEndpoint(path: string): string {
  return path.split("?")[0].split("/").map((segment) =>
    segment.length > 0 && [...segment].every((character) => character >= "0" && character <= "9") ? ":id" : segment
  ).join("/")
}

export class TornApiClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly workload?: string
  private readonly playerId?: string
  private readonly onRequest?: TornClientOptions["onRequest"]

  constructor(options: TornClientOptions) {
    const apiKey = options.apiKey.trim()
    if (!apiKey) {
      throw new TornApiClientError("A Torn API key is required.", {
        status: 401,
      })
    }

    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.fetcher = options.fetcher ?? fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.workload = options.workload
    this.playerId = options.playerId
    this.onRequest = options.onRequest
  }

  async getUserJob(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/user/job")
  }

  async getFactionMembers(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/faction/members")
  }

  async getFactionMembersForRoster(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/faction/members?striptags=true")
  }

  async getFactionStats(): Promise<unknown> {
    return this.request<unknown>("/faction/stats")
  }

  async getFactionGymEnergyContributors(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/faction/contributors?stat=gymenergy")
  }

  async getUserJobFor(playerId: string | number): Promise<Record<string, unknown>> {
    if (!/^\d+$/.test(String(playerId))) throw new TornApiClientError("Player ID must be numeric.", { status: 400 })
    return this.request<Record<string, unknown>>(`/user/${playerId}/job`)
  }

  async getMyPersonalStats(selection: PersonalStatsRequest): Promise<unknown> {
    return this.request<unknown>(buildPersonalStatsPath(null, selection))
  }

  async getUserPersonalStatsFor(playerId: string | number, selection: PersonalStatsRequest): Promise<unknown> {
    return this.request<unknown>(buildPersonalStatsPath(playerId, selection))
  }

  async getCompanyProfileById(companyId: string | number): Promise<TornCompanyResponse<TornCompanyProfile>> {
    if (!/^\d+$/.test(String(companyId))) throw new TornApiClientError("Company ID must be numeric.", { status: 400 })
    return this.request<TornCompanyResponse<TornCompanyProfile>>(`/company/${companyId}/profile`)
  }

  async getCompanyProfile(): Promise<TornCompanyResponse<TornCompanyProfile>> {
    return this.request<TornCompanyResponse<TornCompanyProfile>>("/company/profile")
  }

  async getCompanyEmployees(): Promise<TornCompanyResponse<TornCompanyEmployees>> {
    return this.request<TornCompanyResponse<TornCompanyEmployees>>("/company/employees")
  }

  async getCompanyStock(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/company/stock")
  }

  async getCompanySelections(): Promise<TornCompanySelections> {
    // Preserve Torn's source timestamp so immutable history can be tied to the
    // data returned by the official scheduled reporting capture.
    const payload = await this.request<Record<string, unknown>>("/company?selections=timestamp%2Cprofile%2Cstock%2Cemployees")
    if (!isRecord(payload) || !isRecord(payload.profile)) {
      throw new TornApiClientError("Torn did not return a company profile in the combined response.", { status: 502 })
    }
    const profilePayload = isRecord(payload.profile.profile) ? payload.profile : { profile: payload.profile }
    const employeePayload = Array.isArray(payload.employees)
      ? { employees: payload.employees }
      : isRecord(payload.employees) && Array.isArray(payload.employees.employees) ? payload.employees : null
    const stockPayload = Array.isArray(payload.stock)
      ? { stock: payload.stock }
      : isRecord(payload.stock) && Array.isArray(payload.stock.stock) ? payload.stock : null
    if (!employeePayload || !stockPayload) {
      throw new TornApiClientError("Torn did not return company employees and stock in the combined response.", { status: 502 })
    }
    const timestamp = typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp) && payload.timestamp > 0
      ? payload.timestamp
      : null
    return {
      timestamp,
      profile: profilePayload as TornCompanyResponse<TornCompanyProfile>,
      employees: employeePayload as TornCompanyResponse<TornCompanyEmployees>,
      stock: stockPayload,
    }
  }

  async getCompanyData(): Promise<TornCompanyData> {
    const [profile, employees] = await Promise.all([
      this.getCompanyProfile(),
      this.getCompanyEmployees(),
    ])
    const companyId = extractCompanyId(profile)
    if (!companyId) throw new TornApiClientError("Torn did not return a valid company ID for this API key.", { status: 502 })
    return { companyId, profile, employees, fetchedAt: new Date().toISOString() }
  }

  private async request<T>(path: string): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const startedAt = Date.now()
    let upstreamStatus: number | null = null
    let status: number | null = null
    let errorCode: number | undefined
    let retryAfter: string | undefined
    let outcome: TornRequestOutcome = "network_error"

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      })
      upstreamStatus = typeof response.status === "number" ? response.status : null
      status = upstreamStatus
      retryAfter = response.headers.get("Retry-After") ?? undefined

      const payload: unknown = await response.json().catch(() => null)
      const apiError =
        isRecord(payload) && isRecord(payload.error) ? payload.error : null

      if (!response.ok || apiError) {
        errorCode = apiError && typeof apiError.code === "number" ? apiError.code : undefined
        status = apiErrorStatus(upstreamStatus ?? 502, errorCode)
        outcome = apiError ? apiErrorOutcome(errorCode, status) : status === 429 ? "rate_limited" : status >= 500 ? "upstream_error" : "http_error"
        throw new TornApiClientError(apiErrorMessage(errorCode), {
          status,
          code: errorCode,
          retryAfter,
        })
      }

      outcome = "success"
      return payload as T
    } catch (error) {
      if (error instanceof TornApiClientError) {
        status = error.status
        if (outcome === "network_error") outcome = apiErrorOutcome(error.code, error.status)
        errorCode = error.code ?? errorCode
        retryAfter = error.retryAfter ?? retryAfter
        throw error
      }
      if (error instanceof Error && error.name === "AbortError") {
        status = 504
        outcome = "timeout"
        throw new TornApiClientError("Torn API request timed out.", { status: 504 })
      }
      status = 502
      outcome = "network_error"
      throw new TornApiClientError("Could not reach the Torn API.", { status: 502 })
    } finally {
      clearTimeout(timeout)
      if (this.onRequest) {
        try {
          await this.onRequest({
            endpoint: normalizedEndpoint(path),
            method: "GET",
            ...(this.workload ? { workload: this.workload } : {}),
            ...(this.playerId ? { playerId: this.playerId } : {}),
            upstreamStatus,
            status,
            ...(errorCode === undefined ? {} : { errorCode }),
            outcome,
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(retryAfter ? { retryAfter } : {}),
          })
        } catch {
          // Telemetry must never turn a successful Torn response into an application failure.
        }
      }
    }
  }
}
