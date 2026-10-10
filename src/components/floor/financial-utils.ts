import type { CompanyDashboardModel } from "../../lib/company/types"

export function firstNumeric(root: unknown, names: string[]): number | null {
  const visit = (value: unknown, depth: number): number | null => {
    if (!value || typeof value !== "object" || depth > 5) return null
    const object = value as Record<string, unknown>
    for (const name of names) if (typeof object[name] === "number" && Number.isFinite(object[name])) return object[name] as number
    for (const child of Object.values(object)) { const found = visit(child, depth + 1); if (found !== null) return found }
    return null
  }
  return visit(root, 0)
}
export function stockCostTotal(value: unknown): number {
  let total = 0
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object" || depth > 6) return
    if (Array.isArray(item)) { item.forEach((child) => visit(child, depth + 1)); return }
    const row = item as Record<string, unknown>
    const quantity = [row.quantity, row.amount, row.in_stock, row.stock].find((n) => typeof n === "number" && Number.isFinite(n)) as number | undefined
    const unitCost = [row.cost, row.unit_cost, row.cost_per_unit, row.purchase_price].find((n) => typeof n === "number" && Number.isFinite(n)) as number | undefined
    if (quantity !== undefined && unitCost !== undefined) total += Math.max(0, quantity) * Math.max(0, unitCost)
    for (const [key, child] of Object.entries(row)) if (!['quantity','amount','in_stock','cost','unit_cost','cost_per_unit','purchase_price'].includes(key)) visit(child, depth + 1)
  }
  visit(value, 0)
  return total
}
export function stockPriceRows(stock: unknown): { name: string; quantity: number | null; price: number | null }[] {
  const found: { name: string; quantity: number | null; price: number | null }[] = []
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6) return
    if (Array.isArray(value)) { value.forEach((child) => visit(child, depth + 1)); return }
    const row = value as Record<string, unknown>
    const name = [row.name, row.item_name, row.item].find((v) => typeof v === "string") as string | undefined
    const quantity = [row.in_stock, row.quantity, row.amount].find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined
    const price = [row.price, row.sell_price, row.selling_price, row.price_per_unit].find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined
    if (name && (quantity !== undefined || price !== undefined)) found.push({ name, quantity: quantity ?? null, price: price ?? null })
    for (const [key, child] of Object.entries(row)) if (!['name','item_name','item','in_stock','quantity','amount','price','sell_price','selling_price','price_per_unit'].includes(key)) visit(child, depth + 1)
  }
  visit(stock, 0)
  return found
}
export function financialCosts(profile: unknown, stock: unknown, normalized: CompanyDashboardModel) {
  const adBudget = firstNumeric(profile, ["advertisement_budget", "advertising_budget", "advertising_budget_daily", "ad_budget", "daily_ad_budget", "advertising"])
  const wages = normalized.employees.reduce((sum, employee) => sum + Math.max(0, employee.wage ?? 0), 0)
  const stockCosts = stockCostTotal(stock)
  const hasStockCosts = stock !== null && stock !== undefined && stockCosts > 0
  return { adBudget, wages, stockCosts, hasStockCosts, dailyCosts: (adBudget ?? 0) + wages + (hasStockCosts ? stockCosts : 0) }
}


export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : "$" + value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "No data returned."
}
export function companyTypeIdFromProfile(profile: unknown): number | null {
  let root = getObject(profile)
  for (let depth = 0; root && depth < 4; depth++) {
    const nested = getObject(root.company) ?? getObject(root.profile)
    if (!nested) break
    root = nested
  }
  const type = getObject(root?.type)
  const value = type?.id ?? root?.company_type_id ?? root?.type_id
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null
}
