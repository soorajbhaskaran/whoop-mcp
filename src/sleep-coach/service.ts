import { dueEvents, estimateSleepNeed, isMainSleep, morningWakeDate, nightIsNear, planNight, typicalWakeTime, type CoachEventKind, type CoachSettings, type NightPlan, type SleepNeed } from "./planner.js";
import { buildMorningBriefing, plannedWorkout } from "./briefing.js";
import { localDate, spokenDuration, spokenTime } from "./time.js";

const HOUR = 3_600_000;

export interface WhoopReader {
  getSleep(range?: { start?: string; end?: string; limit?: number }): Promise<any[]>;
  getRecovery(range?: { start?: string; end?: string; limit?: number }): Promise<any[]>;
  getSleepById(id: string): Promise<any>;
}

export interface HevyReader {
  getWorkouts(opts?: { since?: string; until?: string; maxWorkouts?: number }): Promise<any[]>;
  getRoutines(): Promise<any[]>;
}

export interface WhoopEvent {
  type: string;
  id: string; // v2: the sleep's UUID for both sleep.* and recovery.* events
}

export interface Announcer {
  announce(speakerId: string, speech: string): Promise<void>;
  trigger(triggerId: string): Promise<void>;
}

/** Records which events already fired, so each one fires exactly once. */
export interface FiredStore {
  /** Returns true if this call claimed the key (i.e. it hadn't fired yet). */
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface CoachDevices {
  speaker: string;           // Voice Monkey Speaker device (your Echo Dot)
  windDownTrigger?: string;  // optional: e.g. dim lights / start AC early
  bedtimeTrigger?: string;   // Alexa "Bedtime" routine: AC to 25°C, rain sounds on the Edifier...
  morningTrigger?: string;   // Alexa "Morning" routine: AC off, music/news...
}

export interface SleepCoachDeps {
  settings: CoachSettings;
  devices: CoachDevices;
  name?: string;
  /** Plan bedtime from your usual WHOOP wake-up time instead of settings.wakeTime. */
  autoWakeTime?: boolean;
  /** Hevy routine titles in the order you train them, for "today is …" in the briefing. */
  workoutRotation?: string[];
  whoop: () => Promise<WhoopReader>;
  hevy?: HevyReader;
  voice: Announcer;
  store: FiredStore;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface TickResult {
  fired: string[];
  errors: string[];
}

export class SleepCoach {
  private needCache = new Map<string, SleepNeed>();
  private wakeCache?: { date: string; wakeTime: string };

  constructor(private d: SleepCoachDeps) {}

  private now() { return this.d.now?.() ?? new Date(); }
  private wait(ms: number) { return this.d.wait ? this.d.wait(ms) : new Promise<void>((r) => setTimeout(r, ms)); }
  private log(msg: string) { (this.d.log ?? console.log)(`[sleep-coach] ${msg}`); }

  /** Settings with the wake time resolved — from your WHOOP history when autoWakeTime is on. */
  async settings(now = this.now()): Promise<CoachSettings> {
    const s = this.d.settings;
    if (!this.d.autoWakeTime) return s;
    const today = localDate(s.tz, now);
    if (this.wakeCache?.date !== today) {
      try {
        const client = await this.d.whoop();
        const typical = typicalWakeTime(await client.getSleep({ limit: 25 }), s.tz, now);
        this.wakeCache = { date: today, wakeTime: typical ?? s.wakeTime };
      } catch (e) {
        this.log(`couldn't read WHOOP history for the wake time, using ${s.wakeTime}: ${(e as Error).message}`);
        return s; // don't cache; retry next time
      }
    }
    return { ...s, wakeTime: this.wakeCache.wakeTime, weekendWakeTime: undefined };
  }

  /** Tonight's sleep need, fetched once per night (keyed by the wake-up date). */
  private async needFor(now: Date, s: CoachSettings): Promise<SleepNeed> {
    const { wakeDate } = planNight(now, s, { needMs: 0, source: "default" });
    const hit = this.needCache.get(wakeDate);
    if (hit) return hit;
    let need: SleepNeed;
    try {
      const client = await this.d.whoop();
      need = estimateSleepNeed(await client.getSleep({ limit: 5 }), s);
    } catch (e) {
      this.log(`couldn't read WHOOP sleep need, using default: ${(e as Error).message}`);
      return { needMs: s.defaultNeedMs, source: "default" }; // don't cache; retry next tick
    }
    this.needCache.clear();
    this.needCache.set(wakeDate, need);
    return need;
  }

  async plan(): Promise<NightPlan & { wakeTime: string }> {
    const now = this.now();
    const s = await this.settings(now);
    return { ...planNight(now, s, await this.needFor(now, s)), wakeTime: s.wakeTime };
  }

  /** Call every few minutes. Fires whatever is due and hasn't fired yet. */
  async tick(): Promise<TickResult> {
    const now = this.now();
    const s = await this.settings(now);
    // Only ask WHOOP for the sleep need when bedtime is getting close.
    const need = nightIsNear(now, s) ? await this.needFor(now, s) : { needMs: s.maxNeedMs, source: "default" as const };
    const result: TickResult = { fired: [], errors: [] };
    for (const ev of dueEvents(now, s, need)) {
      if (!(await this.d.store.claim(ev.key))) continue;
      try {
        await this.run(ev.kind, now);
        result.fired.push(ev.key);
        this.log(`fired ${ev.key}`);
      } catch (e) {
        await this.d.store.release(ev.key); // let the next tick retry while still in the window
        result.errors.push(`${ev.key}: ${(e as Error).message}`);
        this.log(`failed ${ev.key}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /**
   * React to a WHOOP webhook. When WHOOP records that you've woken up from your main sleep,
   * read the morning briefing and run the Morning routine — once per morning.
   */
  async onWhoopEvent(ev: WhoopEvent): Promise<{ fired?: string; skipped?: string }> {
    if (ev.type !== "sleep.updated" && ev.type !== "recovery.updated") return { skipped: `ignored ${ev.type}` };
    const client = await this.d.whoop();
    const sleep = await client.getSleepById(String(ev.id));
    if (!isMainSleep(sleep)) return { skipped: "nap or sleep still in progress" };
    const now = this.now();
    if (now.getTime() - new Date(sleep.end).getTime() > HOUR) return { skipped: "sleep ended over an hour ago" };
    const date = morningWakeDate(sleep, this.d.settings.tz);
    if (!date) return { skipped: "not a morning wake-up" };
    const key = `wake:${date}`;
    if (!(await this.d.store.claim(key))) return { skipped: `${key} already fired` };
    try {
      await this.wake(sleep);
      this.log(`fired ${key} from WHOOP ${ev.type}`);
      return { fired: key };
    } catch (e) {
      await this.d.store.release(key);
      throw e;
    }
  }

  /** Run one event right now, ignoring the schedule (used by the /test endpoint). */
  async run(kind: CoachEventKind, now = this.now()): Promise<string> {
    const dev = this.d.devices;
    if (kind === "wake") return this.wake();

    const s = await this.settings(now);
    const plan = planNight(now, s, await this.needFor(now, s));
    const hi = this.d.name ? `${this.d.name}, ` : "";
    const at = (t: Date) => spokenTime(s.tz, t);
    const wakeLine = this.d.autoWakeTime ? `around ${at(plan.wakeAt)}` : `at ${at(plan.wakeAt)}`;

    if (kind === "wind_down") {
      const speech = `${hi}it's ${at(now)}. Time to start winding down. Lights out at ${at(plan.bedtimeAt)}, `
        + `so you get ${spokenDuration(plan.need.needMs)} of sleep before waking up ${wakeLine}.`;
      await this.d.voice.announce(dev.speaker, speech);
      if (dev.windDownTrigger) await this.d.voice.trigger(dev.windDownTrigger);
      return speech;
    }

    const speech = this.d.autoWakeTime
      ? `${hi}it's ${at(now)}. Time to go to sleep. Phone away, lights off. Good night!`
      : `${hi}it's ${at(now)}. Time to go to sleep. Phone away, lights off. I'll wake you ${wakeLine}. Good night!`;
    await this.d.voice.announce(dev.speaker, speech);
    if (dev.bedtimeTrigger) await this.d.voice.trigger(dev.bedtimeTrigger);
    return speech;
  }

  /**
   * Morning briefing: sleep, recovery, today's workout. Gives WHOOP up to ~3 minutes to finish
   * scoring recovery first, then speaks and runs the Morning routine.
   */
  private async wake(sleepHint?: any): Promise<string> {
    const s = this.d.settings;
    let sleep: any;
    let recovery: any;
    try {
      const client = await this.d.whoop();
      const since = new Date(this.now().getTime() - 16 * HOUR).toISOString();
      const pickSleep = async () => {
        if (sleepHint?.id) return (await client.getSleepById(sleepHint.id)) ?? sleepHint;
        return (await client.getSleep({ start: since, limit: 5 })).find((r) => isMainSleep(r));
      };
      for (let attempt = 0; ; attempt++) {
        sleep = await pickSleep();
        const recs = await client.getRecovery({ limit: 3 });
        recovery = recs.find((r) => sleep && r.sleep_id === sleep.id);
        const ready = sleep?.score_state === "SCORED" && recovery?.score_state === "SCORED";
        if (ready || !sleepHint || attempt >= 6) break;
        await this.wait(30_000);
      }
    } catch (e) {
      this.log(`morning WHOOP data unavailable: ${(e as Error).message}`);
    }

    let workout = null;
    if (this.d.hevy && this.d.workoutRotation?.length) {
      try {
        const [routines, workouts] = await Promise.all([this.d.hevy.getRoutines(), this.d.hevy.getWorkouts({ maxWorkouts: 10 })]);
        workout = plannedWorkout(this.d.workoutRotation, routines, workouts, s.tz, this.now());
      } catch (e) {
        this.log(`Hevy unavailable: ${(e as Error).message}`);
      }
    }

    const speech = buildMorningBriefing({ name: this.d.name, tz: s.tz, now: this.now(), sleep, recovery, workout });
    await this.d.voice.announce(this.d.devices.speaker, speech);
    if (this.d.devices.morningTrigger) await this.d.voice.trigger(this.d.devices.morningTrigger);
    return speech;
  }
}
