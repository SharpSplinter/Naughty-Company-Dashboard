export type ChristmasTownEventLogRow = {
  logId: string
  timestamp: number
  title: string | null
  category: string | null
  logJson: string | null
}

export type ChristmasTownGameMetric = { key: string; label: string; count: number }

export type ChristmasTownChestEvent = {
  timestamp: number
  rewardsById: Record<string, number>
  estimatedValue: number | null
}
export type ChristmasTownChestBestWorst = { timestamp: number; estimatedValue: number; rewardsById: Record<string, number> }

export type ChristmasTownChestMetric = {
  key: "bronze" | "silver" | "gold" | "combination"
  label: string
  opened: number
  items: number
  rewardsById: Record<string, number>
  events: ChristmasTownChestEvent[]
  estimatedValue: number | null
  valuePerChest: number | null
  valuePerItem: number | null
  best: ChristmasTownChestBestWorst | null
  worst: ChristmasTownChestBestWorst | null
}

export type ChristmasTownItemMetric = {
  itemId: string
  itemName: string
  quantity: number
  group: "chest" | "minigame" | "santa" | "present" | "coupon" | "wheel" | "pot" | "other"
  unitPrice: number | null
  estimatedValue: number | null
}

export type ChristmasTownMetrics = {
  fromTimestamp: number | null
  toTimestamp: number | null
  days: number
  logCount: number
  totalItems: number
  totalPricedItems: number
  unpricedItems: number
  estimatedValue: number | null
  estimatedValuePerDay: number | null
  estimatedValuePerItem: number | null
  minigames: ChristmasTownGameMetric[]
  santaVisits: number
  gifts: number
  itemFinds: number
  hatsAdded: number
  hatNames: Record<string, number>
  ornamentsAdded: number
  ornamentsBought: number
  ornamentsOther: number
  ornaments: Record<string, number>
  keysFound: { bronze: number; silver: number; gold: number }
  chests: ChristmasTownChestMetric[]
  christmasBucksGained: number
  christmasBucksSpent: number
  christmasBucksSpentByItem: Record<string, number>
  prizeCouponsGained: number
  prizeCouponsSpent: number
  prizeCouponsExchanged: number
  prizeCouponItems: number
  prizeCouponItemsById: Record<string, number>
  pot: { roundsWon: number; itemsDeposited: number; depositValue: number | null; itemsWon: number; wonValue: number | null }
  potDepositedById: Record<string, number>
  potWonById: Record<string, number>
  receivedItemsById: Record<string, number>
  itemNamesById: Record<string, string>
  purchasedItemsById: Record<string, number>
  items: ChristmasTownItemMetric[]
}

type ItemAccumulator = { itemId: string; itemName: string; quantity: number; group: ChristmasTownItemMetric["group"] }

type LogData = {
  raw: Record<string, unknown>
  data: Record<string, unknown>
  params: Record<string, unknown>
  details: Record<string, unknown>
  text: string
  title: string
  category: string
}

const GAME_DEFINITIONS = [
  { key: "present_pick", label: "Present Pick", pattern: /present pick|picked out (?:a )?present/ },
  { key: "spin_the_wheel", label: "Spin The Wheel", pattern: /spin(?:ned)? the (?:christmas )?wheel/ },
  { key: "garland_assemble", label: "Garland Assemble", pattern: /garland assemble|assembled (?:a )?garland/ },
  { key: "santa_claws", label: "Santa Claws", pattern: /santa claws/ },
  { key: "gingerbread_men", label: "Gingerbread Men", pattern: /gingerbread men|gingerbread man/ },
  { key: "word_fixer", label: "Word Fixer", pattern: /word fixer/ },
  { key: "hangman", label: "Hangman", pattern: /hangman/ },
  { key: "christmas_wreath", label: "Christmas Wreath", pattern: /christmas wreath/ },
  { key: "snowball_shooter", label: "Snowball Shooter", pattern: /snowball shooter/ },
  { key: "typocalypse", label: "Typocalypse", pattern: /typocalypse/ },
] as const

const CHEST_DEFINITIONS = [
  { key: "bronze", label: "Bronze Chest", pattern: /bronze chest/ },
  { key: "silver", label: "Silver Chest", pattern: /silver chest/ },
  { key: "gold", label: "Gold Chest", pattern: /(?:gold|golden) chest/ },
  { key: "combination", label: "Combination Chest", pattern: /combination chest/ },
] as const

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseRow(row: ChristmasTownEventLogRow): LogData | null {
  if (!row.logJson) return null
  try {
    const raw = record(JSON.parse(row.logJson))
    if (!Object.keys(raw).length) return null
    const details = record(raw.details)
    const data = record(raw.data)
    const params = record(raw.params)
    const title = [row.title, details.title, raw.title].find(value => typeof value === "string" && value.trim()) as string | undefined ?? ""
    const category = [row.category, details.category, raw.category].find(value => typeof value === "string" && value.trim()) as string | undefined ?? ""
    const text = (title + " " + category + " " + JSON.stringify(data) + " " + JSON.stringify(params)).toLowerCase()
    return { raw, data, params, details, title, category, text }
  } catch {
    return null
  }
}

function extractItems(value: unknown, fallbackGroup: ChristmasTownItemMetric["group"]): ItemAccumulator[] {
  const result: ItemAccumulator[] = []
  const add = (idValue: unknown, quantityValue: unknown, nameValue?: unknown) => {
    const rawId = typeof idValue === "number" || typeof idValue === "string" ? String(idValue).trim() : ""
    if (!/^\d+$/.test(rawId)) return
    const quantity = numeric(quantityValue) ?? 1
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return
    const itemName = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : "Item #" + rawId
    result.push({ itemId: rawId, itemName, quantity, group: fallbackGroup })
  }
  if (typeof value === "string") {
    if (value.includes(",")) {
      for (const id of value.split(",")) add(id, 1)
    } else if (/^\d+$/.test(value.trim())) {
      add(value.trim(), 1)
    }
    return result
  }
  if (typeof value === "number") {
    add(value, 1)
    return result
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" || typeof entry === "number") add(entry, 1)
      else {
        const item = record(entry)
        add(item.id ?? item.item_id ?? item.itemId ?? item.item, item.quantity ?? item.amount ?? item.count ?? 1, item.name ?? item.item_name ?? item.itemName)
      }
    }
    return result
  }
  const object = record(value)
  for (const [id, quantityValue] of Object.entries(object)) {
    if (/^\d+$/.test(id)) {
      if (typeof quantityValue === "object" && quantityValue !== null) {
        const item = record(quantityValue)
        add(item.id ?? id, item.quantity ?? item.amount ?? item.count ?? 1, item.name ?? item.item_name ?? item.itemName)
      } else add(id, quantityValue)
      continue
    }
    const nested = record(quantityValue)
    const idValue = nested.id ?? nested.item_id ?? nested.itemId ?? nested.item
    if (idValue !== undefined) add(idValue, nested.quantity ?? nested.amount ?? nested.count ?? 1, nested.name ?? nested.item_name ?? nested.itemName)
  }
  return result
}

function itemsFromData(data: Record<string, unknown>, group: ChristmasTownItemMetric["group"]): ItemAccumulator[] {
  const keys = ["items", "received_items", "receivedItems", "rewards", "loot", "item_rewards", "itemRewards"]
  let found: ItemAccumulator[] = []
  for (const key of keys) {
    if (data[key] === undefined || data[key] === null) continue
    found = extractItems(data[key], group)
    if (found.length) break
  }
  if (!found.length) {
    const primary = data.item ?? data.item_id ?? data.itemId ?? data.reward_item
    if (primary !== undefined && primary !== null) {
      const item = record(primary)
      found = Object.keys(item).length ? extractItems([item], group) : extractItems(primary, group)
    }
  }
  return found
}

function logGroup(text: string): ChristmasTownItemMetric["group"] {
  if (/chest/.test(text)) return "chest"
  if (/present pick|picked out (?:a )?present|minigame|completed (?:santa claws|gingerbread|word fixer|hangman|christmas wreath|snowball shooter|typocalypse|garland)/.test(text)) return "minigame"
  if (/santa|grotto/.test(text)) return "santa"
  if (/coupon|exchange/.test(text)) return "coupon"
  if (/wheel|spin/.test(text)) return "wheel"
  if (/pot|deposited|won the pot/.test(text)) return "pot"
  if (/gift|present/.test(text)) return "present"
  return "other"
}

function sumMap(target: Record<string, number>, key: string, amount: number): void {
  target[key] = (target[key] ?? 0) + amount
}

export function calculateChristmasTownMetrics(
  rows: readonly ChristmasTownEventLogRow[],
): ChristmasTownMetrics {
  const logs = rows
    .map(row => ({ row, parsed: parseRow(row) }))
    .filter((entry): entry is { row: ChristmasTownEventLogRow; parsed: LogData } => entry.parsed !== null)
    .sort((a, b) => a.row.timestamp - b.row.timestamp || a.row.logId.localeCompare(b.row.logId))

  const gameCounts = new Map<string, number>()
  const gameLabels = new Map<string, string>()
  const receivedItems = new Map<string, ItemAccumulator>()
  const itemNamesById: Record<string, string> = {}
  const purchasedItemsById: Record<string, number> = {}
  const ornaments: Record<string, number> = {}
  const hatNames: Record<string, number> = {}
  const bucksSpentByItem: Record<string, number> = {}
  const prizeCouponItemsById: Record<string, number> = {}
  const chestGroups = new Map<string, { key: "bronze" | "silver" | "gold" | "combination"; timestamp: number; rewards: Record<string, number> }>()
  const minTimestamps: number[] = []
  const maxTimestamps: number[] = []
  const activeDays = new Set<string>()
  const keysFound = { bronze: 0, silver: 0, gold: 0 }
  let santaVisits = 0
  let gifts = 0
  let itemFinds = 0
  let hatsAdded = 0
  let ornamentsBought = 0
  let ornamentsOther = 0
  let christmasBucksGained = 0
  let christmasBucksSpent = 0
  let prizeCouponsGained = 0
  let prizeCouponsSpent = 0
  let prizeCouponsExchanged = 0
  let potRoundsWon = 0
  let potItemsDeposited = 0
  let potItemsWon = 0
  const potDepositedById: Record<string, number> = {}
  const potWonById: Record<string, number> = {}
  const seenActions = new Set<string>()

  for (const { row, parsed } of logs) {
    const { data, text, title } = parsed
    const timestamp = Math.floor(Number(row.timestamp))
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue
    minTimestamps.push(timestamp)
    maxTimestamps.push(timestamp)
    activeDays.add(new Date(timestamp * 1000).toISOString().slice(0, 10))

    const isChestOpen = /open(?:ed)? .*chest/.test(text)
    const chestDefinition = CHEST_DEFINITIONS.find(chest => chest.pattern.test(text))
    const group = logGroup(text)
    const items = itemsFromData(data, group)
    for (const item of items) {
      if (!itemNamesById[item.itemId] || itemNamesById[item.itemId].startsWith("Item #")) {
        itemNamesById[item.itemId] = item.itemName
      }
    }
    const actionText = (title + " " + parsed.category).toLowerCase()
    if (/buy|bought|purchase|purchased|shop/.test(actionText)) {
      for (const item of items) sumMap(purchasedItemsById, item.itemId, item.quantity)
    }

    const isPrizeCouponExchange = /exchange[d]? .*coupon|coupon exchange|exchanged .* coupons/.test(text)
    const isPotWin = /won .*pot|pot winner|won the pot/.test(text)
    const isOutgoingItemLog = /deposited|spent|used|bought|purchase|purchased|donated|sold/.test(actionText)
    const isReceivedItemLog = !isOutgoingItemLog || isPrizeCouponExchange || isPotWin
    for (const item of items) {
      const isCurrency = /christmas buck|prize coupon/i.test(item.itemName)
      if (isReceivedItemLog && !isCurrency) {
        const key = item.group + ":" + item.itemId
        const existing = receivedItems.get(key)
        if (existing) {
          existing.quantity += item.quantity
          if (existing.itemName.startsWith("Item #") && !item.itemName.startsWith("Item #")) existing.itemName = item.itemName
        } else receivedItems.set(key, { ...item })
      }
      if (item.itemName.toLowerCase().includes("bronze key")) keysFound.bronze += item.quantity
      if (item.itemName.toLowerCase().includes("silver key")) keysFound.silver += item.quantity
      if (item.itemName.toLowerCase().includes("gold key") || item.itemName.toLowerCase().includes("golden key")) keysFound.gold += item.quantity
      if (item.itemName.toLowerCase().includes("ornament")) {
        sumMap(ornaments, item.itemName, item.quantity)
        if (/buy|bought|purchase|purchased|shop|spent/.test(actionText)) ornamentsBought += item.quantity
        else ornamentsOther += item.quantity
      }
      if (/hat/i.test(item.itemName)) sumMap(hatNames, item.itemName, item.quantity)
    }

    const structuredBuckKey = Object.keys(data).find(key => /christmas.?bucks?(?:_gained|_received|_spent)?|bucks_(?:gained|received|spent)/i.test(key))
    const structuredBucks = structuredBuckKey ? numeric(data[structuredBuckKey]) : null
    const buckItems = items.filter(item => /christmas buck/i.test(item.itemName)).reduce((sum, item) => sum + item.quantity, 0)
    const buckTextAmount = text.match(/(\d+)\s*(?:x\s*)?christmas bucks?/i)
    if (structuredBucks !== null) {
      if (/spent|used|cost/i.test(actionText) || /spent/i.test(structuredBuckKey ?? "")) christmasBucksSpent += structuredBucks
      else christmasBucksGained += structuredBucks
    } else if (buckTextAmount) {
      const amount = Number(buckTextAmount[1])
      if (/spent|used|cost|bought|shop/.test(actionText)) christmasBucksSpent += amount
      else christmasBucksGained += amount
    } else if (buckItems > 0) {
      if (/spent|used|cost|bought|shop/.test(actionText)) christmasBucksSpent += buckItems
      else christmasBucksGained += buckItems
    }

    const couponAmount = numeric(data.prize_coupons ?? data.prizeCoupons ?? data.coupons_received)
    const couponItems = items.filter(item => /prize coupon/i.test(item.itemName)).reduce((sum, item) => sum + item.quantity, 0)
    const couponTextAmount = text.match(/(\d+)\s*(?:x\s*)?prize coupons?/i)
    if (couponAmount !== null && couponAmount > 0) prizeCouponsGained += couponAmount
    else if (couponItems > 0) prizeCouponsGained += couponItems
    else if (couponTextAmount && /receive|received|gain|gained|won|awarded/.test(actionText)) prizeCouponsGained += Number(couponTextAmount[1])

    for (const game of GAME_DEFINITIONS) {
      if (game.pattern.test(text)) {
        const actionKey = timestamp + ":" + game.key
        if (!seenActions.has(actionKey)) {
          seenActions.add(actionKey)
          gameCounts.set(game.key, (gameCounts.get(game.key) ?? 0) + 1)
          gameLabels.set(game.key, game.label)
          if (/prize coupon/.test(text) && couponAmount === null && couponItems === 0) prizeCouponsGained += 1
        }
        break
      }
    }

    if (/visited santa|visit(?:ed)? santa|santa's grotto|santas grotto/.test(text)) {
      const actionKey = timestamp + ":santa-visit"
      if (!seenActions.has(actionKey)) { seenActions.add(actionKey); santaVisits += 1 }
    }
    if (/gift|present/.test(actionText) && /receive|received|collect|collected|open|opened/.test(actionText) && !/present pick|picked out/.test(actionText)) {
      const actionKey = timestamp + ":gift"
      if (!seenActions.has(actionKey)) { seenActions.add(actionKey); gifts += 1 }
    }
    if (/found .* in christmas town|found .*christmas town/.test(text) && !/key|chest|ornament/.test(text)) {
      const actionKey = timestamp + ":item-find"
      if (!seenActions.has(actionKey)) { seenActions.add(actionKey); itemFinds += 1 }
    }
    if (/hat/.test(actionText) && /add|added|receive|received|found|unlocked/.test(actionText)) {
      const actionKey = timestamp + ":hat-add"
      if (!seenActions.has(actionKey) && !items.some(item => /hat/i.test(item.itemName))) {
        seenActions.add(actionKey)
        hatsAdded += 1
      }
    }
    if (/ornament/.test(actionText) && /add|added|receive|received|found|collected|unlocked/.test(actionText) && !items.some(item => /ornament/i.test(item.itemName))) {
      const match = title.match(/(?:the )?(.+? ornament)/i)
      if (match) {
        sumMap(ornaments, match[1].trim(), 1)
        if (/buy|bought|purchase|purchased|shop|spent/.test(actionText)) ornamentsBought += 1
        else ornamentsOther += 1
      }
    }

    const couponExchangeMatch = text.match(/exchanged\s+(\d+)\s+(?:prize\s+)?coupons?/)
    if (/exchange[d]? .*coupon|coupon exchange|exchanged .* coupons/.test(text)) {
      prizeCouponsExchanged += 1
      if (couponExchangeMatch) prizeCouponsSpent += Number(couponExchangeMatch[1])
      else {
        const spentCoupons = numeric(data.prize_coupons_spent ?? data.prizeCouponsSpent ?? data.coupons_exchanged ?? data.coupons_spent)
        if (spentCoupons !== null) prizeCouponsSpent += spentCoupons
      }
    }
    if (/exchanged .*coupon/.test(text) || /coupon exchange/.test(text)) {
      for (const item of items) sumMap(prizeCouponItemsById, item.itemId, item.quantity)
    }

    const spentOnItem = /christmas buck|buck shop|spent .*buck|bought .*buck/.test(text)
    if (spentOnItem) {
      for (const item of items) {
        const name = item.itemName
        sumMap(bucksSpentByItem, name, item.quantity)
      }
    }

    if (/found .*bronze key/.test(text) && !items.some(item => /bronze key/i.test(item.itemName))) keysFound.bronze += 1
    if (/found .*silver key/.test(text) && !items.some(item => /silver key/i.test(item.itemName))) keysFound.silver += 1
    if (/found .*(?:gold|golden) key/.test(text) && !items.some(item => /gold(?:en)? key/i.test(item.itemName))) keysFound.gold += 1
    if (/deposited .*pot|christmas town'?s pot/.test(text)) {
      const countMatch = text.match(/deposited\s+(\d+)\s+items?/)
      const depositedCount = items.reduce((sum, item) => sum + item.quantity, 0)
      potItemsDeposited += depositedCount || (countMatch ? Number(countMatch[1]) : 1)
      for (const item of items) sumMap(potDepositedById, item.itemId, item.quantity)
    }
    if (/won .*pot|pot winner|won the pot/.test(text)) {
      const actionKey = timestamp + ":pot-win"
      if (!seenActions.has(actionKey)) {
        seenActions.add(actionKey)
        potRoundsWon += 1
      }
      potItemsWon += items.reduce((sum, item) => sum + item.quantity, 0)
      for (const item of items) sumMap(potWonById, item.itemId, item.quantity)
    }

    if (isChestOpen && chestDefinition) {
      const eventKey = timestamp + ":" + chestDefinition.key
      const event = chestGroups.get(eventKey) ?? { key: chestDefinition.key, timestamp, rewards: {} }
      for (const item of items) {
        if (!/christmas buck|prize coupon/i.test(item.itemName) && !/christmas buck|prize coupon/.test(text)) {
          sumMap(event.rewards, item.itemId, item.quantity)
        }
      }
      chestGroups.set(eventKey, event)
    }
  }

  const fromTimestamp = minTimestamps.length ? Math.min(...minTimestamps) : null
  const toTimestamp = maxTimestamps.length ? Math.max(...maxTimestamps) : null
  // Torn.report's daily average uses days with recorded Christmas Town activity,
  // not the many dormant calendar days between annual event seasons.
  const days = activeDays.size

  const chestMetrics: ChristmasTownChestMetric[] = CHEST_DEFINITIONS.map(definition => {
    const sourceEvents = Array.from(chestGroups.values()).filter(event => event.key === definition.key)
    const events: ChristmasTownChestEvent[] = sourceEvents.map(event => ({
      timestamp: event.timestamp,
      rewardsById: event.rewards,
      estimatedValue: null,
    }))
    const rewardsById: Record<string, number> = {}
    for (const event of events) for (const [itemId, quantity] of Object.entries(event.rewardsById)) sumMap(rewardsById, itemId, quantity)
    return {
      key: definition.key,
      label: definition.label,
      opened: events.length,
      items: Object.values(rewardsById).reduce((sum, quantity) => sum + quantity, 0),
      rewardsById,
      events,
      estimatedValue: null,
      valuePerChest: null,
      valuePerItem: null,
      best: null,
      worst: null,
    }
  })

  return {
    fromTimestamp,
    toTimestamp,
    days,
    logCount: logs.length,
    totalItems: Array.from(receivedItems.values()).reduce((sum, item) => sum + item.quantity, 0),
    totalPricedItems: 0,
    unpricedItems: Array.from(receivedItems.values()).reduce((sum, item) => sum + item.quantity, 0),
    estimatedValue: null,
    estimatedValuePerDay: null,
    estimatedValuePerItem: null,
    minigames: GAME_DEFINITIONS.map(game => ({ key: game.key, label: game.label, count: gameCounts.get(game.key) ?? 0 })),
    santaVisits,
    gifts,
    itemFinds,
    hatsAdded,
    hatNames,
    ornamentsAdded: Object.values(ornaments).reduce((sum, count) => sum + count, 0),
    ornamentsBought,
    ornamentsOther,
    ornaments,
    keysFound,
    chests: chestMetrics,
    christmasBucksGained,
    christmasBucksSpent,
    christmasBucksSpentByItem: bucksSpentByItem,
    prizeCouponsGained,
    prizeCouponsSpent,
    prizeCouponsExchanged,
    prizeCouponItems: Object.values(prizeCouponItemsById).reduce((sum, count) => sum + count, 0),
    prizeCouponItemsById,
    pot: { roundsWon: potRoundsWon, itemsDeposited: potItemsDeposited, depositValue: null, itemsWon: potItemsWon, wonValue: null },
    potDepositedById,
    potWonById,
    receivedItemsById: Array.from(receivedItems.values()).reduce((totals, item) => {
      sumMap(totals, item.itemId, item.quantity)
      return totals
    }, {} as Record<string, number>),
    itemNamesById,
    purchasedItemsById,
    items: Array.from(receivedItems.values()).map(item => ({ itemId: item.itemId, itemName: item.itemName, quantity: item.quantity, group: item.group, unitPrice: null, estimatedValue: null })),
  }
}

export function applyChristmasTownMarketPrices(
  metrics: ChristmasTownMetrics,
  prices: readonly { itemId: string; itemName: string; averagePrice: number | null }[],
): ChristmasTownMetrics {
  const priceById = new Map(prices.map(price => [String(price.itemId), price]))
  const itemNamesById = { ...metrics.itemNamesById }
  for (const price of prices) {
    if (price.itemName?.trim()) itemNamesById[String(price.itemId)] = price.itemName.trim()
  }
  const valueOf = (itemsById: Record<string, number>) => {
    let total = 0
    let pricedItemCount = 0
    for (const [itemId, quantity] of Object.entries(itemsById)) {
      const price = priceById.get(itemId)?.averagePrice
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        total += price * quantity
        pricedItemCount += quantity
      }
    }
    return pricedItemCount > 0 ? { value: total, items: pricedItemCount } : null
  }

  let estimatedValue = 0
  let pricedItems = 0
  let unpricedItems = 0
  const items = metrics.items.map(item => {
    const itemName = item.itemName.startsWith("Item #") && itemNamesById[item.itemId]
      ? itemNamesById[item.itemId]
      : item.itemName
    const price = priceById.get(item.itemId)?.averagePrice
    const unitPrice = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null
    if (unitPrice === null) unpricedItems += item.quantity
    else {
      pricedItems += item.quantity
      estimatedValue += unitPrice * item.quantity
    }
    return { ...item, itemName, unitPrice, estimatedValue: unitPrice === null ? null : unitPrice * item.quantity }
  })

  const allRewardAndPurchaseIds = { ...metrics.receivedItemsById }
  for (const [itemId, quantity] of Object.entries(metrics.purchasedItemsById)) {
    sumMap(allRewardAndPurchaseIds, itemId, quantity)
  }
  const namedItems = Object.entries(allRewardAndPurchaseIds).map(([itemId, quantity]) => ({
    itemId,
    itemName: itemNamesById[itemId] ?? priceById.get(itemId)?.itemName ?? "Item #" + itemId,
    quantity,
  }))
  const resolvedKeyCounts = {
    bronze: namedItems.filter(item => /bronze key/i.test(item.itemName)).reduce((sum, item) => sum + item.quantity, 0),
    silver: namedItems.filter(item => /silver key/i.test(item.itemName)).reduce((sum, item) => sum + item.quantity, 0),
    gold: namedItems.filter(item => /(?:gold|golden) key/i.test(item.itemName)).reduce((sum, item) => sum + item.quantity, 0),
  }
  const keysFound = {
    bronze: Math.max(metrics.keysFound.bronze, resolvedKeyCounts.bronze),
    silver: Math.max(metrics.keysFound.silver, resolvedKeyCounts.silver),
    gold: Math.max(metrics.keysFound.gold, resolvedKeyCounts.gold),
  }
  const resolvedOrnaments = namedItems.filter(item => /ornament/i.test(item.itemName)).reduce((map, item) => {
    sumMap(map, item.itemName, item.quantity)
    return map
  }, {} as Record<string, number>)
  const ornaments = { ...metrics.ornaments }
  for (const [name, count] of Object.entries(resolvedOrnaments)) ornaments[name] = Math.max(ornaments[name] ?? 0, count)
  const resolvedBoughtOrnaments = Object.entries(metrics.purchasedItemsById).reduce((sum, [itemId, quantity]) => {
    return sum + (/ornament/i.test(itemNamesById[itemId] ?? priceById.get(itemId)?.itemName ?? "") ? quantity : 0)
  }, 0)
  const resolvedOtherOrnaments = Object.entries(metrics.receivedItemsById).reduce((sum, [itemId, quantity]) => {
    return sum + (/ornament/i.test(itemNamesById[itemId] ?? priceById.get(itemId)?.itemName ?? "") ? quantity : 0)
  }, 0)
  const ornamentTotal = Object.values(ornaments).reduce((sum, count) => sum + count, 0)
  const ornamentsBought = Math.min(ornamentTotal, Math.max(metrics.ornamentsBought, resolvedBoughtOrnaments))
  const ornamentsOther = Math.max(metrics.ornamentsOther, resolvedOtherOrnaments, ornamentTotal - ornamentsBought)

  const resolvedHats = namedItems.filter(item => /hat|bonnet|cap|headwear/i.test(item.itemName)).reduce((map, item) => {
    sumMap(map, item.itemName, item.quantity)
    return map
  }, {} as Record<string, number>)
  const hatNames = { ...metrics.hatNames }
  for (const [name, count] of Object.entries(resolvedHats)) hatNames[name] = Math.max(hatNames[name] ?? 0, count)
  const christmasBucksSpentByItem: Record<string, number> = {}
  for (const [name, quantity] of Object.entries(metrics.christmasBucksSpentByItem)) {
    const id = name.match(/^Item #(\d+)$/)?.[1]
    const resolvedName = id ? itemNamesById[id] ?? name : name
    sumMap(christmasBucksSpentByItem, resolvedName, quantity)
  }

  const chests = metrics.chests.map(chest => {
    const events = chest.events.map(event => {
      const value = valueOf(event.rewardsById)
      return { ...event, estimatedValue: value?.value ?? null }
    })
    const values = events
      .filter((event): event is ChristmasTownChestEvent & { estimatedValue: number } => event.estimatedValue !== null)
      .sort((a, b) => b.estimatedValue - a.estimatedValue)
    const total = valueOf(chest.rewardsById)
    const pricedRewardItems = Object.entries(chest.rewardsById).reduce((sum, [itemId, quantity]) => {
      const price = priceById.get(itemId)?.averagePrice
      return sum + (typeof price === "number" && Number.isFinite(price) && price > 0 ? quantity : 0)
    }, 0)
    const pricedChestCount = events.filter(event => event.estimatedValue !== null).length
    return {
      ...chest,
      events,
      estimatedValue: total?.value ?? null,
      valuePerChest: pricedChestCount > 0 ? events.reduce((sum, event) => sum + (event.estimatedValue ?? 0), 0) / pricedChestCount : null,
      valuePerItem: pricedRewardItems > 0 ? (total?.value ?? 0) / pricedRewardItems : null,
      best: values.length ? { timestamp: values[0].timestamp, estimatedValue: values[0].estimatedValue, rewardsById: values[0].rewardsById } : null,
      worst: values.length ? { timestamp: values[values.length - 1].timestamp, estimatedValue: values[values.length - 1].estimatedValue, rewardsById: values[values.length - 1].rewardsById } : null,
    }
  })

  const pricedTotal = pricedItems > 0 ? estimatedValue : null
  const depositValue = valueOf(metrics.potDepositedById)
  const wonValue = valueOf(metrics.potWonById)
  return {
    ...metrics,
    itemNamesById,
    keysFound,
    ornaments,
    ornamentsAdded: ornamentTotal,
    ornamentsBought,
    ornamentsOther,
    hatNames,
    hatsAdded: Math.max(metrics.hatsAdded, Object.values(hatNames).reduce((sum, count) => sum + count, 0)),
    christmasBucksSpentByItem,
    totalPricedItems: pricedItems,
    unpricedItems,
    estimatedValue: pricedTotal,
    estimatedValuePerDay: pricedTotal === null || metrics.days === 0 ? null : pricedTotal / metrics.days,
    estimatedValuePerItem: pricedTotal === null || pricedItems === 0 ? null : pricedTotal / pricedItems,
    chests,
    items,
    pot: {
      ...metrics.pot,
      depositValue: depositValue?.value ?? null,
      wonValue: wonValue?.value ?? null,
    },
  }
}
