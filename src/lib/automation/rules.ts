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

export function evaluateIncomeIncrease(previous: unknown, current: unknown, threshold: unknown): IncomeDrop | null {
  const before = finiteNumber(previous)
  const after = finiteNumber(current)
  if (before === null || after === null || before <= 0) return null
  const changePercent = ((after - before) / before) * 100
  return changePercent >= normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null
}

export function evaluatePercentageDrop(previous: unknown, current: unknown, threshold: unknown): IncomeDrop | null {
  const before = finiteNumber(previous)
  const after = finiteNumber(current)
  if (before === null || after === null || before <= 0) return null
  const changePercent = ((after - before) / before) * 100
  return changePercent <= -normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null
}

export function evaluateRosterChange(previous: unknown, current: unknown, threshold: unknown): IncomeDrop | null {
  const before = finiteNumber(previous)
  const after = finiteNumber(current)
  if (before === null || after === null || before < 0 || after < 0 || before === after) return null
  const changePercent = before > 0 ? ((after - before) / before) * 100 : after > 0 ? 100 : 0
  return Math.abs(changePercent) >= normalizeAlertThreshold(threshold) ? { changePercent: Math.round(changePercent * 100) / 100 } : null
}

export function isWithinQuietHours(currentMinutes: number, start: string, end: string): boolean {
  const parse = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null
  const startMinutes = parse(start), endMinutes = parse(end)
  if (!Number.isFinite(currentMinutes) || currentMinutes < 0 || currentMinutes >= 1440 || startMinutes === null || endMinutes === null) return false
  if (startMinutes === endMinutes) return true
  return startMinutes < endMinutes ? currentMinutes >= startMinutes && currentMinutes < endMinutes : currentMinutes >= startMinutes || currentMinutes < endMinutes
}

export function normalizeWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
    if (!host || host.includes(":") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host === "metadata.google.internal") return null
    if (/^(?:0|10|127|169\.254|192\.168)\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) return null
    if (/^[0-9.]+$/.test(host) && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return null
    return url.toString()
  } catch { return null }
}
