export type PrivateLiveBarName = "energy" | "nerve" | "happy" | "life"

export type PrivateLiveBars = Record<PrivateLiveBarName, {
  current: number | null
  maximum: number | null
}>

export type PrivateLiveCooldowns = {
  drug: number | null
  booster: number | null
  medical: number | null
}

export type PrivateLiveNetworth = {
  total: number
  auctionhouse?: number
  bank?: number
  bazaar?: number
  bookie?: number
  cayman?: number
  company?: number
  displaycase?: number
  enlistedcars?: number
  itemmarket?: number
  items?: number
  loan?: number
  pending?: number
  piggybank?: number
  points?: number
  properties?: number
  stockmarket?: number
  trade?: number
  unpaidfees?: number
  vault?: number
  wallet?: number
  timestamp?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function nestedRecord(payload: unknown, field: string): Record<string, unknown> {
  if (!isRecord(payload)) throw new Error("Torn returned an unexpected private live response.")
  const value = payload[field]
  if (!isRecord(value)) throw new Error("Torn did not return the requested " + field + " data.")
  return value
}

/** Keep only the four numeric owner bars. Missing fields remain null. */
export function parsePrivateLiveBars(payload: unknown): PrivateLiveBars {
  const root = nestedRecord(payload, "bars")
  const names: PrivateLiveBarName[] = ["energy", "nerve", "happy", "life"]
  const bars = {} as PrivateLiveBars
  let known = 0
  for (const name of names) {
    const source = isRecord(root[name]) ? root[name] as Record<string, unknown> : null
    const current = source ? finiteNumber(source.current ?? source.value) : null
    const maximum = source ? finiteNumber(source.maximum ?? source.max) : null
    if (current !== null || maximum !== null) known++
    bars[name] = { current, maximum }
  }
  if (!known) throw new Error("Torn returned no recognized owner bar values.")
  return bars
}

/** Cooldowns are remaining seconds. A missing field is unknown, not ready. */
export function parsePrivateLiveCooldowns(payload: unknown): PrivateLiveCooldowns {
  const root = nestedRecord(payload, "cooldowns")
  const cooldowns: PrivateLiveCooldowns = {
    drug: finiteNumber(root.drug),
    booster: finiteNumber(root.booster),
    medical: finiteNumber(root.medical),
  }
  if (cooldowns.drug === null && cooldowns.booster === null && cooldowns.medical === null) {
    throw new Error("Torn returned no recognized owner cooldown values.")
  }
  return cooldowns
}

/** Optional detailed networth is reduced to documented numeric fields only. */
export function parsePrivateLiveNetworth(payload: unknown): PrivateLiveNetworth {
  const root = nestedRecord(payload, "networth")
  const total = finiteNumber(root.total)
  if (total === null) throw new Error("Torn did not return a valid detailed networth total.")
  const names: Array<keyof Omit<PrivateLiveNetworth, "total">> = [
    "auctionhouse", "bank", "bazaar", "bookie", "cayman", "company", "displaycase",
    "enlistedcars", "itemmarket", "items", "loan", "pending", "piggybank", "points",
    "properties", "stockmarket", "trade", "unpaidfees", "vault", "wallet", "timestamp",
  ]
  const result: PrivateLiveNetworth = { total }
  for (const name of names) {
    const value = finiteNumber(root[name])
    if (value !== null) result[name] = value
  }
  return result
}
