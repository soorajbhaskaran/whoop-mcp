import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS, dueEvents, estimateSleepNeed, planNight, type CoachSettings } from "../src/sleep-coach/planner.js";
import { SleepCoach, type FiredStore } from "../src/sleep-coach/service.js";
import { zonedInstant, spokenDuration } from "../src/sleep-coach/time.js";
import { loadConfig } from "../src/config.js";

const H = 3_600_000;
const M = 60_000;
const s: CoachSettings = { ...DEFAULT_SETTINGS, tz: "Asia/Kolkata", wakeTime: "06:30" };
const need8 = { needMs: 8 * H, source: "whoop" as const };
const keys = (now: string, settings = s, need = need8) => dueEvents(new Date(now), settings, need).map((e) => e.key);

describe("time helpers", () => {
  it("converts IST wall clock to UTC", () => {
    expect(zonedInstant("2026-11-18", "06:30", "Asia/Kolkata").toISOString()).toBe("2026-11-18T01:00:00.000Z");
  });
  it("speaks durations", () => {
    expect(spokenDuration(7 * H + 10 * M)).toBe("7 hours 10 minutes");
    expect(spokenDuration(8 * H)).toBe("8 hours");
  });
});

describe("dueEvents", () => {
  // Wake 06:30 IST, need 8h → bedtime 22:30 IST (17:00Z), wind-down 22:00 IST (16:30Z).
  it("fires wind-down, then bedtime, then wake", () => {
    expect(keys("2026-11-17T16:20:00Z")).toEqual([]);
    expect(keys("2026-11-17T16:35:00Z")).toEqual(["wind_down:2026-11-18"]);
    expect(keys("2026-11-17T17:05:00Z")).toEqual(["bedtime:2026-11-18"]);
    expect(keys("2026-11-18T01:02:00Z")).toEqual(["wake:2026-11-18"]);
  });
  it("doesn't fire stale events outside the window", () => {
    expect(keys("2026-11-17T18:45:00Z")).toEqual([]); // 00:15 IST, bedtime window ended at 00:00
    expect(keys("2026-11-18T03:00:00Z")).toEqual([]); // 08:30 IST, wake window ended at 08:00
  });
  it("handles a bedtime after midnight", () => {
    const late = { ...s, wakeTime: "08:00" }; // bedtime 00:00 IST
    expect(keys("2026-11-17T18:10:00Z", late)).toEqual(["wind_down:2026-11-18"]); // 23:40 IST on the 17th
    expect(keys("2026-11-17T18:35:00Z", late)).toEqual(["bedtime:2026-11-18"]);   // 00:05 IST on the 18th
  });
  it("uses the weekend wake time on Saturday and Sunday mornings", () => {
    const wk = { ...s, weekendWakeTime: "08:00" };
    // Friday night → Saturday 2026-11-21 08:00 wake → bedtime 00:00
    const plan = planNight(new Date("2026-11-20T15:00:00Z"), wk, need8);
    expect(plan.wakeAt.toISOString()).toBe("2026-11-21T02:30:00.000Z");
    expect(plan.bedtimeAt.toISOString()).toBe("2026-11-20T18:30:00.000Z");
  });
  it("skips wind-down when disabled", () => {
    expect(keys("2026-11-17T16:35:00Z", { ...s, windDownMinutes: 0 })).toEqual([]);
  });
});

describe("estimateSleepNeed", () => {
  const sleep = (sleptH: number, extra = {}) => ({
    nap: false, score_state: "SCORED",
    score: {
      sleep_needed: { baseline_milli: 7.5 * H, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0.5 * H, need_from_recent_nap_milli: 0, ...extra },
      stage_summary: { total_light_sleep_time_milli: sleptH * H * 0.5, total_slow_wave_sleep_time_milli: sleptH * H * 0.25, total_rem_sleep_time_milli: sleptH * H * 0.25 },
    },
  });
  it("adds last night's shortfall to the baseline", () => {
    const n = estimateSleepNeed([sleep(7.5)], s); // needed 8h, slept 7.5h → +30 min
    expect(n.needMs).toBe(8 * H);
    expect(n.source).toBe("whoop");
  });
  it("caps the carryover and the total", () => {
    expect(estimateSleepNeed([sleep(3)], s).needMs).toBe(9 * H); // 7.5h + 90 min cap
    expect(estimateSleepNeed([sleep(3, { baseline_milli: 9.5 * H })], s).needMs).toBe(10 * H);
  });
  it("ignores naps and unscored sleeps, falling back to the default", () => {
    expect(estimateSleepNeed([{ ...sleep(7), nap: true }, { ...sleep(7), score_state: "PENDING_SCORE" }], s))
      .toEqual({ needMs: 8 * H, source: "default" });
  });
});

describe("SleepCoach", () => {
  const memStore = (): FiredStore & { keys: Set<string> } => {
    const keys = new Set<string>();
    return {
      keys,
      async claim(k) { if (keys.has(k)) return false; keys.add(k); return true; },
      async release(k) { keys.delete(k); },
    };
  };
  const whoop = {
    getSleep: vi.fn(async () => [{
      nap: false, score_state: "SCORED",
      score: {
        sleep_needed: { baseline_milli: 8 * H, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
        stage_summary: { total_light_sleep_time_milli: 4 * H, total_slow_wave_sleep_time_milli: 2 * H, total_rem_sleep_time_milli: 2 * H + 10 * M },
      },
    }]),
    getRecovery: vi.fn(async () => [{ score_state: "SCORED", score: { recovery_score: 72.4 } }]),
  };
  const make = (now: string, voice = { announce: vi.fn(async () => {}), trigger: vi.fn(async () => {}) }, store = memStore()) => ({
    voice, store,
    coach: new SleepCoach({
      settings: s, name: "Sooraj",
      devices: { speaker: "echo", bedtimeTrigger: "bed", morningTrigger: "morning" },
      whoop: async () => whoop, voice, store, now: () => new Date(now), log: () => {},
    }),
  });

  it("announces bedtime and fires the bedtime routine once", async () => {
    const { coach, voice } = make("2026-11-17T17:05:00Z"); // 22:35 IST
    expect((await coach.tick()).fired).toEqual(["bedtime:2026-11-18"]);
    expect(voice.announce).toHaveBeenCalledWith("echo", expect.stringMatching(/^Sooraj, it's 10:35 PM\. Time to go to sleep.*6:30 AM/));
    expect(voice.trigger).toHaveBeenCalledWith("bed");
    expect((await coach.tick()).fired).toEqual([]);
    expect(voice.announce).toHaveBeenCalledTimes(1);
  });

  it("wakes up with sleep and recovery stats, then runs the morning routine", async () => {
    const { coach, voice } = make("2026-11-18T01:01:00Z"); // 06:31 IST
    await coach.tick();
    expect(voice.announce).toHaveBeenCalledWith("echo",
      "Good morning Sooraj! It's 6:31 AM, time to wake up. You slept 8 hours 10 minutes, and your recovery is 72 percent. Good day to train hard.");
    expect(voice.trigger).toHaveBeenCalledWith("morning");
  });

  it("releases the event when Voice Monkey fails so the next tick retries", async () => {
    const voice = { announce: vi.fn(async () => { throw new Error("boom"); }), trigger: vi.fn(async () => {}) };
    const { coach, store } = make("2026-11-17T17:05:00Z", voice);
    const r = await coach.tick();
    expect(r.errors[0]).toMatch(/bedtime:2026-11-18: boom/);
    expect(store.keys.size).toBe(0);
  });
});

describe("sleep coach config", () => {
  const base = {
    DATABASE_URL: "postgres://x", ENCRYPTION_KEY: "a".repeat(64),
    WHOOP_CLIENT_ID: "id", WHOOP_CLIENT_SECRET: "secret",
    PUBLIC_BASE_URL: "https://example.com", PORT: "8080",
    SESSION_SECRET: "test-session-secret-1234567890", OWNER_EMAILS: "Me@Example.com",
  };
  it("is off without VOICE_MONKEY_TOKEN", () => {
    expect(loadConfig(base as any).sleepCoach).toBeUndefined();
  });
  it("parses settings with defaults", () => {
    const c = loadConfig({ ...base, VOICE_MONKEY_TOKEN: "t", VOICE_MONKEY_SPEAKER: "echo", SLEEP_COACH_SECRET: "x".repeat(16) } as any);
    expect(c.sleepCoach).toMatchObject({ ownerEmail: "me@example.com", timezone: "Asia/Kolkata", wakeTime: "06:30", windDownMinutes: 30 });
  });
  it("rejects bad times and missing pieces", () => {
    const on = { ...base, VOICE_MONKEY_TOKEN: "t", VOICE_MONKEY_SPEAKER: "echo", SLEEP_COACH_SECRET: "x".repeat(16) };
    expect(() => loadConfig({ ...on, SLEEP_COACH_WAKE_TIME: "6:30" } as any)).toThrow(/HH:MM/);
    expect(() => loadConfig({ ...on, VOICE_MONKEY_SPEAKER: "" } as any)).toThrow(/VOICE_MONKEY_SPEAKER/);
    expect(() => loadConfig({ ...on, SLEEP_COACH_SECRET: "short" } as any)).toThrow(/16/);
  });
});
