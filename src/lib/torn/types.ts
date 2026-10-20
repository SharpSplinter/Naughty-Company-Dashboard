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

export type TornClientOptions = {
  apiKey: string
  baseUrl?: string
  fetcher?: typeof fetch
  timeoutMs?: number
}

export type TornCompanyData = {
  companyId: number
  profile: TornCompanyResponse<TornCompanyProfile>
  employees: TornCompanyResponse<TornCompanyEmployees>
  fetchedAt: string
}
