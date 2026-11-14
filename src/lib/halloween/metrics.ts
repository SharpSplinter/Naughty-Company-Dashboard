export const HALLOWEEN_BOOSTER_COOLDOWN_RULES = {
  fhcHours: 6,
  greenEggHours: 6,
  energyCanHours: 2,
  maxTimerHours: 48,
  eventWindowHours: 168,
} as const

export type HalloweenBoosterCooldownEstimate = {
  fhcsUsed: number
  greenEggsUsed: number
  energyCansUsed: number
  fhcHours: number
  greenEggHours: number
  energyCanHours: number
  totalHours: number
  eventWindowHours: number
  usableHours: number
  uncoveredHours: number
  excessHours: number
}

export type HalloweenEventMetrics = {
  boosters: number
  boostersUsed: number
  energyCans: number
  energyCansUsed: number
  energyDrinkSixPacks: number
  energyDrinkSixPacksUsed: number
  alcoholSixPacks: number
  alcoholSixPacksUsed: number
  fhcs: number
  fhcsUsed: number
  greenEggs: number
  greenEggsUsed: number
  treatExchangeEnergyGained: number
  successfulAttackEnergyUsed: number
  successfulAttacks: number
  revitalizeProcs: number
  revitalizeAttacksReviewed: number
  revitalizeChanceCounts: Record<string, number>
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
const ENERGY_DRINK_SIX_PACK_ITEM_ID = "818"
const ALCOHOL_SIX_PACK_ITEM_ID = "817"

export function calculateHalloweenBoosterCooldown(
  metrics: Pick<HalloweenEventMetrics, "fhcsUsed" | "greenEggsUsed" | "energyCansUsed">,
  eventWindowHours = HALLOWEEN_BOOSTER_COOLDOWN_RULES.eventWindowHours,
): HalloweenBoosterCooldownEstimate {
  const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  const fhcsUsed = count(metrics.fhcsUsed)
  const greenEggsUsed = count(metrics.greenEggsUsed)
  const energyCansUsed = count(metrics.energyCansUsed)
  const validEventHours = Number.isFinite(eventWindowHours) && eventWindowHours >= 0
    ? eventWindowHours
    : HALLOWEEN_BOOSTER_COOLDOWN_RULES.eventWindowHours
  const fhcHours = fhcsUsed * HALLOWEEN_BOOSTER_COOLDOWN_RULES.fhcHours
  const greenEggHours = greenEggsUsed * HALLOWEEN_BOOSTER_COOLDOWN_RULES.greenEggHours
  const energyCanHours = energyCansUsed * HALLOWEEN_BOOSTER_COOLDOWN_RULES.energyCanHours
  const totalHours = fhcHours + greenEggHours + energyCanHours
  return {
    fhcsUsed,
    greenEggsUsed,
    energyCansUsed,
    fhcHours,
    greenEggHours,
    energyCanHours,
    totalHours,
    eventWindowHours: validEventHours,
    usableHours: Math.min(totalHours, validEventHours),
    uncoveredHours: Math.max(0, validEventHours - totalHours),
    excessHours: Math.max(0, totalHours - validEventHours),
  }
}

export function emptyHalloweenEventMetrics(): HalloweenEventMetrics {
  return {
    boosters: 0,
    boostersUsed: 0,
    energyCans: 0,
    energyCansUsed: 0,
    energyDrinkSixPacks: 0,
    energyDrinkSixPacksUsed: 0,
    alcoholSixPacks: 0,
    alcoholSixPacksUsed: 0,
    fhcs: 0,
    fhcsUsed: 0,
    greenEggs: 0,
    greenEggsUsed: 0,
    treatExchangeEnergyGained: 0,
    successfulAttackEnergyUsed: 0,
    successfulAttacks: 0,
    revitalizeProcs: 0,
    revitalizeAttacksReviewed: 0,
    revitalizeChanceCounts: {},
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

export type HalloweenAttackMetric = {
  attacker?: { id?: number | string | null } | null
  ended?: number | null
  is_interrupted?: boolean
  finishing_hit_effects?: Array<{ name?: string; value?: number }> | null
}

export type HalloweenRevitalizeMetrics = {
  revitalizeProcs: number
  revitalizeAttacksReviewed: number
  revitalizeChanceCounts: Record<string, number>
}

export function calculateHalloweenRevitalizeMetrics(
  attacks: readonly HalloweenAttackMetric[],
  playerId: string,
  windowStart: number,
  windowEnd: number,
): HalloweenRevitalizeMetrics {
  const result: HalloweenRevitalizeMetrics = {
    revitalizeProcs: 0,
    revitalizeAttacksReviewed: 0,
    revitalizeChanceCounts: {},
  }
  for (const attack of attacks) {
    if (String(attack.attacker?.id ?? "") !== playerId) continue
    const ended = Number(attack.ended)
    if (!Number.isFinite(ended) || ended < windowStart || ended >= windowEnd) continue
    if (attack.is_interrupted === true) continue
    result.revitalizeAttacksReviewed += 1
    for (const effect of attack.finishing_hit_effects ?? []) {
      if (effect?.name !== "revitalize") continue
      result.revitalizeProcs += 1
      const chance = Number(effect.value)
      if (Number.isInteger(chance) && chance > 0 && chance <= 100) {
        const key = String(chance)
        result.revitalizeChanceCounts[key] = (result.revitalizeChanceCounts[key] ?? 0) + 1
      }
      break
    }
  }
  return result
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

    if (category.toLowerCase() === "item use" || title.toLowerCase().startsWith("item use ")) {
      const itemId = data.item === undefined || data.item === null ? "" : String(data.item)
      const itemTitle = title.toLowerCase()
      if (BOOSTER_ITEM_IDS.has(itemId) || itemTitle.includes("erotic dvd") || itemTitle.includes("lawyer business card")) metrics.boostersUsed += 1
      if (ENERGY_CAN_ITEM_IDS.has(itemId)) metrics.energyCansUsed += 1
      if (itemId === ENERGY_DRINK_SIX_PACK_ITEM_ID || itemTitle.includes("six-pack of energy drink") || itemTitle.includes("six pack of energy drink")) {
        metrics.energyDrinkSixPacksUsed += 1
        metrics.energyCans += 6
        metrics.energyCansUsed += 6
      }
      if (itemId === ALCOHOL_SIX_PACK_ITEM_ID || itemTitle.includes("six-pack of alcohol") || itemTitle.includes("six pack of alcohol")) metrics.alcoholSixPacksUsed += 1
      if (FHC_ITEM_IDS.has(itemId) || itemTitle.includes("feathery hotel coupon")) metrics.fhcsUsed += 1
      if (GREEN_EGG_ITEM_IDS.has(itemId) || itemTitle.includes("green easter egg")) metrics.greenEggsUsed += 1
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
    if (itemId === ENERGY_DRINK_SIX_PACK_ITEM_ID) metrics.energyDrinkSixPacks += quantity
    if (itemId === ALCOHOL_SIX_PACK_ITEM_ID) metrics.alcoholSixPacks += quantity
  }

  return metrics
}

export function sumHalloweenEventMetrics(values: readonly HalloweenEventMetrics[]): HalloweenEventMetrics {
  return values.reduce((total, value) => ({
    boosters: total.boosters + value.boosters,
    boostersUsed: total.boostersUsed + value.boostersUsed,
    energyCans: total.energyCans + value.energyCans,
    energyCansUsed: total.energyCansUsed + value.energyCansUsed,
    energyDrinkSixPacks: total.energyDrinkSixPacks + value.energyDrinkSixPacks,
    energyDrinkSixPacksUsed: total.energyDrinkSixPacksUsed + value.energyDrinkSixPacksUsed,
    alcoholSixPacks: total.alcoholSixPacks + value.alcoholSixPacks,
    alcoholSixPacksUsed: total.alcoholSixPacksUsed + value.alcoholSixPacksUsed,
    fhcs: total.fhcs + value.fhcs,
    fhcsUsed: total.fhcsUsed + value.fhcsUsed,
    greenEggs: total.greenEggs + value.greenEggs,
    greenEggsUsed: total.greenEggsUsed + value.greenEggsUsed,
    treatExchangeEnergyGained: total.treatExchangeEnergyGained + value.treatExchangeEnergyGained,
    successfulAttackEnergyUsed: total.successfulAttackEnergyUsed + value.successfulAttackEnergyUsed,
    successfulAttacks: total.successfulAttacks + value.successfulAttacks,
    revitalizeProcs: total.revitalizeProcs + value.revitalizeProcs,
    revitalizeAttacksReviewed: total.revitalizeAttacksReviewed + value.revitalizeAttacksReviewed,
    revitalizeChanceCounts: Object.entries(value.revitalizeChanceCounts).reduce((counts, [chance, count]) => {
      counts[chance] = (counts[chance] ?? 0) + count
      return counts
    }, { ...total.revitalizeChanceCounts } as Record<string, number>),
  }), emptyHalloweenEventMetrics())
}
