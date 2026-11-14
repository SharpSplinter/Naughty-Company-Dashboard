export type HalloweenExchangeMarketPriceRecord = {
  itemId: string
  itemName: string
  averagePrice: number | null
  marketCacheTimestamp: number | null
  fetchedAt: number | null
}

export type HalloweenExchangeMarketValueItem = {
  itemId: string
  itemName: string
  quantity: number
  unitPrice: number | null
  estimatedValue: number | null
  marketCacheTimestamp: number | null
  fetchedAt: number | null
  stale: boolean
}

export type HalloweenExchangeMarketValue = {
  status: "empty" | "unavailable" | "partial" | "stale" | "current"
  estimatedGrossValue: number | null
  pricedItemCount: number
  itemCount: number
  unpricedItemCount: number
  snapshotAt: number | null
  items: HalloweenExchangeMarketValueItem[]
}

const STALE_AFTER_SECONDS = 2 * 60 * 60

function positiveTimestamp(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null
}

/**
 * Values the exact basket rewards recorded in Halloween exchange logs.
 * Missing prices are excluded from the subtotal and force an "at least" UI label.
 */
export function calculateHalloweenExchangeMarketValue(
  basketItemsById: Record<string, number> | null | undefined,
  prices: readonly HalloweenExchangeMarketPriceRecord[],
  nowSeconds = Math.floor(Date.now() / 1000),
): HalloweenExchangeMarketValue {
  const priceById = new Map(prices.map(price => [String(price.itemId), price]))
  const items: HalloweenExchangeMarketValueItem[] = []

  for (const [rawId, rawQuantity] of Object.entries(basketItemsById ?? {})) {
    const itemId = rawId.trim()
    const quantity = Number(rawQuantity)
    if (!/^\d+$/.test(itemId) || !Number.isSafeInteger(quantity) || quantity <= 0) continue

    const price = priceById.get(itemId)
    const rawUnitPrice = price?.averagePrice
    const unitPrice = typeof rawUnitPrice === "number" && Number.isFinite(rawUnitPrice) && rawUnitPrice > 0
      ? rawUnitPrice
      : null
    const marketCacheTimestamp = positiveTimestamp(price?.marketCacheTimestamp ?? null)
    const fetchedAt = positiveTimestamp(price?.fetchedAt ?? null)
    const effectiveTimestamp = marketCacheTimestamp ?? fetchedAt
    const stale = unitPrice !== null && (
      effectiveTimestamp === null || nowSeconds - effectiveTimestamp > STALE_AFTER_SECONDS
    )

    items.push({
      itemId,
      itemName: price?.itemName?.trim() || "Item #" + itemId,
      quantity,
      unitPrice,
      estimatedValue: unitPrice === null ? null : unitPrice * quantity,
      marketCacheTimestamp,
      fetchedAt,
      stale,
    })
  }

  items.sort((a, b) =>
    (b.estimatedValue ?? -1) - (a.estimatedValue ?? -1) ||
    a.itemName.localeCompare(b.itemName) ||
    a.itemId.localeCompare(b.itemId),
  )

  const pricedItems = items.filter(item => item.estimatedValue !== null)
  const unpricedItemCount = items.length - pricedItems.length
  const estimatedGrossValue = pricedItems.length
    ? pricedItems.reduce((sum, item) => sum + (item.estimatedValue ?? 0), 0)
    : null
  const snapshotTimes = pricedItems
    .map(item => item.marketCacheTimestamp ?? item.fetchedAt)
    .filter((timestamp): timestamp is number => timestamp !== null)
  const snapshotAt = snapshotTimes.length ? Math.min(...snapshotTimes) : null

  const status: HalloweenExchangeMarketValue["status"] = items.length === 0
    ? "empty"
    : pricedItems.length === 0
      ? "unavailable"
      : unpricedItemCount > 0
        ? "partial"
        : pricedItems.some(item => item.stale)
          ? "stale"
          : "current"

  return {
    status,
    estimatedGrossValue,
    pricedItemCount: pricedItems.length,
    itemCount: items.length,
    unpricedItemCount,
    snapshotAt,
    items,
  }
}
