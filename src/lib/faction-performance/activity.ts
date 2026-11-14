export type FactionInactivityClassification = "normal" | "inactive_24h" | "inactive_72h" | "unknown"

export type FactionInactivityAssessment = {
  classification: FactionInactivityClassification
  elapsedSeconds: number | null
  lastActionAt: string | null
}

/**
 * Classifies the age of Torn's public last_action timestamp at an observation time.
 * Missing/invalid inputs remain unknown; future timestamps are clamped to zero age.
 */
export function classifyFactionInactivity(
  lastActionTimestampSeconds: number | null,
  observedAt: string | number,
): FactionInactivityAssessment {
  const validTimestamp = typeof lastActionTimestampSeconds === "number" &&
    Number.isSafeInteger(lastActionTimestampSeconds) &&
    lastActionTimestampSeconds > 0 &&
    lastActionTimestampSeconds <= 8_640_000_000_000
  const lastActionAt = validTimestamp
    ? new Date(lastActionTimestampSeconds * 1000).toISOString()
    : null
  const observedMs = typeof observedAt === "number" ? observedAt : Date.parse(observedAt)
  if (!validTimestamp || !Number.isFinite(observedMs)) {
    return { classification: "unknown", elapsedSeconds: null, lastActionAt }
  }

  const elapsedSeconds = Math.max(0, Math.floor((observedMs - lastActionTimestampSeconds * 1000) / 1000))
  const classification = elapsedSeconds >= 72 * 60 * 60
    ? "inactive_72h"
    : elapsedSeconds >= 24 * 60 * 60
      ? "inactive_24h"
      : "normal"
  return { classification, elapsedSeconds, lastActionAt }
}
