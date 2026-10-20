export function severityRank(value) {
  const severity = String(value || "info").toLowerCase();
  if (["critical", "high", "error", "fatal"].includes(severity)) return 3;
  if (["warning", "medium", "warn"].includes(severity)) return 2;
  return 1;
}

/**
 * Evaluate an account's quiet-hours window at a supplied instant.
 * The optional clock keeps timezone and daylight-saving behavior deterministic in tests.
 */
export function isDuringQuietHours(preferences, now = new Date()) {
  if (!(preferences?.quietHoursEnabled === true || Number(preferences?.quietHoursEnabled) === 1)) return false;
  const timezone = typeof preferences.timezone === "string" && preferences.timezone ? preferences.timezone : "UTC";
  const startText = typeof preferences.quietHoursStart === "string" ? preferences.quietHoursStart : "22:00";
  const endText = typeof preferences.quietHoursEnd === "string" ? preferences.quietHoursEnd : "08:00";
  const minutes = value => {
    const match = String(value).match(/^(\d{2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]), minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
  };
  const start = minutes(startText), end = minutes(endText);
  if (start === null || end === null || start === end) return false;
  try {
    const instant = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(instant.getTime())) return false;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(instant).split(":");
    const current = Number(parts[0]) * 60 + Number(parts[1]);
    return start < end ? current >= start && current < end : current >= start || current < end;
  } catch {
    return false;
  }
}
