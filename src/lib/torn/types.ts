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

export type TornClientOptions = {
  apiKey: string
  baseUrl?: string
  fetcher?: typeof fetch
  timeoutMs?: number
  diagnostic?: boolean
}

export type TornCompanyData = {
  companyId: number
  profile: TornCompanyResponse<TornCompanyProfile>
  employees: TornCompanyResponse<TornCompanyEmployees>
  fetchedAt: string
}
