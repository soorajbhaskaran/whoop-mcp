import { dueEvents, estimateSleepNeed, nightIsNear, planNight, type CoachEventKind, type CoachSettings, type NightPlan, type SleepNeed } from "./planner.js";
import { spokenDuration, spokenTime } from "./time.js";

const HOUR = 3_600_000;

export interface WhoopReader {
  getSleep(range?: { start?: string; end?: string; limit?: number }): Promise<any[]>;
  getRecovery(range?: { start?: string; end?: string; limit?: number }): Promise<any[]>;
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
  whoop: () => Promise<WhoopReader>;
  voice: Announcer;
  store: FiredStore;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface TickResult {
  fired: string[];
  errors: string[];
}

export class SleepCoach {
  private needCache = new Map<string, SleepNeed>();

  constructor(private d: SleepCoachDeps) {}

  private now() { return this.d.now?.() ?? new Date(); }
  private log(msg: string) { (this.d.log ?? console.log)(`[sleep-coach] ${msg}`); }

  /** Tonight's sleep need, fetched once per night (keyed by the wake-up date). */
  private async needFor(now: Date): Promise<SleepNeed> {
    const { wakeDate } = planNight(now, this.d.settings, { needMs: 0, source: "default" });
    const hit = this.needCache.get(wakeDate);
    if (hit) return hit;
    let need: SleepNeed;
    try {
      const client = await this.d.whoop();
      need = estimateSleepNeed(await client.getSleep({ limit: 5 }), this.d.settings);
    } catch (e) {
      this.log(`couldn't read WHOOP sleep need, using default: ${(e as Error).message}`);
      return { needMs: this.d.settings.defaultNeedMs, source: "default" }; // don't cache; retry next tick
    }
    this.needCache.clear();
    this.needCache.set(wakeDate, need);
    return need;
  }

  async plan(): Promise<NightPlan> {
    const now = this.now();
    return planNight(now, this.d.settings, await this.needFor(now));
  }

  /** Call every few minutes. Fires whatever is due and hasn't fired yet. */
  async tick(): Promise<TickResult> {
    const now = this.now();
    const s = this.d.settings;
    // Only ask WHOOP for the sleep need when bedtime is getting close.
    const need = nightIsNear(now, s) ? await this.needFor(now) : { needMs: s.maxNeedMs, source: "default" as const };
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

  /** Run one event right now, ignoring the schedule (used by the /test endpoint). */
  async run(kind: CoachEventKind, now = this.now()): Promise<string> {
    const s = this.d.settings;
    const dev = this.d.devices;
    const hi = this.d.name ? `${this.d.name}, ` : "";
    const at = (t: Date) => spokenTime(s.tz, t);

    if (kind === "wind_down") {
      const plan = planNight(now, s, await this.needFor(now));
      const speech = `${hi}it's ${at(now)}. Time to start winding down. Lights out at ${at(plan.bedtimeAt)}, `
        + `so you get ${spokenDuration(plan.need.needMs)} of sleep before your ${at(plan.wakeAt)} wake-up.`;
      await this.d.voice.announce(dev.speaker, speech);
      if (dev.windDownTrigger) await this.d.voice.trigger(dev.windDownTrigger);
      return speech;
    }

    if (kind === "bedtime") {
      const plan = planNight(now, s, await this.needFor(now));
      const speech = `${hi}it's ${at(now)}. Time to go to sleep. Phone away, lights off. `
        + `I'll wake you at ${at(plan.wakeAt)}. Good night!`;
      await this.d.voice.announce(dev.speaker, speech);
      if (dev.bedtimeTrigger) await this.d.voice.trigger(dev.bedtimeTrigger);
      return speech;
    }

    const speech = `Good morning${this.d.name ? ` ${this.d.name}` : ""}! It's ${at(now)}, time to wake up. `
      + await this.morningStats(now);
    await this.d.voice.announce(dev.speaker, speech.trim());
    if (dev.morningTrigger) await this.d.voice.trigger(dev.morningTrigger);
    return speech.trim();
  }

  /** "You slept 7 hours 10 minutes, and your recovery is 72 percent." — or nothing if not scored yet. */
  private async morningStats(now: Date): Promise<string> {
    try {
      const client = await this.d.whoop();
      const since = new Date(now.getTime() - 14 * HOUR).toISOString();
      const [sleeps, recoveries] = await Promise.all([
        client.getSleep({ start: since, limit: 5 }),
        client.getRecovery({ start: since, limit: 1 }),
      ]);
      const sleep = sleeps.find((r) => !r.nap && r.score_state === "SCORED");
      const st = sleep?.score?.stage_summary;
      const sleptMs = st
        ? (st.total_light_sleep_time_milli ?? 0) + (st.total_slow_wave_sleep_time_milli ?? 0) + (st.total_rem_sleep_time_milli ?? 0)
        : 0;
      const rec = recoveries.find((r) => r.score_state === "SCORED")?.score?.recovery_score;
      const parts: string[] = [];
      if (sleptMs > 0) parts.push(`You slept ${spokenDuration(sleptMs)}`);
      if (typeof rec === "number") parts.push(`your recovery is ${Math.round(rec)} percent`);
      if (parts.length === 0) return "";
      const line = parts.join(", and ") + ".";
      const tip = typeof rec === "number"
        ? rec >= 67 ? " Good day to train hard." : rec < 34 ? " Take it easy today." : ""
        : "";
      return line.charAt(0).toUpperCase() + line.slice(1) + tip;
    } catch (e) {
      this.log(`morning stats unavailable: ${(e as Error).message}`);
      return "";
    }
  }
}
