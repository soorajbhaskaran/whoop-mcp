// Minimal Strava API v3 client (https://developers.strava.com/docs/reference/).
const API_BASE = "https://www.strava.com/api/v3";
type FetchImpl = typeof fetch;

export class StravaClient {
  constructor(
    private getAccessToken: (force?: boolean) => Promise<string>,
    private fetchImpl: FetchImpl = fetch,
  ) {}

  private async json<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const call = async (force: boolean) =>
      this.fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${await this.getAccessToken(force)}` } });
    let res = await call(false);
    if (res.status === 401) res = await call(true);
    if (res.status === 401) throw new Error("Strava authorization failed — please reconnect Strava.");
    if (res.status === 429) throw new Error("Strava rate limit reached — try again in 15 minutes.");
    if (!res.ok) throw new Error(`Strava API ${res.status} on ${path}`);
    return res.json() as Promise<T>;
  }

  /** Activities newest first. after/before are ISO dates; per_page max 100. */
  getActivities(opts: { after?: string; before?: string; page?: number; per_page?: number } = {}) {
    const toEpoch = (d?: string) => (d ? Math.floor(new Date(d).getTime() / 1000) : undefined);
    return this.json<any[]>("/athlete/activities", {
      after: toEpoch(opts.after), before: toEpoch(opts.before),
      page: opts.page ?? 1, per_page: Math.min(opts.per_page ?? 30, 100),
    });
  }

  getActivity(id: string) { return this.json<any>(`/activities/${encodeURIComponent(id)}`, { include_all_efforts: "false" }); }
  getAthlete() { return this.json<any>("/athlete"); }
  getAthleteStats(athleteId: string) { return this.json<any>(`/athletes/${encodeURIComponent(athleteId)}/stats`); }
}

export function summarizeActivity(a: any) {
  return {
    id: a.id,
    name: a.name,
    sport_type: a.sport_type ?? a.type,
    start_date_local: a.start_date_local,
    distance_km: a.distance != null ? Math.round(a.distance / 10) / 100 : undefined,
    moving_time_min: a.moving_time != null ? Math.round(a.moving_time / 6) / 10 : undefined,
    elapsed_time_min: a.elapsed_time != null ? Math.round(a.elapsed_time / 6) / 10 : undefined,
    elevation_gain_m: a.total_elevation_gain ?? undefined,
    average_heartrate: a.average_heartrate ?? undefined,
    max_heartrate: a.max_heartrate ?? undefined,
    average_speed_kmh: a.average_speed != null ? Math.round(a.average_speed * 36) / 10 : undefined,
    calories: a.calories ?? undefined,
    kilojoules: a.kilojoules ?? undefined,
    suffer_score: a.suffer_score ?? undefined,
    device_name: a.device_name ?? undefined,
  };
}
