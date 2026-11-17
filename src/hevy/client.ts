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

  /** Write call (PUT/POST) with a JSON body. */
  private async send<T>(method: "PUT" | "POST", path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(API_BASE + path, {
      method,
      headers: { "api-key": this.apiKey, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new Error("Hevy rejected the API key — check HEVY_API_KEY (Hevy Pro required).");
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Hevy API ${res.status} on ${method} ${path}: ${detail.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Patch a routine: exercises matched by exercise_template_id get the given notes / rest / sets;
   * every other exercise and field is sent back unchanged (Hevy's PUT replaces the whole routine).
   */
  async updateRoutine(routineId: string, patch: {
    title?: string;
    notes?: string;
    exercises: Array<{ exercise_template_id: string; notes?: string; rest_seconds?: number;
      sets?: Array<{ type?: string; weight_kg?: number | null; reps?: number | null; rep_range?: { start: number; end: number } | null }> }>;
  }) {
    const routine = (await this.getRoutines()).find((r) => r.id === routineId);
    if (!routine) throw new Error(`No Hevy routine with id ${routineId}`);
    const byId = new Map(patch.exercises.map((e) => [e.exercise_template_id, e]));
    const unknown = patch.exercises.filter((e) => !(routine.exercises ?? []).some((x: any) => x.exercise_template_id === e.exercise_template_id));
    if (unknown.length) throw new Error(`Not in routine "${routine.title}": ${unknown.map((u) => u.exercise_template_id).join(", ")}`);
    const cleanSet = (s: any) => ({
      type: s.type ?? "normal",
      weight_kg: s.weight_kg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distance_meters ?? null,
      duration_seconds: s.duration_seconds ?? null,
      ...(s.rep_range ? { rep_range: { start: s.rep_range.start, end: s.rep_range.end } } : {}),
    });
    const exercises = (routine.exercises ?? []).map((e: any) => {
      const c = byId.get(e.exercise_template_id);
      const sets = c?.sets
        ? c.sets.map((s, i) => cleanSet({ ...(e.sets?.[i] ?? {}), ...s }))
        : (e.sets ?? []).map(cleanSet);
      return {
        exercise_template_id: e.exercise_template_id,
        superset_id: e.superset_id ?? null,
        rest_seconds: c?.rest_seconds ?? e.rest_seconds ?? null,
        notes: c?.notes ?? e.notes ?? null,
        sets,
      };
    });
    const body = { routine: { title: patch.title ?? routine.title, notes: patch.notes ?? routine.notes ?? null, exercises } };
    return this.send<any>("PUT", `/v1/routines/${encodeURIComponent(routineId)}`, body);
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
    description: w.description || undefined,
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
