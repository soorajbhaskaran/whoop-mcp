// Minimal client for the official Hevy public API (requires a Hevy Pro API key).
// Docs: https://api.hevyapp.com/docs/
const API_BASE = "https://api.hevyapp.com";
type FetchImpl = typeof fetch;

export class HevyClient {
  private templateCache?: { at: number; items: any[] };

  constructor(private apiKey: string, private fetchImpl: FetchImpl = fetch) {}

  private async json<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    let res = await this.fetchImpl(url.toString(), { headers: { "api-key": this.apiKey, accept: "application/json" } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await this.fetchImpl(url.toString(), { headers: { "api-key": this.apiKey, accept: "application/json" } });
    }
    if (res.status === 401 || res.status === 403) throw new Error("Hevy rejected the API key — check HEVY_API_KEY (Hevy Pro required).");
    if (!res.ok) throw new Error(`Hevy API ${res.status} on ${path}`);
    return res.json() as Promise<T>;
  }

  /** One page of workouts, newest first (Hevy caps pageSize at 10). */
  getWorkoutsPage(page = 1, pageSize = 10) {
    return this.json<{ page: number; page_count: number; workouts: any[] }>("/v1/workouts", { page, pageSize: Math.min(pageSize, 10) });
  }

  /** Workouts newest-first, walking pages until `since` (ISO date) or `maxWorkouts` is reached. */
  async getWorkouts(opts: { since?: string; until?: string; maxWorkouts?: number } = {}): Promise<any[]> {
    const max = Math.min(opts.maxWorkouts ?? 30, 200);
    const since = opts.since ? new Date(opts.since).getTime() : undefined;
    const until = opts.until ? new Date(opts.until).getTime() : undefined;
    const out: any[] = [];
    for (let page = 1; page <= 30; page++) {
      const res = await this.getWorkoutsPage(page, 10);
      let reachedSince = false;
      for (const w of res.workouts ?? []) {
        const t = new Date(w.start_time).getTime();
        if (until !== undefined && t > until) continue;
        if (since !== undefined && t < since) { reachedSince = true; break; }
        out.push(w);
        if (out.length >= max) return out;
      }
      if (reachedSince || page >= (res.page_count ?? 0)) break;
    }
    return out;
  }

  getWorkout(id: string) { return this.json<any>(`/v1/workouts/${encodeURIComponent(id)}`); }
  getWorkoutCount() { return this.json<{ workout_count: number }>("/v1/workouts/count"); }

  async getRoutines(): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.json<{ page: number; page_count: number; routines: any[] }>("/v1/routines", { page, pageSize: 10 });
      out.push(...(res.routines ?? []));
      if (page >= (res.page_count ?? 0)) break;
    }
    return out;
  }

  /** All exercise templates (library + custom), cached for an hour. */
  async getExerciseTemplates(): Promise<any[]> {
    if (this.templateCache && Date.now() - this.templateCache.at < 3_600_000) return this.templateCache.items;
    const items: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.json<{ page: number; page_count: number; exercise_templates: any[] }>(
        "/v1/exercise_templates", { page, pageSize: 100 });
      items.push(...(res.exercise_templates ?? []));
      if (page >= (res.page_count ?? 0)) break;
    }
    this.templateCache = { at: Date.now(), items };
    return items;
  }

  async searchExerciseTemplates(query: string): Promise<any[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = await this.getExerciseTemplates();
    return all.filter((t) => words.every((w) => String(t.title ?? "").toLowerCase().includes(w)))
      .map((t) => ({ id: t.id, title: t.title, type: t.type, primary_muscle_group: t.primary_muscle_group, is_custom: t.is_custom }));
  }

  getExerciseHistory(exerciseTemplateId: string, opts: { start_date?: string; end_date?: string } = {}) {
    return this.json<any>(`/v1/exercise_history/${encodeURIComponent(exerciseTemplateId)}`, opts);
  }
}

/** Compact a Hevy workout for LLM consumption: per exercise, the sets as "kg x reps" plus type. */
export function summarizeWorkout(w: any) {
  return {
    id: w.id,
    title: w.title,
    start_time: w.start_time,
    end_time: w.end_time,
    duration_min: w.start_time && w.end_time
      ? Math.round((new Date(w.end_time).getTime() - new Date(w.start_time).getTime()) / 60000) : undefined,
    exercises: (w.exercises ?? []).map((e: any) => ({
      title: e.title,
      exercise_template_id: e.exercise_template_id,
      notes: e.notes || undefined,
      sets: (e.sets ?? []).map((s: any) => ({
        type: s.type,
        weight_kg: s.weight_kg ?? undefined,
        reps: s.reps ?? undefined,
        distance_m: s.distance_meters ?? undefined,
        duration_s: s.duration_seconds ?? undefined,
        rpe: s.rpe ?? undefined,
      })),
    })),
  };
}
