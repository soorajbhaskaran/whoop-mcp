import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SETTINGS, dueEvents, estimateSleepNeed, morningWakeDate, planNight, typicalWakeTime, type CoachSettings } from "../src/sleep-coach/planner.js";
import { plannedWorkout } from "../src/sleep-coach/briefing.js";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { createWhoopWebhookHandler, verifyWhoopSignature } from "../src/sleep-coach/routes.js";
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
    nap: false, score_state: "SCORED", start: "2026-11-16T20:00:00Z", end: "2026-11-17T04:30:00Z",
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
    const nap = { ...sleep(7), start: "2026-11-17T10:00:00Z", end: "2026-11-17T10:40:00Z" };
    expect(estimateSleepNeed([nap, { ...sleep(7), score_state: "PENDING_SCORE" }], s))
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
      id: "s1", nap: false, score_state: "SCORED", start: "2026-11-17T16:50:00Z", end: "2026-11-18T00:58:00Z",
      score: {
        sleep_needed: { baseline_milli: 8 * H, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
        stage_summary: { total_light_sleep_time_milli: 4 * H, total_slow_wave_sleep_time_milli: 2 * H, total_rem_sleep_time_milli: 2 * H + 10 * M },
      },
    }]),
    getRecovery: vi.fn(async () => [{ sleep_id: "s1", score_state: "SCORED", score: { recovery_score: 72.4 } }]),
    getSleepById: vi.fn(async () => null),
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
      "Good morning Sooraj! It's 6:31 AM. You slept 8 hours 10 minutes. Your recovery is 72 percent, in the green. Have a great day!");
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

describe("WHOOP-driven wake-up and morning briefing", () => {
  const H = 3_600_000;
  const memStore = () => {
    const keys = new Set<string>();
    return { keys, async claim(k: string) { if (keys.has(k)) return false; keys.add(k); return true; }, async release(k: string) { keys.delete(k); } };
  };
  // Real-shaped records. 18 Nov: 01:40 → 09:32 IST.
  const scored = {
    stage_summary: { total_light_sleep_time_milli: 3.5 * H, total_slow_wave_sleep_time_milli: 1.5 * H, total_rem_sleep_time_milli: 2.5 * H + 10 * 60_000 },
    sleep_performance_percentage: 85,
    sleep_needed: { baseline_milli: 7.7 * H, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
  };
  const sleeps: Record<string, any> = {
    main: { id: "main", nap: false, score_state: "SCORED", start: "2026-11-17T20:10:00Z", end: "2026-11-18T04:02:00Z", score: scored },
    // WHOOP sometimes flags a full night as a nap — still the main sleep.
    mislabelled: { id: "mislabelled", nap: true, score_state: "SCORED", start: "2026-11-17T18:49:00Z", end: "2026-11-18T03:57:00Z", score: scored },
    nap: { id: "nap", nap: true, start: "2026-11-18T10:35:00Z", end: "2026-11-18T11:27:00Z" },
    split: { id: "split", nap: false, start: "2026-11-17T18:47:00Z", end: "2026-11-17T22:23:00Z" }, // ends 03:53 IST
    open: { id: "open", nap: false, start: "2026-11-17T20:10:00Z", end: null },
  };
  const history = ["2026-11-17T04:05:00Z", "2026-11-16T03:55:00Z", "2026-11-15T04:10:00Z"] // ~09:30 IST
    .map((end) => ({ nap: false, start: new Date(new Date(end).getTime() - 8 * H).toISOString(), end }));
  const recoveries = [{ sleep_id: "main", score_state: "SCORED", score: { recovery_score: 78, hrv_rmssd_milli: 138.7, resting_heart_rate: 50 } }];
  const routines = [
    { title: "Legs A (Quads)", exercises: [
      { title: "Pendulum Squat (Machine)", sets: [{ type: "warmup", rep_range: { start: 8, end: 10 } }, ...Array(3).fill({ type: "normal", rep_range: { start: 8, end: 10 } })] },
    ] },
  ];
  const rotation = ["Push A (Incline)", "Pull A (Lats)", "Legs A (Quads)", "Push B (Flat)", "Pull B (Back thickness)", "Legs B (Glutes & Hams)"];
  const hevyWorkouts = [{ title: "Pull A (Lats)", start_time: "2026-11-17T13:11:44+00:00" }, { title: "Push A (Incline)", start_time: "2026-11-16T13:06:58+00:00" }];

  const make = (now: string, opts: { recs?: any[]; hevy?: boolean } = {}) => {
    const voice = { announce: vi.fn(async () => {}), trigger: vi.fn(async () => {}) };
    const store = memStore();
    const wait = vi.fn(async () => {});
    const whoop = {
      getSleep: vi.fn(async () => [...Object.values(sleeps), ...history]),
      getRecovery: vi.fn(async () => opts.recs ?? recoveries),
      getSleepById: vi.fn(async (id: string) => sleeps[id]),
    };
    const coach = new SleepCoach({
      settings: { ...s, scheduledWake: false }, name: "Sooraj", autoWakeTime: true,
      workoutRotation: rotation,
      hevy: opts.hevy === false ? undefined : { getRoutines: async () => routines, getWorkouts: async () => hevyWorkouts },
      devices: { speaker: "echo", morningTrigger: "morning" },
      whoop: async () => whoop, voice, store, wait, now: () => new Date(now), log: () => {},
    });
    return { coach, voice, store, wait, whoop };
  };

  it("never schedules a clock-time wake-up when WHOOP drives it", () => {
    const off = { ...s, scheduledWake: false };
    expect(keys("2026-11-18T01:02:00Z", off)).toEqual([]);
  });

  it("detects the main morning sleep by length and time, not WHOOP's nap flag", () => {
    expect(morningWakeDate(sleeps.main, "Asia/Kolkata")).toBe("2026-11-18");
    expect(morningWakeDate(sleeps.mislabelled, "Asia/Kolkata")).toBe("2026-11-18");
    expect(morningWakeDate(sleeps.nap, "Asia/Kolkata")).toBeNull();
    expect(morningWakeDate(sleeps.split, "Asia/Kolkata")).toBeNull();
    expect(morningWakeDate(sleeps.open, "Asia/Kolkata")).toBeNull();
  });

  it("learns the usual wake-up time from WHOOP history", () => {
    // Sooraj's last nights ended 10:53, 10:16, 09:35, 09:12, 09:09, 09:27, 08:56 IST
    const ends = ["2026-11-17T05:23:00Z", "2026-11-16T04:46:00Z", "2026-11-15T04:05:00Z", "2026-11-14T03:42:00Z",
      "2026-11-13T03:39:00Z", "2026-11-12T03:57:00Z", "2026-11-09T03:26:00Z"];
    const hist = ends.map((end) => ({ start: new Date(new Date(end).getTime() - 8 * H).toISOString(), end }));
    expect(typicalWakeTime(hist, "Asia/Kolkata", new Date("2026-11-17T18:00:00Z"))).toBe("09:30");
    expect(typicalWakeTime(hist.slice(0, 2), "Asia/Kolkata", new Date("2026-11-17T18:00:00Z"))).toBeNull();
  });

  it("plans bedtime back from the learned wake-up time", async () => {
    const { coach } = make("2026-11-17T15:00:00Z"); // 20:30 IST
    const p = await coach.plan();
    expect(p.wakeTime).toBe("09:30");
    // 7.7h baseline, no shortfall (slept 7h40) → bedtime 01:48 IST
    expect(p.wakeAt.toISOString()).toBe("2026-11-18T04:00:00.000Z");
  });

  it("reads the full briefing and runs the Morning routine once WHOOP reports you awake", async () => {
    const { coach, voice } = make("2026-11-18T04:06:00Z"); // 09:36 IST
    expect(await coach.onWhoopEvent({ type: "sleep.updated", id: "main" })).toEqual({ fired: "wake:2026-11-18" });
    expect(voice.announce).toHaveBeenCalledWith("echo",
      "Good morning Sooraj! It's 9:36 AM. You slept 7 hours 40 minutes, a sleep performance of 85 percent. "
      + "Your recovery is 78 percent, in the green, with an HRV of 139 and a resting heart rate of 50. "
      + "Today is Legs A, Quads, starting with Pendulum Squat, 3 sets of 8 to 10. "
      + "You're well recovered, so push it. Have a great day!");
    expect(voice.trigger).toHaveBeenCalledWith("morning");
    expect((await coach.onWhoopEvent({ type: "recovery.updated", id: "main" })).skipped).toMatch(/already fired/);
    expect(voice.announce).toHaveBeenCalledTimes(1);
  });

  it("waits for WHOOP to finish scoring recovery, then speaks anyway after ~3 minutes", async () => {
    const { coach, voice, wait } = make("2026-11-18T04:06:00Z", { recs: [{ sleep_id: "main", score_state: "PENDING_SCORE" }], hevy: false });
    await coach.onWhoopEvent({ type: "sleep.updated", id: "main" });
    expect(wait).toHaveBeenCalledTimes(6);
    expect(voice.announce).toHaveBeenCalledWith("echo", expect.stringContaining("Your recovery is still being calculated"));
  });

  it("ignores naps, night wake-ups, open sleeps, old sleeps and other events", async () => {
    const { coach, voice } = make("2026-11-18T11:30:00Z");
    expect((await coach.onWhoopEvent({ type: "sleep.updated", id: "nap" })).skipped).toBeTruthy();
    expect((await coach.onWhoopEvent({ type: "sleep.updated", id: "open" })).skipped).toBeTruthy();
    expect((await coach.onWhoopEvent({ type: "sleep.updated", id: "main" })).skipped).toMatch(/over an hour/);
    expect((await coach.onWhoopEvent({ type: "workout.updated", id: "x" })).skipped).toBeTruthy();
    const early = make("2026-11-17T22:30:00Z").coach;
    expect((await early.onWhoopEvent({ type: "sleep.updated", id: "split" })).skipped).toMatch(/not a morning/);
    expect(voice.announce).not.toHaveBeenCalled();
  });

  it("picks the next workout in the rotation, wrapping around, and notices one done today", () => {
    const tz = "Asia/Kolkata";
    const now = new Date("2026-11-18T04:00:00Z");
    expect(plannedWorkout(rotation, routines, hevyWorkouts, tz, now)).toMatchObject({ title: "Legs A (Quads)", doneToday: false });
    expect(plannedWorkout(rotation, [], [{ title: "Legs B (Glutes & Hams)", start_time: "2026-11-17T13:00:00Z" }], tz, now)!.title).toBe("Push A (Incline)");
    expect(plannedWorkout(rotation, [], [{ title: "Pull A (Lats)", start_time: "2026-11-18T02:00:00Z" }], tz, now)).toMatchObject({ doneToday: true });
    expect(plannedWorkout([], [], hevyWorkouts, tz, now)).toBeNull();
  });

  it("verifies WHOOP webhook signatures and only acts for the owner", async () => {
    const secret = "client-secret";
    const onWhoopEvent = vi.fn(async () => ({ fired: "wake:x" }));
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    app.post("/hook", createWhoopWebhookHandler({ coach: { onWhoopEvent } as any, ownerWhoopUserId: async () => "42" }, secret));
    const send = (body: object, sign = true) => {
      const raw = JSON.stringify(body);
      const ts = String(Date.now());
      const sig = createHmac("sha256", sign ? secret : "wrong").update(ts + raw).digest("base64");
      return request(app).post("/hook").set("Content-Type", "application/json")
        .set("X-WHOOP-Signature", sig).set("X-WHOOP-Signature-Timestamp", ts).send(raw);
    };
    expect((await send({ user_id: 42, id: "main", type: "sleep.updated" }, false)).status).toBe(401);
    expect((await send({ user_id: 7, id: "main", type: "sleep.updated" })).status).toBe(204);
    expect((await send({ user_id: 42, id: "main", type: "sleep.updated" })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 20));
    expect(onWhoopEvent).toHaveBeenCalledTimes(1);
    expect(onWhoopEvent).toHaveBeenCalledWith({ type: "sleep.updated", id: "main" });
    expect(verifyWhoopSignature(Buffer.from("{}"), "1", "nope", secret)).toBe(false);
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
  it("parses the WHOOP wake source, auto wake time and workout rotation", () => {
    const on = { ...base, VOICE_MONKEY_TOKEN: "t", VOICE_MONKEY_SPEAKER: "echo", SLEEP_COACH_SECRET: "x".repeat(16) };
    expect(loadConfig(on as any).sleepCoach).toMatchObject({ wakeSource: "time", autoWakeTime: false, wakeTime: "06:30", workoutRotation: [] });
    expect(loadConfig({ ...on, SLEEP_COACH_WAKE_SOURCE: "whoop" } as any).sleepCoach).toMatchObject({ wakeSource: "whoop", autoWakeTime: true });
    expect(loadConfig({ ...on, SLEEP_COACH_WAKE_SOURCE: "whoop", SLEEP_COACH_WAKE_TIME: "09:30" } as any).sleepCoach)
      .toMatchObject({ autoWakeTime: false, wakeTime: "09:30" });
    expect(loadConfig({ ...on, SLEEP_COACH_WORKOUT_ROTATION: "Push A (Incline), Pull A (Lats)" } as any).sleepCoach!.workoutRotation)
      .toEqual(["Push A (Incline)", "Pull A (Lats)"]);
    expect(() => loadConfig({ ...on, SLEEP_COACH_WAKE_SOURCE: "fitbit" } as any)).toThrow(/WAKE_SOURCE/);
  });
  it("rejects bad times and missing pieces", () => {
    const on = { ...base, VOICE_MONKEY_TOKEN: "t", VOICE_MONKEY_SPEAKER: "echo", SLEEP_COACH_SECRET: "x".repeat(16) };
    expect(() => loadConfig({ ...on, SLEEP_COACH_WAKE_TIME: "6:30" } as any)).toThrow(/HH:MM/);
    expect(() => loadConfig({ ...on, VOICE_MONKEY_SPEAKER: "" } as any)).toThrow(/VOICE_MONKEY_SPEAKER/);
    expect(() => loadConfig({ ...on, SLEEP_COACH_SECRET: "short" } as any)).toThrow(/16/);
  });
});
