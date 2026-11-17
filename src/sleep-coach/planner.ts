import { addDays, dayOfWeek, localDate, zonedInstant } from "./time.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface CoachSettings {
  tz: string;                 // IANA zone, e.g. "Asia/Kolkata"
  wakeTime: string;           // "06:30"
  weekendWakeTime?: string;   // optional override for Saturday/Sunday mornings
  windDownMinutes: number;    // heads-up announcement this long before bedtime (0 = off)
  defaultNeedMs: number;      // used when WHOOP has no scored sleep yet
  minNeedMs: number;          // clamp so a bad data point can't schedule a silly bedtime
  maxNeedMs: number;
  maxCarryoverMs: number;     // at most this much of last night's shortfall is added tonight
  eventWindowMs: number;      // an event still fires if a tick arrives up to this late
  /** Announce good morning at wakeTime. Off when WHOOP drives the wake-up instead. */
  scheduledWake: boolean;
}

export const DEFAULT_SETTINGS: Omit<CoachSettings, "tz" | "wakeTime"> = {
  windDownMinutes: 30,
  defaultNeedMs: 8 * HOUR,
  minNeedMs: 6 * HOUR,
  maxNeedMs: 10 * HOUR,
  maxCarryoverMs: 90 * MIN,
  eventWindowMs: 90 * MIN,
  scheduledWake: true,
};

export type CoachEventKind = "wind_down" | "bedtime" | "wake";

export interface DueEvent {
  kind: CoachEventKind;
  /** Stable per-occurrence key used to make sure each event fires once. */
  key: string;
  at: Date;
}

export interface SleepNeed {
  needMs: number;
  source: "whoop" | "default";
  baselineMs?: number;
  carryoverMs?: number;
}

export interface NightPlan {
  wakeDate: string;
  wakeAt: Date;
  bedtimeAt: Date;
  windDownAt: Date;
  need: SleepNeed;
}

/** Wake instant for a given local date, honouring the weekend override. */
export function wakeInstant(date: string, s: CoachSettings): Date {
  const dow = dayOfWeek(date);
  const hhmm = (dow === 0 || dow === 6) && s.weekendWakeTime ? s.weekendWakeTime : s.wakeTime;
  return zonedInstant(date, hhmm, s.tz);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Estimate tonight's sleep need from WHOOP sleep records (newest first, as the API returns them).
 * tonight = your baseline need + the part of last night's need you didn't get (capped).
 * This mirrors the idea behind WHOOP's Sleep Planner; the API doesn't expose the planner itself.
 */
export function estimateSleepNeed(sleeps: any[], s: CoachSettings): SleepNeed {
  const last = sleeps.find((r) => isMainSleep(r) && r.score_state === "SCORED" && r.score?.sleep_needed);
  if (!last) return { needMs: s.defaultNeedMs, source: "default" };
  const sn = last.score.sleep_needed;
  const st = last.score.stage_summary ?? {};
  const baseline = Number(sn.baseline_milli) || s.defaultNeedMs;
  const lastNeed = baseline
    + (Number(sn.need_from_sleep_debt_milli) || 0)
    + (Number(sn.need_from_recent_strain_milli) || 0)
    - (Number(sn.need_from_recent_nap_milli) || 0);
  const slept = (Number(st.total_light_sleep_time_milli) || 0)
    + (Number(st.total_slow_wave_sleep_time_milli) || 0)
    + (Number(st.total_rem_sleep_time_milli) || 0);
  const carryover = clamp(lastNeed - slept, 0, s.maxCarryoverMs);
  return {
    needMs: clamp(baseline + carryover, s.minNeedMs, s.maxNeedMs),
    source: "whoop",
    baselineMs: baseline,
    carryoverMs: carryover,
  };
}

/** The next night's plan: the coming wake-up, and bedtime / wind-down working back from it. */
export function planNight(now: Date, s: CoachSettings, need: SleepNeed): NightPlan {
  const today = localDate(s.tz, now);
  const todayWake = wakeInstant(today, s);
  const wakeDate = now < todayWake ? today : addDays(today, 1);
  const wakeAt = now < todayWake ? todayWake : wakeInstant(wakeDate, s);
  const bedtimeAt = new Date(wakeAt.getTime() - need.needMs);
  const windDownAt = new Date(bedtimeAt.getTime() - s.windDownMinutes * MIN);
  return { wakeDate, wakeAt, bedtimeAt, windDownAt, need };
}

/** True when the coming bedtime is close enough that it's worth asking WHOOP for the sleep need. */
export function nightIsNear(now: Date, s: CoachSettings): boolean {
  const plan = planNight(now, s, { needMs: s.maxNeedMs, source: "default" });
  return now.getTime() >= plan.windDownAt.getTime() - HOUR;
}

/** Events whose time has come (and hasn't passed by more than the event window). */
export function dueEvents(now: Date, s: CoachSettings, need: SleepNeed): DueEvent[] {
  const t = now.getTime();
  const inWindow = (at: Date, until: Date) => t >= at.getTime() && t < until.getTime();
  const out: DueEvent[] = [];

  const today = localDate(s.tz, now);
  const wakeAt = wakeInstant(today, s);
  if (s.scheduledWake && inWindow(wakeAt, new Date(wakeAt.getTime() + s.eventWindowMs))) {
    out.push({ kind: "wake", key: `wake:${today}`, at: wakeAt });
  }

  const plan = planNight(now, s, need);
  if (s.windDownMinutes > 0 && inWindow(plan.windDownAt, plan.bedtimeAt)) {
    out.push({ kind: "wind_down", key: `wind_down:${plan.wakeDate}`, at: plan.windDownAt });
  }
  if (inWindow(plan.bedtimeAt, new Date(plan.bedtimeAt.getTime() + s.eventWindowMs))) {
    out.push({ kind: "bedtime", key: `bedtime:${plan.wakeDate}`, at: plan.bedtimeAt });
  }
  return out;
}

/**
 * A night's main sleep: at least 3 hours long. WHOOP's own `nap` flag isn't trusted — it
 * sometimes labels a full night as a nap.
 */
export function isMainSleep(r: any): boolean {
  if (!r?.start || !r?.end) return false;
  return new Date(r.end).getTime() - new Date(r.start).getTime() >= 3 * HOUR;
}

const MORNING_FROM = 4 * 60 + 30; // 04:30
const MORNING_TO = 14 * 60;       // 14:00

function localMinutes(tz: string, at: Date): number {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(at).split(":").map(Number);
  return h * 60 + m;
}

/**
 * If this sleep is the main sleep of a night that ended in the morning (04:30–14:00 local),
 * the local date of that morning; otherwise null (naps, 3 AM wake-ups, afternoon sleeps).
 */
export function morningWakeDate(sleep: any, tz: string): string | null {
  if (!isMainSleep(sleep)) return null;
  const end = new Date(sleep.end);
  const min = localMinutes(tz, end);
  return min >= MORNING_FROM && min <= MORNING_TO ? localDate(tz, end) : null;
}

/**
 * Your usual wake-up time ("HH:MM", rounded to 15 min): the median end of your morning main
 * sleeps over the last two weeks. Null if there are fewer than 3 such nights.
 */
export function typicalWakeTime(sleeps: any[], tz: string, now: Date): string | null {
  const since = now.getTime() - 14 * 24 * HOUR;
  const mins = sleeps
    .filter((r) => morningWakeDate(r, tz) && new Date(r.end).getTime() >= since)
    .map((r) => localMinutes(tz, new Date(r.end)))
    .sort((a, b) => a - b);
  if (mins.length < 3) return null;
  const mid = mins.length / 2;
  const median = mins.length % 2 ? mins[Math.floor(mid)] : (mins[mid - 1] + mins[mid]) / 2;
  const rounded = Math.round(median / 15) * 15;
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}
