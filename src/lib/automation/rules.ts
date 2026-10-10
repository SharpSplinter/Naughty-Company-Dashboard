export type IncomeDrop = { changePercent: number }

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

export function normalizeAlertThreshold(value: unknown, fallback = 15): number {
  const number = finiteNumber(value)
  return Math.min(90, Math.max(1, number === null ? fallback : number))
}

export function normalizeCooldownHours(value: unknown, fallback = 24): number {
  const number = finiteNumber(value)
  return Math.round(Math.min(168, Math.max(1, number === null ? fallback : number)))
}

export function evaluateIncomeDrop(previous: unknown, current: unknown, threshold: unknown): IncomeDrop | null {
  const before = finiteNumber(previous)
  const after = finiteNumber(current)
  if (before === null || after === null || before <= 0) return null
  const changePercent = ((after - before) / before) * 100
  return changePercent <= -normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null
}

export function isSnapshotStale(fetchedAt: string | null | undefined, nowMs: number, afterHours: unknown): boolean {
  if (!fetchedAt) return false
  const fetchedMs = Date.parse(fetchedAt)
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)) return false
  return nowMs - fetchedMs >= normalizeCooldownHours(afterHours, 30) * 3600000
}
