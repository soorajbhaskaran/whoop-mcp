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
  carryoverMs?: number;   // estimateSleepNeed: last night's shortfall
  debtMs?: number;        // tonightSleepNeed: WHOOP-style sleep debt
  strainMs?: number;      // extra need from today's strain
  napMs?: number;         // naps since the last main sleep (subtracted)
  strain?: number;        // today's strain so far
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

/** WHOOP carries 9/14 of the previous night's shortfall into the next night's sleep debt. */
export const DEBT_CARRY = 9 / 14;

const sleptMs = (r: any) => {
  const st = r?.score?.stage_summary ?? {};
  return (Number(st.total_light_sleep_time_milli) || 0) + (Number(st.total_slow_wave_sleep_time_milli) || 0)
    + (Number(st.total_rem_sleep_time_milli) || 0);
};

const totalNeedMs = (sn: any) => (Number(sn.baseline_milli) || 0) + (Number(sn.need_from_sleep_debt_milli) || 0)
  + (Number(sn.need_from_recent_strain_milli) || 0) + (Number(sn.need_from_recent_nap_milli) || 0);

export interface StrainModel { a: number; b: number; points: number }

/**
 * Fit WHOOP's "need from recent strain" against the strain of the day before each sleep:
 * minutes = exp(a + b * strain), least squares on log-minutes. Falls back to a curve fitted on
 * typical data when there are fewer than 5 usable nights.
 */
export function fitStrainModel(sleeps: any[], cycles: any[]): StrainModel {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sl of sleeps) {
    const need = Number(sl?.score?.sleep_needed?.need_from_recent_strain_milli);
    if (!isMainSleep(sl) || !(need > 0)) continue;
    const start = new Date(sl.start).getTime();
    const cycle = cycles.find((c) => c.end && Math.abs(new Date(c.end).getTime() - start) < 15 * MIN);
    const strain = Number(cycle?.score?.strain);
    if (!(strain > 0)) continue;
    xs.push(strain);
    ys.push(Math.log(need / MIN));
  }
  const n = xs.length;
  if (n >= 5) {
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
    if (sxx > 0) {
      const b = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) / sxx;
      if (b > 0) return { a: my - b * mx, b, points: n };
    }
  }
  return { a: -0.104, b: 0.254, points: 0 };
}

/**
 * Tonight's sleep need, rebuilt the way WHOOP computes it (the API doesn't expose the Sleep Planner):
 * baseline + 9/14 of last night's shortfall + need from today's strain − naps since you woke up.
 */
export function tonightSleepNeed(sleeps: any[], cycles: any[], s: CoachSettings): SleepNeed {
  const last = sleeps.find((r) => isMainSleep(r) && r.score_state === "SCORED" && r.score?.sleep_needed);
  if (!last) return { needMs: s.defaultNeedMs, source: "default" };
  const sn = last.score.sleep_needed;
  const baseline = Number(sn.baseline_milli) || s.defaultNeedMs;
  const debt = DEBT_CARRY * Math.max(0, totalNeedMs(sn) - sleptMs(last));
  const lastEnd = new Date(last.end).getTime();
  const naps = sleeps
    .filter((r) => r !== last && r.score_state === "SCORED" && r.end && new Date(r.start).getTime() >= lastEnd)
    .reduce((acc, r) => acc + sleptMs(r), 0);
  const today = cycles.find((c) => !c.end) ?? cycles[0];
  const strain = Number(today?.score?.strain) || 0;
  const model = fitStrainModel(sleeps, cycles);
  const strainNeed = strain > 0 ? Math.exp(model.a + model.b * strain) * MIN : 0;
  return {
    needMs: clamp(baseline + debt + strainNeed - naps, s.minNeedMs, s.maxNeedMs),
    source: "whoop",
    baselineMs: baseline,
    debtMs: debt,
    strainMs: strainNeed,
    napMs: naps,
    strain,
  };
}
