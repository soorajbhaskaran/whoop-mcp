import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import cookieSession from "cookie-session";
import { buildStravaAuthorizeUrl, exchangeStravaCode, STRAVA_SCOPES, type StravaCreds } from "./oauth.js";
import type { StravaTokenStore } from "./token-store.js";

export interface StravaRouteDeps {
  creds: StravaCreds;
  store: StravaTokenStore;
  sessionSecret: string;
  publicBaseUrl: string;
  isOwner: (userId: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

// Mounted at /dashboard/strava. Shares the dashboard's signed session cookie, so the user must
// first sign in to the dashboard with WHOOP; only owners may link Strava.
export function createStravaRouter(deps: StravaRouteDeps): Router {
  const router = Router();
  router.use(cookieSession({
    name: "whoop_dashboard_session",
    secret: deps.sessionSecret,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  }));
  const redirectUri = `${deps.publicBaseUrl}/dashboard/strava/callback`;

  const requireOwner = async (req: Request, res: Response): Promise<string | undefined> => {
    const userId = req.session?.userId as string | undefined;
    if (!userId) {
      res.status(401).type("html").send(
        `<p>Sign in first: <a href="/dashboard/connect">connect WHOOP on the dashboard</a>, then open <a href="/dashboard/strava/connect">/dashboard/strava/connect</a> again.</p>`);
      return undefined;
    }
    if (!(await deps.isOwner(userId))) {
      res.status(403).send("Strava linking is only available to this server's owner.");
      return undefined;
    }
    return userId;
  };

  router.get("/connect", async (req, res) => {
    const userId = await requireOwner(req, res);
    if (!userId) return;
    const state = randomBytes(24).toString("base64url");
    req.session!.stravaState = state;
    res.redirect(302, buildStravaAuthorizeUrl({ clientId: deps.creds.clientId, redirectUri, state }));
  });

  router.get("/callback", async (req, res) => {
    const userId = await requireOwner(req, res);
    if (!userId) return;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const expected = req.session?.stravaState as string | undefined;
    req.session!.stravaState = undefined;
    if (!state || !expected || state !== expected) {
      res.status(403).send("Invalid or missing state.");
      return;
    }
    if (typeof req.query.error === "string") {
      res.status(400).send("Strava authorization was cancelled.");
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const granted = typeof req.query.scope === "string" ? req.query.scope : "";
    if (!code) {
      res.status(400).send("Missing authorization code.");
      return;
    }
    if (!granted.split(",").includes("activity:read_all") && !granted.split(",").includes("activity:read")) {
      res.status(400).send(`Please allow activity access on the Strava screen (needed scopes: ${STRAVA_SCOPES.join(", ")}). Try /dashboard/strava/connect again.`);
      return;
    }
    try {
      const tokens = await exchangeStravaCode(code, deps.creds, granted, deps.fetchImpl);
      await deps.store.save(userId, tokens);
      res.type("html").send("<h2>Strava connected ✅</h2><p>You can close this tab and go back to Claude.</p>");
    } catch {
      res.status(502).send("Strava connection failed, please try again.");
    }
  });

  router.get("/status", async (req, res) => {
    const userId = await requireOwner(req, res);
    if (!userId) return;
    res.json(await deps.store.status(userId));
  });

  router.post("/disconnect", async (req, res) => {
    const userId = await requireOwner(req, res);
    if (!userId) return;
    await deps.store.disconnect(userId);
    res.json({ ok: true });
  });

  return router;
}
