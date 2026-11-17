import { z } from "zod";

export interface AppConfig {
  databaseUrl: string; encryptionKey: string;
  whoopClientId: string; whoopClientSecret: string;
  publicBaseUrl: string; port: number;
  sessionSecret: string;
  // Access control: the allowlist only applies when restrictAccess is true.
  // restrictAccess=false (default) keeps the server open regardless of the list.
  restrictAccess: boolean;
  allowedWhoopEmails: string[];
  // Personal integrations (single owner). Hevy/Strava tools are only exposed to users whose
  // WHOOP email is listed in OWNER_EMAILS (falls back to ALLOWED_WHOOP_EMAILS).
  ownerEmails: string[];
  hevyApiKey?: string;
  stravaClientId?: string;
  stravaClientSecret?: string;
  // Sleep coach (optional): bedtime / wake-up announcements on Alexa via Voice Monkey.
  sleepCoach?: SleepCoachConfig;
}

export interface SleepCoachConfig {
  secret: string;
  ownerEmail: string;
  voiceMonkeyToken: string;
  devices: { speaker: string; windDownTrigger?: string; bedtimeTrigger?: string; morningTrigger?: string };
  timezone: string;
  wakeTime: string;
  weekendWakeTime?: string;
  windDownMinutes: number;
  name?: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function loadSleepCoach(env: NodeJS.ProcessEnv, ownerEmails: string[]): SleepCoachConfig | undefined {
  const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  const token = opt(env.VOICE_MONKEY_TOKEN);
  if (!token) return undefined;
  const need = (k: string) => {
    const v = opt(env[k]);
    if (!v) throw new Error(`${k} is required when VOICE_MONKEY_TOKEN is set`);
    return v;
  };
  const time = (k: string, fallback?: string) => {
    const v = opt(env[k]) ?? fallback;
    if (v !== undefined && !HHMM.test(v)) throw new Error(`${k} must be HH:MM (24h), got "${v}"`);
    return v;
  };
  const ownerEmail = (opt(env.SLEEP_COACH_OWNER_EMAIL) ?? ownerEmails[0])?.toLowerCase();
  if (!ownerEmail) throw new Error("SLEEP_COACH_OWNER_EMAIL (or OWNER_EMAILS) is required when VOICE_MONKEY_TOKEN is set");
  const secret = need("SLEEP_COACH_SECRET");
  if (secret.length < 16) throw new Error("SLEEP_COACH_SECRET must be at least 16 characters");
  const tz = opt(env.SLEEP_COACH_TIMEZONE) ?? "Asia/Kolkata";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new Error(`SLEEP_COACH_TIMEZONE "${tz}" is not a valid IANA time zone`); }
  const windDown = Number(opt(env.SLEEP_COACH_WIND_DOWN_MINUTES) ?? "30");
  if (!Number.isInteger(windDown) || windDown < 0 || windDown > 180) throw new Error("SLEEP_COACH_WIND_DOWN_MINUTES must be 0-180");
  return {
    secret, ownerEmail, voiceMonkeyToken: token,
    devices: {
      speaker: need("VOICE_MONKEY_SPEAKER"),
      windDownTrigger: opt(env.VOICE_MONKEY_WIND_DOWN_TRIGGER),
      bedtimeTrigger: opt(env.VOICE_MONKEY_BEDTIME_TRIGGER),
      morningTrigger: opt(env.VOICE_MONKEY_MORNING_TRIGGER),
    },
    timezone: tz,
    wakeTime: time("SLEEP_COACH_WAKE_TIME", "06:30")!,
    weekendWakeTime: time("SLEEP_COACH_WEEKEND_WAKE_TIME"),
    windDownMinutes: windDown,
    name: opt(env.SLEEP_COACH_NAME),
  };
}

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 32-byte hex"),
  WHOOP_CLIENT_ID: z.string().min(1),
  WHOOP_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  PORT: z.string().regex(/^\d+$/).default("8080"),
  SESSION_SECRET: z.string().min(16),
});

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  // `||` (not `??`) so an empty-string PUBLIC_BASE_URL is treated as unset and
  // still falls back to RAILWAY_PUBLIC_DOMAIN — otherwise a blank env var would
  // skip the fallback and fail URL validation, crashing startup.
  const publicBaseUrl =
    env.PUBLIC_BASE_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
  const p = Schema.parse({ ...env, PUBLIC_BASE_URL: publicBaseUrl });
  const allowedWhoopEmails = (env.ALLOWED_WHOOP_EMAILS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const restrictAccess = /^(true|1|yes|on)$/i.test((env.RESTRICT_ACCESS ?? "").trim());
  const ownerEmailsRaw = (env.OWNER_EMAILS ?? "").trim() ? env.OWNER_EMAILS! : (env.ALLOWED_WHOOP_EMAILS ?? "");
  const ownerEmails = ownerEmailsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    databaseUrl: p.DATABASE_URL, encryptionKey: p.ENCRYPTION_KEY,
    whoopClientId: p.WHOOP_CLIENT_ID, whoopClientSecret: p.WHOOP_CLIENT_SECRET,
    publicBaseUrl: p.PUBLIC_BASE_URL, port: Number(p.PORT),
    sessionSecret: p.SESSION_SECRET, restrictAccess, allowedWhoopEmails,
    ownerEmails,
    hevyApiKey: opt(env.HEVY_API_KEY),
    stravaClientId: opt(env.STRAVA_CLIENT_ID),
    stravaClientSecret: opt(env.STRAVA_CLIENT_SECRET),
    sleepCoach: loadSleepCoach(env, ownerEmails),
  };
}
