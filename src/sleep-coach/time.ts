// Small timezone helpers built on Intl, so we don't need a date library.

/** Offset of `tz` from UTC at instant `at`, in milliseconds (e.g. +19_800_000 for Asia/Kolkata). */
export function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Calendar date (YYYY-MM-DD) of instant `at` in `tz`. */
export function localDate(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Day of week (0 = Sunday) of a YYYY-MM-DD date. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The UTC instant for wall-clock `hhmm` ("06:30") on `date` in `tz`. */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes handle DST edges; for fixed-offset zones the first pass is exact.
  let t = guess - tzOffsetMs(tz, new Date(guess));
  t = guess - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

/** "10:45 PM" style wall-clock time of `at` in `tz`, for speech. */
export function spokenTime(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}

/** "7 hours 10 minutes" for speech. */
export function spokenDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hs = h === 1 ? "1 hour" : `${h} hours`;
  if (m === 0) return hs;
  const ms_ = m === 1 ? "1 minute" : `${m} minutes`;
  return h === 0 ? ms_ : `${hs} ${ms_}`;
}
