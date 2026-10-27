export type SnapshotSchedule = { cron: string; scheduledTime: number };

/**
 * Returns Torn's source time only for a scheduled 18:10 UTC lock-in.
 * This keeps refreshed or stale profile data out of immutable daily history.
 */
export function officialSnapshotSourceTime(
  sourceTimestamp: number | null | undefined,
  schedule?: SnapshotSchedule,
): Date | null {
  if (!schedule || schedule.cron.trim() !== "10 18 * * *") return null;
  const scheduledAt = new Date(schedule.scheduledTime);
  if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getUTCHours() !== 18 || scheduledAt.getUTCMinutes() !== 10) return null;
  if (typeof sourceTimestamp !== "number" || !Number.isFinite(sourceTimestamp) || sourceTimestamp <= 0) return null;
  const sourceAt = new Date(sourceTimestamp * 1000);
  if (Number.isNaN(sourceAt.getTime())) return null;

  // Torn's source data should belong to this reporting day and be close to the
  // scheduled lock-in. Allow a short future skew for request processing time.
  const sourceMs = sourceAt.getTime();
  const scheduledMs = scheduledAt.getTime();
  if (sourceMs < scheduledMs - 30 * 60 * 1000 || sourceMs > scheduledMs + 5 * 60 * 1000) return null;
  const sourceDay = new Date(sourceMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const scheduledDay = new Date(scheduledMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (sourceDay !== scheduledDay) return null;
  return sourceAt;
}

/**
 * Validates a manual catch-up timestamp without mislabeling it as the scheduled
 * 18:10 lock-in. Only current reporting-day source data is eligible.
 */
export function manualRecoverySnapshotSourceTime(
  sourceTimestamp: number | null | undefined,
  recoveryStartedAt: number,
  observedAt = Date.now(),
): Date | null {
  if (typeof sourceTimestamp !== "number" || !Number.isFinite(sourceTimestamp) || sourceTimestamp <= 0) return null;
  if (!Number.isFinite(recoveryStartedAt) || !Number.isFinite(observedAt)) return null;

  const sourceAt = new Date(sourceTimestamp * 1000);
  const startedAt = new Date(recoveryStartedAt);
  const observed = new Date(observedAt);
  if (Number.isNaN(sourceAt.getTime()) || Number.isNaN(startedAt.getTime()) || Number.isNaN(observed.getTime())) return null;

  const sourceMs = sourceAt.getTime();
  const startedMs = startedAt.getTime();
  const observedMs = observed.getTime();
  if (sourceMs < startedMs - 45 * 60 * 1000 || sourceMs > observedMs + 5 * 60 * 1000) return null;

  const sourceDay = new Date(sourceMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const recoveryDay = new Date(startedMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const observedDay = new Date(observedMs - 18 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (sourceDay !== recoveryDay || sourceDay !== observedDay) return null;
  return sourceAt;
}
