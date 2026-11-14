export type TornApiError = {
  code?: number
  error?: string
}

export type TornCompanyProfile = Record<string, unknown>
export type TornCompanyEmployees = Record<string, unknown>

export type TornCompanyResponse<T> = {
  company?: T
  [key: string]: unknown
}

export type TornCompanySelections = {
  /** Unix timestamp in seconds returned by Torn for this combined response. */
  timestamp: number | null
  profile: TornCompanyResponse<TornCompanyProfile>
  employees: TornCompanyResponse<TornCompanyEmployees>
  stock: Record<string, unknown>
}

export type TornRequestOutcome =
  | "success"
  | "rate_limited"
  | "api_disabled"
  | "invalid_key"
  | "permission_denied"
  | "invalid_request"
  | "account_restricted"
  | "upstream_error"
  | "http_error"
  | "timeout"
  | "network_error"

export type TornRequestTelemetryEvent = {
  endpoint: string
  method: "GET"
  workload?: string
  playerId?: string
  upstreamStatus: number | null
  status: number | null
  errorCode?: number
  outcome: TornRequestOutcome
  durationMs: number
  retryAfter?: string
}

export type TornClientOptions = {
  apiKey: string
  baseUrl?: string
  fetcher?: typeof fetch
  timeoutMs?: number
  workload?: string
  playerId?: string
  onRequest?: (event: TornRequestTelemetryEvent) => void | Promise<void>
}

export type TornCompanyData = {
  companyId: number
  profile: TornCompanyResponse<TornCompanyProfile>
  employees: TornCompanyResponse<TornCompanyEmployees>
  fetchedAt: string
}
