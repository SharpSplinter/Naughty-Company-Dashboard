export type DiscordPollHealthSnapshot = {
  pollCompletedAt?: string | null
  status: string
  consecutiveFailures?: number | null
  failed?: number | null
  exhaustedDeliveries?: number | null
  staleClaims?: number | null
}

export type DiscordPollAssessment = {
  needsAttention: boolean
  telemetryStale: boolean
  badgeLabel: string
  warningReasons: string[]
}

/**
 * Turn the last account-scoped poll report into human-readable operational signals.
 * Missing telemetry is shown as "awaiting first report"; only an existing report can
 * age into a stale-telemetry warning.
 */
export function evaluateDiscordPollHealth(
  health: DiscordPollHealthSnapshot | null,
  options: { linked: boolean; alertsEnabled: boolean; nowMs?: number; staleAfterMs?: number },
): DiscordPollAssessment {
  const warningReasons: string[] = []
  const nowMs = options.nowMs ?? Date.now()
  const staleAfterMs = options.staleAfterMs ?? 30 * 60 * 1000
  const completedMs = health?.pollCompletedAt ? Date.parse(health.pollCompletedAt) : Number.NaN
  const telemetryStale = Boolean(
    options.linked &&
    options.alertsEnabled &&
    health &&
    (!Number.isFinite(completedMs) || nowMs - completedMs > staleAfterMs),
  )

  if (health?.status === "error") {
    warningReasons.push(Number(health.consecutiveFailures || 0) >= 3
      ? `Polling has failed ${Number(health.consecutiveFailures || 0)} times in a row.`
      : "The most recent private-alert poll failed.")
  }
  if (Number(health?.exhaustedDeliveries || 0) > 0) {
    warningReasons.push(`${Number(health?.exhaustedDeliveries || 0)} private DM delivery(ies) have exhausted automatic retries.`)
  }
  if (Number(health?.staleClaims || 0) > 0) {
    warningReasons.push(`${Number(health?.staleClaims || 0)} delivery claim(s) appear stale and need recovery.`)
  }
  if (health?.status === "partial" && Number(health.failed || 0) > 0) {
    warningReasons.push(`${Number(health.failed || 0)} DM delivery attempt(s) failed in the last poll.`)
  }
  if (telemetryStale) warningReasons.push("No fresh poll report has arrived in the last 30 minutes.")

  const needsAttention = warningReasons.length > 0
  const badgeLabel = needsAttention
    ? "Attention needed"
    : !health
      ? "Awaiting first report"
      : health.status === "quiet_hours"
        ? "Quiet hours"
        : health.status === "disabled"
          ? "Polling disabled"
          : "Reporting normally"
  return { needsAttention, telemetryStale, badgeLabel, warningReasons }
}
