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
