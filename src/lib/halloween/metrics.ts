export type HalloweenEventMetrics = {
  boosters: number
  energyCans: number
  fhcs: number
  greenEggs: number
  treatExchangeEnergyGained: number
  successfulAttackEnergyUsed: number
  successfulAttacks: number
}

export type HalloweenEventMetricLogRow = {
  logTypeId: number | string | null
  title?: string | null
  category?: string | null
  logJson: string | null
}

const BOOSTER_ITEM_IDS = new Set(["366", "368"])
const FHC_ITEM_IDS = new Set(["367"])
const GREEN_EGG_ITEM_IDS = new Set(["473"])
const ENERGY_CAN_ITEM_IDS = new Set(["530", "532", "533", "553", "554", "555", "985", "986", "987"])
const SIX_PACK_ITEM_ID = "818"

export function emptyHalloweenEventMetrics(): HalloweenEventMetrics {
  return {
    boosters: 0,
    energyCans: 0,
    fhcs: 0,
    greenEggs: 0,
    treatExchangeEnergyGained: 0,
    successfulAttackEnergyUsed: 0,
    successfulAttacks: 0,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonNegativeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(number) && number >= 0 ? number : null
}

function addBasketItems(itemValue: unknown, totals: Map<string, number>): void {
  const add = (itemId: string, quantity: unknown) => {
    if (!/^\d+$/.test(itemId)) return
    const parsed = nonNegativeNumber(quantity)
    const count = parsed === null ? 1 : Math.floor(parsed)
    if (count > 0) totals.set(itemId, (totals.get(itemId) ?? 0) + count)
  }

  // Torn's v2 log payload has appeared as both an item-ID list and an
  // item-ID-to-quantity object. Accept both shapes without guessing quantities.
  if (typeof itemValue === "string") {
    for (const rawId of itemValue.split(",")) {
      const itemId = rawId.trim()
      if (itemId) add(itemId, 1)
    }
    return
  }
  if (Array.isArray(itemValue)) {
    for (const rawId of itemValue) {
      if (typeof rawId === "number" || typeof rawId === "string") add(String(rawId), 1)
    }
    return
  }
  const items = asRecord(itemValue)
  if (!items) return
  for (const [itemId, quantity] of Object.entries(items)) add(itemId, quantity)
}

function parseLogJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try { return asRecord(JSON.parse(value)) } catch { return null }
}

export function calculateHalloweenEventMetrics(rows: readonly HalloweenEventMetricLogRow[]): HalloweenEventMetrics {
  const metrics = emptyHalloweenEventMetrics()
  const basketItemTotals = new Map<string, number>()

  for (const row of rows) {
    const raw = parseLogJson(row.logJson)
    if (!raw) continue
    const data = asRecord(raw.data) ?? {}
    const params = asRecord(raw.params) ?? {}
    const logTypeId = String(row.logTypeId ?? "")
    const title = String(row.title ?? (asRecord(raw.details)?.title ?? ""))
    const category = String(row.category ?? (asRecord(raw.details)?.category ?? ""))
    const color = typeof params.color === "string" ? params.color.toLowerCase() : ""

    if (logTypeId === "2535" || title.toLowerCase() === "item use halloween basket") {
      addBasketItems(data.items, basketItemTotals)
    }

    if (logTypeId === "2547" || title.toLowerCase() === "halloween basket receive energy") {
      const gained = nonNegativeNumber(data.energy_increased)
      if (gained !== null) metrics.treatExchangeEnergyGained += gained
    }

    // Torn marks the attacker's successful action green and the other side's
    // corresponding "receive" event red. Only count the attacker's own
    // successful leave, mug, or hospitalize records.
    const successfulAttack = category.toLowerCase() === "attacking" &&
      ["attack leave", "attack mug", "attack hospitalize"].includes(title.toLowerCase()) &&
      color === "green"
    if (successfulAttack) {
      const used = nonNegativeNumber(data.energy_used)
      if (used !== null) {
        metrics.successfulAttackEnergyUsed += used
        metrics.successfulAttacks += 1
      }
    }
  }

  for (const [itemId, quantity] of basketItemTotals) {
    if (BOOSTER_ITEM_IDS.has(itemId)) metrics.boosters += quantity
    if (FHC_ITEM_IDS.has(itemId)) metrics.fhcs += quantity
    if (GREEN_EGG_ITEM_IDS.has(itemId)) metrics.greenEggs += quantity
    if (ENERGY_CAN_ITEM_IDS.has(itemId)) metrics.energyCans += quantity
    if (itemId === SIX_PACK_ITEM_ID) metrics.energyCans += quantity * 6
  }

  return metrics
}

export function sumHalloweenEventMetrics(values: readonly HalloweenEventMetrics[]): HalloweenEventMetrics {
  return values.reduce((total, value) => ({
    boosters: total.boosters + value.boosters,
    energyCans: total.energyCans + value.energyCans,
    fhcs: total.fhcs + value.fhcs,
    greenEggs: total.greenEggs + value.greenEggs,
    treatExchangeEnergyGained: total.treatExchangeEnergyGained + value.treatExchangeEnergyGained,
    successfulAttackEnergyUsed: total.successfulAttackEnergyUsed + value.successfulAttackEnergyUsed,
    successfulAttacks: total.successfulAttacks + value.successfulAttacks,
  }), emptyHalloweenEventMetrics())
}
