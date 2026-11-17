import { localDate, spokenDuration, spokenTime } from "./time.js";

/** Today's planned session, from a fixed routine rotation and your latest Hevy workouts. */
export interface PlannedWorkout {
  title: string;
  /** The last rotation workout was already logged today. */
  doneToday: boolean;
  /** "Pendulum Squat, 3 sets of 8 to 10" — the first working exercise of the routine. */
  firstExercise?: string;
}

const norm = (t: string) => t.trim().toLowerCase();

function describeFirstExercise(routine: any): string | undefined {
  const ex = (routine?.exercises ?? []).find((e: any) =>
    (e.sets ?? []).some((s: any) => s.type !== "warmup"));
  if (!ex) return undefined;
  const working = ex.sets.filter((s: any) => s.type !== "warmup");
  const first = working[0] ?? {};
  const reps = first.rep_range ? `${first.rep_range.start} to ${first.rep_range.end}` : first.reps ? `${first.reps}` : undefined;
  const weight = first.weight_kg ? ` at ${first.weight_kg} kilos` : "";
  const name = String(ex.title).replace(/\s*\([^)]*\)/g, "").trim(); // drop "(Machine)", "(Dumbbell)"
  return reps ? `${name}, ${working.length} sets of ${reps}${weight}` : name;
}

/**
 * The next routine in `rotation` after the most recent Hevy workout that matches one of its titles.
 * If that workout was today, it's reported as done instead.
 */
export function plannedWorkout(rotation: string[], routines: any[], workouts: any[], tz: string, now: Date): PlannedWorkout | null {
  if (rotation.length === 0) return null;
  const idx = (title: string) => rotation.findIndex((r) => norm(r) === norm(title ?? ""));
  const last = workouts.find((w) => idx(w.title) >= 0); // newest first
  const routineFor = (title: string) => routines.find((r) => norm(r.title) === norm(title));
  if (last && localDate(tz, new Date(last.start_time)) === localDate(tz, now)) {
    return { title: rotation[idx(last.title)], doneToday: true };
  }
  const title = rotation[last ? (idx(last.title) + 1) % rotation.length : 0];
  return { title, doneToday: false, firstExercise: describeFirstExercise(routineFor(title)) };
}

export interface BriefingInput {
  name?: string;
  tz: string;
  now: Date;
  sleep?: any;     // WHOOP sleep record for last night
  recovery?: any;  // WHOOP recovery record for that sleep
  workout?: PlannedWorkout | null;
}

/** Spoken names: "Legs A (Quads)" → "Legs A, Quads". */
const speakable = (t: string) => t.replace(/\s*\(\s*/g, ", ").replace(/\s*\)\s*/g, " ").replace(/&/g, "and").trim();

/** The good-morning message Alexa reads out. */
export function buildMorningBriefing(b: BriefingInput): string {
  const parts: string[] = [];
  parts.push(`Good morning${b.name ? ` ${b.name}` : ""}! It's ${spokenTime(b.tz, b.now)}.`);

  const st = b.sleep?.score_state === "SCORED" ? b.sleep.score : undefined;
  if (st?.stage_summary) {
    const s = st.stage_summary;
    const slept = (s.total_light_sleep_time_milli ?? 0) + (s.total_slow_wave_sleep_time_milli ?? 0) + (s.total_rem_sleep_time_milli ?? 0);
    const perf = typeof st.sleep_performance_percentage === "number" ? `, a sleep performance of ${Math.round(st.sleep_performance_percentage)} percent` : "";
    parts.push(`You slept ${spokenDuration(slept)}${perf}.`);
  }

  const rec = b.recovery?.score_state === "SCORED" ? b.recovery.score : undefined;
  let zone: "green" | "yellow" | "red" | undefined;
  if (typeof rec?.recovery_score === "number") {
    const score = Math.round(rec.recovery_score);
    zone = score >= 67 ? "green" : score >= 34 ? "yellow" : "red";
    const extras: string[] = [];
    if (typeof rec.hrv_rmssd_milli === "number") extras.push(`an HRV of ${Math.round(rec.hrv_rmssd_milli)}`);
    if (typeof rec.resting_heart_rate === "number") extras.push(`a resting heart rate of ${Math.round(rec.resting_heart_rate)}`);
    parts.push(`Your recovery is ${score} percent, in the ${zone}${extras.length ? `, with ${extras.join(" and ")}` : ""}.`);
  } else {
    parts.push("Your recovery is still being calculated; check WHOOP in a few minutes.");
  }

  const w = b.workout;
  if (w?.doneToday) {
    parts.push(`You've already done ${speakable(w.title)} today.`);
  } else if (w) {
    parts.push(`Today is ${speakable(w.title)}${w.firstExercise ? `, starting with ${speakable(w.firstExercise)}` : ""}.`);
    if (zone === "green") parts.push("You're well recovered, so push it.");
    else if (zone === "yellow") parts.push("Train as planned, but don't chase personal records.");
    else if (zone === "red") parts.push("Recovery is low, so keep it light or take a rest day.");
  }

  parts.push("Have a great day!");
  return parts.join(" ");
}
