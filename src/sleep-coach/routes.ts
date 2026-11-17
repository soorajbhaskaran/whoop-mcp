import { timingSafeEqual } from "node:crypto";
import express from "express";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { schema } from "../db/client.js";
import type { TokenStore } from "../auth/token-store.js";
import { WhoopClient } from "../whoop/client.js";
import { DEFAULT_SETTINGS } from "./planner.js";
import { SleepCoach, type FiredStore } from "./service.js";
import { VoiceMonkey } from "./voice-monkey.js";
import type { SleepCoachConfig } from "../config.js";

type Db = NodePgDatabase<typeof schema>;

export class DbFiredStore implements FiredStore {
  constructor(private db: Db) {}
  async claim(key: string): Promise<boolean> {
    const rows = await this.db.insert(schema.sleepCoachEvents).values({ eventKey: key })
      .onConflictDoNothing().returning();
    return rows.length > 0;
  }
  async release(key: string): Promise<void> {
    await this.db.delete(schema.sleepCoachEvents).where(eq(schema.sleepCoachEvents.eventKey, key));
  }
}

export function createSleepCoach(cfg: SleepCoachConfig, db: Db, tokenStore: TokenStore): SleepCoach {
  // The coach runs for one person: the WHOOP account whose email is cfg.ownerEmail.
  let userId: string | undefined;
  const ownerUserId = async () => {
    if (userId) return userId;
    const [u] = await db.select().from(schema.users).where(sql`lower(${schema.users.email}) = ${cfg.ownerEmail}`);
    if (!u) throw new Error(`no connected WHOOP user with email ${cfg.ownerEmail}`);
    return (userId = u.id);
  };
  return new SleepCoach({
    settings: {
      ...DEFAULT_SETTINGS,
      tz: cfg.timezone,
      wakeTime: cfg.wakeTime,
      weekendWakeTime: cfg.weekendWakeTime,
      windDownMinutes: cfg.windDownMinutes,
    },
    devices: cfg.devices,
    name: cfg.name,
    voice: new VoiceMonkey(cfg.voiceMonkeyToken),
    store: new DbFiredStore(db),
    whoop: async () => {
      const uid = await ownerUserId();
      return new WhoopClient(() => tokenStore.getValidAccessToken(uid), () => tokenStore.forceRefreshAccessToken(uid));
    },
  });
}

function secretMatches(given: unknown, secret: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * /sleep-coach/tick        — call every 5 minutes (cron-job.org, Render cron, ...). Fires due events.
 * /sleep-coach/plan        — tonight's bedtime / wake-up, for checking the numbers.
 * /sleep-coach/test/:kind  — fire wind_down | bedtime | wake right now, to test the Alexa side.
 * All require the secret as `Authorization: Bearer <secret>` or `?key=<secret>`.
 */
export function createSleepCoachRouter(coach: SleepCoach, secret: string, tz: string): express.Router {
  const r = express.Router();
  r.use((req, res, next) => {
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (secretMatches(header, secret) || secretMatches(req.query.key, secret)) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  r.all("/tick", async (_req, res) => {
    try {
      res.json(await coach.tick());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  r.get("/plan", async (_req, res) => {
    try {
      const p = await coach.plan();
      const fmt = (d: Date) => d.toLocaleString("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
      res.json({
        windDown: fmt(p.windDownAt), bedtime: fmt(p.bedtimeAt), wakeUp: fmt(p.wakeAt),
        sleepNeedHours: +(p.need.needMs / 3_600_000).toFixed(2), source: p.need.source,
        carryoverMinutes: p.need.carryoverMs != null ? Math.round(p.need.carryoverMs / 60_000) : undefined,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  r.all("/test/:kind", async (req, res) => {
    const kind = req.params.kind;
    if (kind !== "wind_down" && kind !== "bedtime" && kind !== "wake") {
      res.status(400).json({ error: "kind must be wind_down, bedtime or wake" });
      return;
    }
    try {
      res.json({ spoke: await coach.run(kind) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return r;
}
