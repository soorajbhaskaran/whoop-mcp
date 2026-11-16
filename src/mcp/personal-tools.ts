import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HevyClient, summarizeWorkout } from "../hevy/client.js";
import { StravaClient, summarizeActivity } from "../strava/client.js";

// Hevy uses one server-wide API key and Strava one owner's account, so these tools are only
// served to "owner" users (WHOOP email in OWNER_EMAILS / ALLOWED_WHOOP_EMAILS). Anyone else who
// connects to this server gets a clear refusal instead of the owner's data.
export interface PersonalDeps {
  isOwner: (userId: string) => Promise<boolean>;
  hevy?: HevyClient;
  stravaFor?: (userId: string) => StravaClient;
  stravaAthleteId?: (userId: string) => Promise<string>;
  stravaConnectUrl?: string;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as any };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function makePersonalHandlers(deps: PersonalDeps) {
  const guard = (service: "Hevy" | "Strava", fn: (args: any, userId: string) => Promise<unknown>) =>
    async (args: any, ctx: { userId: string }) => {
      try {
        if (!(await deps.isOwner(ctx.userId))) return err(`${service} tools are only available to this server's owner.`);
        if (service === "Hevy" && !deps.hevy) return err("Hevy isn't configured — set HEVY_API_KEY on the server.");
        if (service === "Strava" && !deps.stravaFor) return err("Strava isn't configured — set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET on the server.");
        return ok(await fn(args, ctx.userId));
      } catch (e) {
        const msg = (e as Error).message;
        if (/Strava not connected/i.test(msg)) {
          return err(`Strava isn't connected yet. Open ${deps.stravaConnectUrl ?? "/dashboard/strava/connect"} (signed in to the dashboard) to connect it.`);
        }
        return err(`${service} request failed: ${msg}`);
      }
    };

  return {
    hevy_get_workouts: guard("Hevy", async (a) => {
      const workouts = await deps.hevy!.getWorkouts({ since: a.since, until: a.until, maxWorkouts: a.max_workouts });
      return { count: workouts.length, workouts: workouts.map(summarizeWorkout) };
    }),
    hevy_get_workout: guard("Hevy", async (a) => summarizeWorkout(await deps.hevy!.getWorkout(a.workout_id))),
    hevy_get_workout_count: guard("Hevy", async () => deps.hevy!.getWorkoutCount()),
    hevy_get_routines: guard("Hevy", async () => {
      const routines = await deps.hevy!.getRoutines();
      return {
        routines: routines.map((r: any) => ({
          id: r.id, title: r.title, folder_id: r.folder_id,
          exercises: (r.exercises ?? []).map((e: any) => ({
            title: e.title, exercise_template_id: e.exercise_template_id, notes: e.notes || undefined,
            rest_seconds: e.rest_seconds ?? undefined,
            sets: (e.sets ?? []).map((s: any) => ({
              type: s.type, reps: s.reps ?? undefined, rep_range: s.rep_range ?? undefined, weight_kg: s.weight_kg ?? undefined,
            })),
          })),
        })),
      };
    }),
    hevy_search_exercises: guard("Hevy", async (a) => ({ matches: (await deps.hevy!.searchExerciseTemplates(a.query)).slice(0, 25) })),
    hevy_get_exercise_history: guard("Hevy", async (a) =>
      deps.hevy!.getExerciseHistory(a.exercise_template_id, { start_date: a.start_date, end_date: a.end_date })),

    strava_get_activities: guard("Strava", async (a, userId) => {
      const acts = await deps.stravaFor!(userId).getActivities({ after: a.after, before: a.before, page: a.page, per_page: a.per_page });
      return { count: acts.length, activities: acts.map(summarizeActivity) };
    }),
    strava_get_activity: guard("Strava", async (a, userId) => {
      const act = await deps.stravaFor!(userId).getActivity(a.activity_id);
      return { ...summarizeActivity(act), description: act.description ?? undefined, splits_metric: act.splits_metric ?? undefined };
    }),
    strava_get_athlete_stats: guard("Strava", async (_a, userId) => {
      const athleteId = await deps.stravaAthleteId!(userId);
      return deps.stravaFor!(userId).getAthleteStats(athleteId);
    }),
  };
}

export function registerPersonalTools(server: McpServer, deps: PersonalDeps, userIdOf: (extra: any) => string): void {
  const h = makePersonalHandlers(deps);
  const reg = (name: keyof typeof h, description: string, shape: any) =>
    server.registerTool(name, { description, inputSchema: shape },
      async (args: any, extra: any) => h[name](args, { userId: userIdOf(extra) }));
  const isoDate = z.string().describe("ISO date or datetime, e.g. 2026-11-01");

  reg("hevy_get_workouts", "Hevy strength workouts newest first, with every exercise and set (kg x reps, set type). Filter with since/until.",
    { since: isoDate.optional(), until: isoDate.optional(), max_workouts: z.number().int().min(1).max(200).optional() });
  reg("hevy_get_workout", "One Hevy workout by id, with all exercises and sets.", { workout_id: z.string() });
  reg("hevy_get_workout_count", "Total number of workouts logged in Hevy.", {});
  reg("hevy_get_routines", "The user's saved Hevy routines (exercises, target sets, rep ranges).", {});
  reg("hevy_search_exercises", "Find Hevy exercise templates by name (returns ids for hevy_get_exercise_history).", { query: z.string().min(2) });
  reg("hevy_get_exercise_history", "Every logged set of one exercise over time (weights, reps) - use for progress and heaviest-lift questions.",
    { exercise_template_id: z.string(), start_date: isoDate.optional(), end_date: isoDate.optional() });

  reg("strava_get_activities", "Strava activities newest first (distance, time, HR, elevation). after/before are ISO dates.",
    { after: isoDate.optional(), before: isoDate.optional(), page: z.number().int().min(1).optional(), per_page: z.number().int().min(1).max(100).optional() });
  reg("strava_get_activity", "One Strava activity in detail, including km splits.", { activity_id: z.string() });
  reg("strava_get_athlete_stats", "Strava totals: recent (4 weeks), year-to-date and all-time for run/ride/swim.", {});
}
