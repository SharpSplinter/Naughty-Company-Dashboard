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
  practicalFhcTarget: number
  theoreticalMaxFhcs: number
  theoreticalMaxEnergyCans: number
  theoreticalFhcCooldownLimitHours: number
  theoreticalEnergyCanCooldownLimitHours: number
  theoreticalCooldownLimitHours: number
  timingBufferHours: number
  hoursBeyondTheoreticalLimit: number
  fhcsAboveTheoreticalMaximum: number
  withinTheoreticalLimit: boolean
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
  successfulAttacksWithTreats: number
  lostStalematedAttacks: number
  treatsByAttack: Record<string, number>
  doublerProcs: number
  triplerProcs: number
  quadruplerProcs: number
  quintuplerProcs: number
  unclassifiedTreatAwards: number
  catInHellJackpots: number
  multipackProcs: number
  dealWithDevilProcs: number
  revitalizeProcs: number
  revitalizeSuccessfulAttacks: number
  revitalizeAttacksReviewed: number
  revitalizeChanceCounts: Record<string, number>
}

export type HalloweenEventMetricLogRow = {
  logTypeId: number | string | null
  title?: string | null
  category?: string | null
  /** Known base treat amount for NPC attacks. Standard player attacks default to one. */
  baseTreats?: number | null
  logJson: string | null
}

const BOOSTER_ITEM_IDS = new Set(["366", "368"])
const FHC_ITEM_IDS = new Set(["367"])
const GREEN_EGG_ITEM_IDS = new Set(["473"])
const ENERGY_CAN_ITEM_IDS = new Set(["530", "532", "533", "553", "554", "555", "985", "986", "987"])
const ENERGY_DRINK_SIX_PACK_ITEM_ID = "818"
const ALCOHOL_SIX_PACK_ITEM_ID = "817"
const MULTIPACK_ITEM_IDS = new Set(["817", "818", "1298"])
const DEAL_WITH_THE_DEVIL_ITEM_IDS = new Set(["366", "367", "396", "428"])
/** Multiplier product -> upgrades that procced. The standard player base award is one treat. */
export const HALLOWEEN_TREAT_MULTIPLIER_COMBINATIONS: Record<
  number,
  Array<"doubler" | "tripler" | "quadrupler" | "quintupler">
> = {
  1: [],
  2: ["doubler"],
  3: ["tripler"],
  4: ["quadrupler"],
  5: ["quintupler"],
  6: ["doubler", "tripler"],
  8: ["doubler", "quadrupler"],
  10: ["doubler", "quintupler"],
  12: ["tripler", "quadrupler"],
  15: ["tripler", "quintupler"],
  20: ["quadrupler", "quintupler"],
  24: ["doubler", "tripler", "quadrupler"],
  30: ["doubler", "tripler", "quintupler"],
  40: ["doubler", "quadrupler", "quintupler"],
  60: ["tripler", "quadrupler", "quintupler"],
  120: ["doubler", "tripler", "quadrupler", "quintupler"],
}

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

  // A final 6h booster may be used just below the 48h timer threshold, so
  // the total added cooldown must remain strictly below event + 48h + 6h.
  // The strict inequality matters: at exactly 48h, another item is not ready.
  const theoreticalFhcCooldownLimitHours =
    validEventHours +
    HALLOWEEN_BOOSTER_COOLDOWN_RULES.maxTimerHours +
    HALLOWEEN_BOOSTER_COOLDOWN_RULES.fhcHours
  // An Energy-Can-only run can overfill the 48h cap by only one 2h can.
  const theoreticalEnergyCanCooldownLimitHours =
    validEventHours +
    HALLOWEEN_BOOSTER_COOLDOWN_RULES.maxTimerHours +
    HALLOWEEN_BOOSTER_COOLDOWN_RULES.energyCanHours
  // When the logged mix includes a 6h item, that item could be the final
  // overfill. A can-only run has only the smaller 2h final-can allowance.
  const theoreticalCooldownLimitHours = fhcsUsed > 0 || greenEggsUsed > 0 || energyCansUsed === 0
    ? theoreticalFhcCooldownLimitHours
    : theoreticalEnergyCanCooldownLimitHours
  const otherItemHours = greenEggHours + energyCanHours
  const theoreticalMaxFhcs = Math.max(0, Math.ceil(
    theoreticalFhcCooldownLimitHours / HALLOWEEN_BOOSTER_COOLDOWN_RULES.fhcHours,
  ) - 1)
  const theoreticalMaxEnergyCans = Math.max(0, Math.ceil(
    theoreticalEnergyCanCooldownLimitHours / HALLOWEEN_BOOSTER_COOLDOWN_RULES.energyCanHours,
  ) - 1)
  // The practical FHC target assumes the final item is an FHC, subtracts the
  // member's logged green eggs/cans, then keeps one more 6h FHC as margin.
  const maxFhcsAfterOtherItems = Math.max(0, Math.ceil(
    (theoreticalFhcCooldownLimitHours - otherItemHours) / HALLOWEEN_BOOSTER_COOLDOWN_RULES.fhcHours,
  ) - 1)
  const practicalFhcTarget = Math.max(0, maxFhcsAfterOtherItems - 1)
  const timingBufferHours = theoreticalCooldownLimitHours - totalHours
  const withinTheoreticalLimit = totalHours < theoreticalCooldownLimitHours &&
    fhcsUsed <= theoreticalMaxFhcs

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
    practicalFhcTarget,
    theoreticalMaxFhcs,
    theoreticalMaxEnergyCans,
    theoreticalFhcCooldownLimitHours,
    theoreticalEnergyCanCooldownLimitHours,
    theoreticalCooldownLimitHours,
    timingBufferHours,
    hoursBeyondTheoreticalLimit: Math.max(0, totalHours - theoreticalCooldownLimitHours),
    fhcsAboveTheoreticalMaximum: Math.max(0, fhcsUsed - theoreticalMaxFhcs),
    withinTheoreticalLimit,
  }
}


/** Dashboard Boosters are intentionally narrower than Torn's full booster-item category. */
export function calculateHalloweenDashboardBoostersReceived(
  metrics: Pick<HalloweenEventMetrics, "energyCans" | "fhcs" | "greenEggs">,
): number {
  return metrics.energyCans + metrics.fhcs + metrics.greenEggs
}

/** Used-count counterpart of the dashboard's Energy Cans + FHCs + Green Easter Eggs definition. */
export function calculateHalloweenDashboardBoostersUsed(
  metrics: Pick<HalloweenEventMetrics, "energyCansUsed" | "fhcsUsed" | "greenEggsUsed">,
): number {
  return metrics.energyCansUsed + metrics.fhcsUsed + metrics.greenEggsUsed
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
    successfulAttacksWithTreats: 0,
    lostStalematedAttacks: 0,
    treatsByAttack: {},
    doublerProcs: 0,
    triplerProcs: 0,
    quadruplerProcs: 0,
    quintuplerProcs: 0,
    unclassifiedTreatAwards: 0,
    catInHellJackpots: 0,
    multipackProcs: 0,
    dealWithDevilProcs: 0,
    revitalizeProcs: 0,
    revitalizeSuccessfulAttacks: 0,
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
  result?: string | null
  is_interrupted?: boolean
  finishing_hit_effects?: Array<{ name?: string; value?: number }> | null
}

export type HalloweenRevitalizeMetrics = {
  revitalizeProcs: number
  revitalizeAttacksReviewed: number
  successfulAttacks: number
  lostStalematedAttacks: number
  revitalizeChanceCounts: Record<string, number>
}

export function calculateHalloweenRevitalizeProcRate(
  metrics: Pick<HalloweenEventMetrics, "revitalizeProcs" | "revitalizeSuccessfulAttacks"> | null | undefined,
): number | null {
  const successfulProcs = Number(metrics?.revitalizeProcs)
  const successfulAttacks = Number(metrics?.revitalizeSuccessfulAttacks)
  if (!Number.isFinite(successfulProcs) || successfulProcs < 0 || !Number.isFinite(successfulAttacks) || successfulAttacks <= 0) return null
  return (successfulProcs / successfulAttacks) * 100
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
    successfulAttacks: 0,
    lostStalematedAttacks: 0,
    revitalizeChanceCounts: {},
  }
  for (const attack of attacks) {
    if (String(attack.attacker?.id ?? "") !== playerId) continue
    const ended = Number(attack.ended)
    if (!Number.isFinite(ended) || ended < windowStart || ended >= windowEnd) continue
    const outcome = String(attack.result ?? "").toLowerCase()
    if (["attacked", "mugged", "hospitalized", "arrested"].includes(outcome)) {
      result.successfulAttacks += 1
    } else if (outcome === "lost" || outcome === "stalemate") {
      result.lostStalematedAttacks += 1
    }
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

    // Only the Trick or Treat subtype represents an attack reward. Cashback
    // and Freebie are exchange bonuses and must not inflate attacks-with-treats
    // or the per-attack treat histogram.
    if (logTypeId === "2536") {
      const treatType = String(data.type ?? "").replace(/[()]/g, "").trim().toLowerCase()
      const treats = nonNegativeNumber(data.treats)
      if (treatType === "trick or treat" && treats !== null && Number.isInteger(treats) && treats > 0) {
        metrics.successfulAttacksWithTreats += 1
        const key = String(treats)
        metrics.treatsByAttack[key] = (metrics.treatsByAttack[key] ?? 0) + 1
        // Cat in Hell is a flat 1,000-treat jackpot and is never multiplied.
        if (treats === 1000) {
          metrics.catInHellJackpots += 1
          continue
        }
        // Multiplier decoding uses the known base amount. Standard player
        // attacks default to one; callers may provide the base for NPC attacks.
        const baseTreats = nonNegativeNumber(
          row.baseTreats ?? data.base_treats ?? data.baseTreats ?? 1,
        )
        const multiplier = baseTreats !== null && Number.isInteger(baseTreats) && baseTreats > 0 &&
          treats % baseTreats === 0
          ? treats / baseTreats
          : Number.NaN
        const procs = HALLOWEEN_TREAT_MULTIPLIER_COMBINATIONS[multiplier]
        if (!procs) {
          metrics.unclassifiedTreatAwards += 1
        } else {
          for (const perk of procs) {
            if (perk === "doubler") metrics.doublerProcs += 1
            else if (perk === "tripler") metrics.triplerProcs += 1
            else if (perk === "quadrupler") metrics.quadruplerProcs += 1
            else if (perk === "quintupler") metrics.quintuplerProcs += 1
          }
        }
      }
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
    if (MULTIPACK_ITEM_IDS.has(itemId)) metrics.multipackProcs += quantity
    if (DEAL_WITH_THE_DEVIL_ITEM_IDS.has(itemId)) metrics.dealWithDevilProcs += quantity
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
    successfulAttacksWithTreats: total.successfulAttacksWithTreats + value.successfulAttacksWithTreats,
    lostStalematedAttacks: total.lostStalematedAttacks + value.lostStalematedAttacks,
    treatsByAttack: Object.entries(value.treatsByAttack).reduce((counts, [treats, count]) => {
      counts[treats] = (counts[treats] ?? 0) + count
      return counts
    }, { ...total.treatsByAttack } as Record<string, number>),
    doublerProcs: total.doublerProcs + value.doublerProcs,
    triplerProcs: total.triplerProcs + value.triplerProcs,
    quadruplerProcs: total.quadruplerProcs + value.quadruplerProcs,
    quintuplerProcs: total.quintuplerProcs + value.quintuplerProcs,
    unclassifiedTreatAwards: total.unclassifiedTreatAwards + value.unclassifiedTreatAwards,
    catInHellJackpots: total.catInHellJackpots + value.catInHellJackpots,
    multipackProcs: total.multipackProcs + value.multipackProcs,
    dealWithDevilProcs: total.dealWithDevilProcs + value.dealWithDevilProcs,
    revitalizeProcs: total.revitalizeProcs + value.revitalizeProcs,
    revitalizeSuccessfulAttacks: total.revitalizeSuccessfulAttacks + value.revitalizeSuccessfulAttacks,
    revitalizeAttacksReviewed: total.revitalizeAttacksReviewed + value.revitalizeAttacksReviewed,
    revitalizeChanceCounts: Object.entries(value.revitalizeChanceCounts).reduce((counts, [chance, count]) => {
      counts[chance] = (counts[chance] ?? 0) + count
      return counts
    }, { ...total.revitalizeChanceCounts } as Record<string, number>),
  }), emptyHalloweenEventMetrics())
}
