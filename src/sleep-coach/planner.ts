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
  /**
   * Minutes after wakeTime that the scheduled wake-up fires. 0 = wake exactly at wakeTime.
   * When WHOOP drives the wake-up, this is the safety net in case WHOOP never reports you awake.
   */
  wakeFallbackMinutes: number;
}

export const DEFAULT_SETTINGS: Omit<CoachSettings, "tz" | "wakeTime"> = {
  windDownMinutes: 30,
  defaultNeedMs: 8 * HOUR,
  minNeedMs: 6 * HOUR,
  maxNeedMs: 10 * HOUR,
  maxCarryoverMs: 90 * MIN,
  eventWindowMs: 90 * MIN,
  wakeFallbackMinutes: 0,
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
  const last = sleeps.find((r) => r && !r.nap && r.score_state === "SCORED" && r.score?.sleep_needed);
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
  const wakeAt = new Date(wakeInstant(today, s).getTime() + s.wakeFallbackMinutes * MIN);
  if (inWindow(wakeAt, new Date(wakeAt.getTime() + s.eventWindowMs))) {
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
 * Is a sleep that ended at `end` your main morning wake-up (not a 3 AM bathroom trip, not a nap)?
 * True when it ended between 2 hours before and 3 hours after that day's wake time.
 * Returns the local date the wake-up belongs to, or null.
 */
export function morningWakeDate(end: Date, s: CoachSettings): string | null {
  const date = localDate(s.tz, end);
  const wake = wakeInstant(date, s).getTime();
  const t = end.getTime();
  return t >= wake - 2 * HOUR && t <= wake + 3 * HOUR ? date : null;
}
