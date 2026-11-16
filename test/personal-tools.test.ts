import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { makePersonalHandlers } from "../src/mcp/personal-tools.js";
import { HevyClient } from "../src/hevy/client.js";
import { StravaClient } from "../src/strava/client.js";
import { buildStravaAuthorizeUrl, exchangeStravaCode } from "../src/strava/oauth.js";
import { createStravaRouter } from "../src/strava/routes.js";
import { loadConfig } from "../src/config.js";

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("owner gating", () => {
  it("refuses Hevy tools for non-owners", async () => {
    const hevy = { getWorkouts: vi.fn() } as any;
    const h = makePersonalHandlers({ isOwner: async () => false, hevy });
    const r: any = await h.hevy_get_workouts({}, { userId: "u1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/owner/);
    expect(hevy.getWorkouts).not.toHaveBeenCalled();
  });

  it("explains how to connect Strava when not linked", async () => {
    const strava = { getActivities: vi.fn(async () => { throw new Error("Strava not connected"); }) } as any;
    const h = makePersonalHandlers({ isOwner: async () => true, stravaFor: () => strava, stravaConnectUrl: "https://x/dashboard/strava/connect" });
    const r: any = await h.strava_get_activities({}, { userId: "u1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("https://x/dashboard/strava/connect");
  });

  it("reports missing configuration", async () => {
    const h = makePersonalHandlers({ isOwner: async () => true });
    const r: any = await h.hevy_get_routines({}, { userId: "u1" });
    expect(r.content[0].text).toMatch(/HEVY_API_KEY/);
  });
});

describe("HevyClient", () => {
  it("sends the api-key header and stops paging at `since`", async () => {
    const pages: Record<string, any> = {
      "1": { page: 1, page_count: 3, workouts: [
        { id: "a", start_time: "2026-11-10T10:00:00Z" }, { id: "b", start_time: "2026-11-05T10:00:00Z" }] },
      "2": { page: 2, page_count: 3, workouts: [
        { id: "c", start_time: "2026-11-02T10:00:00Z" }, { id: "d", start_time: "2026-10-20T10:00:00Z" }] },
    };
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(init.headers["api-key"]).toBe("k");
      return jsonRes(pages[new URL(url).searchParams.get("page")!]);
    });
    const c = new HevyClient("k", fetchImpl as any);
    const ws = await c.getWorkouts({ since: "2026-11-01" });
    expect(ws.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("searches exercise templates by all words", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ page: 1, page_count: 1, exercise_templates: [
      { id: "1", title: "Leg Press (Machine)" }, { id: "2", title: "Single Leg Press (Machine)" }, { id: "3", title: "Bench Press (Dumbbell)" }] }));
    const c = new HevyClient("k", fetchImpl as any);
    expect((await c.searchExerciseTemplates("leg press")).map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("surfaces a clear error for a bad key", async () => {
    const c = new HevyClient("bad", vi.fn(async () => jsonRes({}, 401)) as any);
    await expect(c.getWorkoutCount()).rejects.toThrow(/API key/);
  });
});

describe("Strava", () => {
  it("builds an authorize URL with activity scope", () => {
    const u = new URL(buildStravaAuthorizeUrl({ clientId: "1", redirectUri: "https://h/dashboard/strava/callback", state: "s" }));
    expect(u.searchParams.get("scope")).toContain("activity:read_all");
    expect(u.searchParams.get("state")).toBe("s");
  });

  it("exchanges a code and reads expires_at as epoch seconds", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ access_token: "at", refresh_token: "rt", expires_at: 2000000000, athlete: { id: 42 } }));
    const t = await exchangeStravaCode("c", { clientId: "1", clientSecret: "s" }, "read,activity:read_all", fetchImpl as any);
    expect(t.athleteId).toBe("42");
    expect(t.expiresAt.getTime()).toBe(2000000000 * 1000);
    expect(t.scopes).toEqual(["read", "activity:read_all"]);
  });

  it("retries once with a forced token refresh on 401", async () => {
    const tokens: boolean[] = [];
    const getToken = vi.fn(async (force?: boolean) => { tokens.push(!!force); return force ? "new" : "old"; });
    let n = 0;
    const fetchImpl = vi.fn(async () => (n++ === 0 ? jsonRes({}, 401) : jsonRes([{ id: 1, distance: 5000, moving_time: 1500 }])));
    const c = new StravaClient(getToken, fetchImpl as any);
    const acts = await c.getActivities({ after: "2026-11-01" });
    expect(acts).toHaveLength(1);
    expect(tokens).toEqual([false, true]);
  });

  it("requires a dashboard session before linking", async () => {
    const app = express();
    app.use("/dashboard/strava", createStravaRouter({
      creds: { clientId: "1", clientSecret: "s" }, store: {} as any, sessionSecret: "x".repeat(32),
      publicBaseUrl: "https://h", isOwner: async () => true,
    }));
    const r = await request(app).get("/dashboard/strava/connect");
    expect(r.status).toBe(401);
    const cb = await request(app).get("/dashboard/strava/callback?code=c&state=s");
    expect(cb.status).toBe(401);
  });
});

describe("config", () => {
  it("defaults owners to the allowlist and reads optional keys", () => {
    const c = loadConfig({
      DATABASE_URL: "postgres://x", ENCRYPTION_KEY: "a".repeat(64), WHOOP_CLIENT_ID: "i", WHOOP_CLIENT_SECRET: "s",
      PUBLIC_BASE_URL: "https://h", SESSION_SECRET: "s".repeat(20), ALLOWED_WHOOP_EMAILS: "Me@X.com", HEVY_API_KEY: " k ",
    } as any);
    expect(c.ownerEmails).toEqual(["me@x.com"]);
    expect(c.hevyApiKey).toBe("k");
    expect(c.stravaClientId).toBeUndefined();
  });
});

describe("HevyClient.updateRoutine", () => {
  it("keeps untouched exercises and PUTs the merged routine", async () => {
    const { HevyClient } = await import("../src/hevy/client");
    const calls: any[] = [];
    const routine = { id: "r1", title: "Push A", folder_id: 9, notes: null, exercises: [
      { exercise_template_id: "A", rest_seconds: 120, notes: "old", superset_id: null, sets: [{ type: "normal", weight_kg: 60, reps: null, rep_range: { start: 10, end: 12 } }] },
      { exercise_template_id: "B", rest_seconds: 90, notes: "keep", superset_id: null, sets: [{ type: "normal", weight_kg: 20, reps: 10 }] },
    ] };
    const fake: any = async (url: string, init?: any) => {
      calls.push({ url, init });
      if (!init?.method) return new Response(JSON.stringify({ page: 1, page_count: 1, routines: [routine] }));
      return new Response(JSON.stringify({ routine: [{ id: "r1", title: "Push A", exercises: [{}, {}] }] }));
    };
    const c = new HevyClient("k", fake);
    await c.updateRoutine("r1", { exercises: [{ exercise_template_id: "A", notes: "new", sets: [{ weight_kg: 50 }] }] });
    const put = calls.find((x) => x.init?.method === "PUT");
    const body = JSON.parse(put.init.body);
    expect(body.routine.folder_id).toBeUndefined();
    expect(body.routine.exercises[0].notes).toBe("new");
    expect(body.routine.exercises[0].sets[0]).toMatchObject({ weight_kg: 50, rep_range: { start: 10, end: 12 } });
    expect(body.routine.exercises[1].notes).toBe("keep");
  });
});
