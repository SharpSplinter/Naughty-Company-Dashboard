import type {
  TornClientOptions,
  TornCompanyData,
  TornCompanyEmployees,
  TornCompanyProfile,
  TornCompanyResponse,
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
      return "The Torn API key does not have the required access."
    case 4:
      return "The Torn company ID is invalid."
    case 9:
      return "Torn API rate limit reached. Please retry shortly."
    default:
      return "Torn API request failed."
  }
}

function apiErrorStatus(
  responseStatus: number,
  code: number | undefined,
): number {
  if (responseStatus === 429 || code === 9) return 429
  if (code === 2) return 401
  if (code === 3) return 403
  if (code === 4) return 400
  if (responseStatus >= 500) return 502
  return 502
}

export class TornApiClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number

  constructor(options: TornClientOptions) {
    const apiKey = options.apiKey.trim()
    if (!apiKey) {
      throw new TornApiClientError("A Torn API key is required.", {
        status: 401,
      })
    }

    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")
    this.fetcher = options.fetcher ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      })

      const payload: unknown = await response.json().catch(() => null)
      const apiError =
        isRecord(payload) && isRecord(payload.error) ? payload.error : null

      if (!response.ok || apiError) {
        const upstreamStatus =
          typeof response.status === "number" ? response.status : 502
        const apiCode =
          apiError && typeof apiError.code === "number"
            ? apiError.code
            : undefined
        const retryAfter = response.headers.get("Retry-After") ?? undefined

        throw new TornApiClientError(apiErrorMessage(apiCode), {
          status: apiErrorStatus(upstreamStatus, apiCode),
          code: apiCode,
          retryAfter,
        })
      }

      return payload as T
    } catch (error) {
      if (error instanceof TornApiClientError) throw error
      if (error instanceof Error && error.name === "AbortError") {
        throw new TornApiClientError("Torn API request timed out.", {
          status: 504,
        })
      }
      throw new TornApiClientError("Could not reach the Torn API.", {
        status: 502,
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}
