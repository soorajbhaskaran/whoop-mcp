import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { runMigrations } from "./migrate.js";

const config = loadConfig(process.env);
if (config.restrictAccess && config.allowedWhoopEmails.length === 0) {
  console.warn("⚠️  RESTRICT_ACCESS is on but ALLOWED_WHOOP_EMAILS is empty — no one can connect.");
} else if (!config.restrictAccess && config.allowedWhoopEmails.length > 0) {
  console.warn("⚠️  ALLOWED_WHOOP_EMAILS is set but RESTRICT_ACCESS is not true — the server is still open to anyone.");
}
try {
  await runMigrations(config.databaseUrl);
} catch (e) {
  console.error("migration failed at startup:", e);
  process.exit(1);
}
const app = createApp(config);
app.listen(config.port, () => console.log(`listening on ${config.port}`));

// Sleep coach: tick in-process every 5 minutes too. An external cron hitting /sleep-coach/tick
// is still recommended on hosts that sleep when idle (e.g. Render free); events are deduplicated
// in the database, so both running at once is safe.
const coach = app.locals.sleepCoach as import("./sleep-coach/service.js").SleepCoach | undefined;
if (coach) {
  const tick = () => coach.tick().catch((e) => console.error("[sleep-coach] tick failed:", e));
  setInterval(tick, 5 * 60_000).unref();
  void tick();
  console.log("sleep coach enabled");
}
