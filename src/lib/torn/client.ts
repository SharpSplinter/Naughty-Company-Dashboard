import type {
  TornClientOptions,
  TornCompanyData,
  TornCompanyEmployees,
  TornCompanyProfile,
  TornCompanyResponse,
} from "./types"

const DEFAULT_BASE_URL = "https://api.torn.com/v2"
const DEFAULT_TIMEOUT_MS = 10_000

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

  async getCompanyProfile(
    companyId: number,
  ): Promise<TornCompanyResponse<TornCompanyProfile>> {
    validateCompanyId(companyId)
    return this.request<TornCompanyResponse<TornCompanyProfile>>(
      `/company/${companyId}/profile`,
    )
  }

  async getCompanyEmployees(
    companyId: number,
  ): Promise<TornCompanyResponse<TornCompanyEmployees>> {
    validateCompanyId(companyId)
    return this.request<TornCompanyResponse<TornCompanyEmployees>>(
      `/company/${companyId}/employees`,
    )
  }

  async getCompanyData(companyId: number): Promise<TornCompanyData> {
    validateCompanyId(companyId)
    const [profile, employees] = await Promise.all([
      this.getCompanyProfile(companyId),
      this.getCompanyEmployees(companyId),
    ])

    return {
      companyId,
      profile,
      employees,
      fetchedAt: new Date().toISOString(),
    }
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

        throw new TornApiClientError(
          apiCode === 5
            ? "Torn API rate limit reached. Please retry shortly."
            : apiCode === 2
              ? "The Torn API key is invalid or does not have the required access."
              : "Torn API request failed.",
          {
            status: upstreamStatus === 429 ? 429 : upstreamStatus >= 500 ? 502 : 400,
            code: apiCode,
            retryAfter,
          },
        )
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
