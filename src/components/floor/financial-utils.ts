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
export function stockCostTotal(value: unknown): number | null {
  if (value === null || value === undefined || typeof value !== "object") return null
  let total = 0
  let incomplete = false
  const visit = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object" || depth > 7) return
    if (Array.isArray(item)) { item.forEach((child) => visit(child, depth + 1)); return }
    const row = item as Record<string, unknown>
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(row, key)
    const onOrder = [row.on_order, row.onOrder].find((n) => typeof n === "number" && Number.isFinite(n)) as number | undefined
    const unitCost = [row.cost, row.unit_cost, row.cost_per_unit, row.purchase_price].find((n) => typeof n === "number" && Number.isFinite(n)) as number | undefined
    const hasOrderField = ["on_order", "onOrder"].some(hasOwn)
    const hasCostField = ["cost", "unit_cost", "cost_per_unit", "purchase_price"].some(hasOwn)
    const hasInventoryField = ["in_stock", "quantity", "amount", "price", "rrp"].some(hasOwn)
    const nonOrderable = typeof row.cost === "string" && /cannot be ordered/i.test(row.cost)
    if (hasOrderField || (hasCostField && hasInventoryField)) {
      if (onOrder === undefined) {
        if (!nonOrderable && unitCost !== 0) incomplete = true
      } else if (onOrder > 0) {
        if (unitCost === undefined) incomplete = true
        else total += Math.max(0, onOrder) * Math.max(0, unitCost)
      }
      return
    }
    for (const child of Object.values(row)) if (child && typeof child === "object") visit(child, depth + 1)
  }
  visit(value, 0)
  return incomplete ? null : total
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
  const expectedEmployeeCount = normalized.company.employeesHired
  const knownWages = normalized.employees.filter((employee) => typeof employee.wage === "number" && Number.isFinite(employee.wage))
  const rosterComplete = expectedEmployeeCount === null
    ? normalized.employees.length > 0
    : normalized.employees.length === expectedEmployeeCount
  const wages = rosterComplete && knownWages.length === normalized.employees.length
    ? knownWages.reduce((sum, employee) => sum + Math.max(0, employee.wage as number), 0)
    : null
  const stockCosts = stockCostTotal(stock)
  const hasStockCosts = stockCosts !== null && stockCosts > 0
  const dailyRecurringCosts = adBudget !== null && wages !== null ? adBudget + wages : null
  const dailyCosts = dailyRecurringCosts !== null && stockCosts !== null ? dailyRecurringCosts + stockCosts : null
  return { adBudget, wages, stockCosts, hasStockCosts, dailyRecurringCosts, dailyCosts }
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

export function reportedCompanyProfit(profile: unknown, period: "daily" | "weekly"): number | null {
  let root = getObject(profile)
  for (let depth = 0; root && depth < 4; depth++) {
    const nested = getObject(root.company) ?? getObject(root.profile)
    if (!nested) break
    root = nested
  }
  const profit = getObject(root?.profit)
  const candidates = period === "weekly"
    ? [profit?.weekly, root?.weekly_profit, root?.weeklyProfit, root?.profit_weekly]
    : [profit?.daily, root?.daily_profit, root?.dailyProfit, root?.profit_daily, typeof root?.profit === "number" ? root.profit : null]
  return candidates.find((value): value is number => typeof value === "number" && Number.isFinite(value)) ?? null
}

export function estimateWeeklyProfit(
  weeklyIncome: number | null | undefined,
  dailyRecurringCosts: number | null | undefined,
  stockCosts: number | null | undefined,
): number | null {
  if (![weeklyIncome, dailyRecurringCosts, stockCosts].every((value) => typeof value === "number" && Number.isFinite(value))) return null
  return (weeklyIncome as number) - (dailyRecurringCosts as number) * 7 - (stockCosts as number)
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
