export type DailyProfitHistoryPoint = {
  day: string
  dailyProfit: number | null
  reportedWeeklyProfit?: number | null
}

export type RollingWeeklyProfitPoint = {
  weeklyProfit: number | null
  weeklyProfitSource: "reconstructed" | "incomplete"
  weeklyProfitReconciliationDelta: number | null
}

/**
 * Calculate a trailing seven-reporting-day profit total.
 * A result is emitted only when all seven consecutive days exist and each
 * daily profit is known. Missing values are never treated as zero.
 */
export function withRollingWeeklyProfit<T extends DailyProfitHistoryPoint>(
  points: readonly T[],
): Array<T & RollingWeeklyProfitPoint> {
  const ordered = [...points].sort((a, b) => a.day.localeCompare(b.day))
  const byDay = new Map(ordered.map((point) => [point.day, point]))
  return ordered.map((point) => {
    const end = Date.parse(point.day + "T00:00:00.000Z")
    const window: T[] = []
    if (/^\d{4}-\d{2}-\d{2}$/.test(point.day) && Number.isFinite(end)) {
      for (let offset = 6; offset >= 0; offset--) {
        const day = new Date(end - offset * 86400000).toISOString().slice(0, 10)
        const candidate = byDay.get(day)
        if (!candidate) {
          window.length = 0
          break
        }
        window.push(candidate)
      }
    }
    const complete = window.length === 7 && window.every(
      (entry) => typeof entry.dailyProfit === "number" && Number.isFinite(entry.dailyProfit),
    )
    const weeklyProfit = complete
      ? window.reduce((sum, entry) => sum + Number(entry.dailyProfit), 0)
      : null
    const reported = typeof point.reportedWeeklyProfit === "number" && Number.isFinite(point.reportedWeeklyProfit)
      ? point.reportedWeeklyProfit
      : null
    return {
      ...point,
      weeklyProfit,
      weeklyProfitSource: complete ? "reconstructed" : "incomplete",
      weeklyProfitReconciliationDelta: weeklyProfit !== null && reported !== null ? reported - weeklyProfit : null,
    }
  })
}
