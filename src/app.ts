import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { getDb } from "./db/client.js";
import { TokenStore } from "./auth/token-store.js";
import { EnvCredentialProvider } from "./whoop/credentials.js";
import { refreshWhoopTokens } from "./whoop/oauth.js";
import { WhoopOAuthProvider } from "./auth/oauth-provider.js";
import { createWhoopCallbackRouter } from "./auth/whoop-callback.js";
import { createDashboardRouter } from "./dashboard/routes.js";
import { buildMcpServer } from "./mcp/server.js";
import { eq } from "drizzle-orm";
import { schema } from "./db/client.js";
import { HevyClient } from "./hevy/client.js";
import { StravaClient } from "./strava/client.js";
import { StravaTokenStore } from "./strava/token-store.js";
import { refreshStravaTokens } from "./strava/oauth.js";
import { createStravaRouter } from "./strava/routes.js";
import type { PersonalDeps } from "./mcp/personal-tools.js";
import { createSleepCoach, createSleepCoachRouter } from "./sleep-coach/routes.js";

export function createApp(config: AppConfig): express.Express {
  const app = express();
  app.use(express.json());
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  const db = getDb(config.databaseUrl);
  const credentials = new EnvCredentialProvider(config.whoopClientId, config.whoopClientSecret);
  const creds = { clientId: config.whoopClientId, clientSecret: config.whoopClientSecret };
  const tokenStore = new TokenStore(db, config.encryptionKey, (rt) => refreshWhoopTokens(rt, creds));
  const provider = new WhoopOAuthProvider({ tokenStore, credentials, db, publicBaseUrl: config.publicBaseUrl });

  // Personal integrations (Hevy, Strava) — owner-only, see personal-tools.ts.
  const ownerCache = new Map<string, { owner: boolean; at: number }>();
  const isOwner = async (userId: string): Promise<boolean> => {
    if (!userId || config.ownerEmails.length === 0) return false;
    const hit = ownerCache.get(userId);
    if (hit && Date.now() - hit.at < 300_000) return hit.owner;
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const owner = !!u?.email && config.ownerEmails.includes(u.email.toLowerCase());
    ownerCache.set(userId, { owner, at: Date.now() });
    return owner;
  };
  const stravaCreds = config.stravaClientId && config.stravaClientSecret
    ? { clientId: config.stravaClientId, clientSecret: config.stravaClientSecret } : undefined;
  const stravaStore = stravaCreds
    ? new StravaTokenStore(db, config.encryptionKey, (rt, scopes) => refreshStravaTokens(rt, stravaCreds, scopes))
    : undefined;
  const personal: PersonalDeps = {
    isOwner,
    hevy: config.hevyApiKey ? new HevyClient(config.hevyApiKey) : undefined,
    stravaFor: stravaStore ? (userId) => new StravaClient((force) => stravaStore.getValidAccessToken(userId, force)) : undefined,
    stravaAthleteId: stravaStore ? (userId) => stravaStore.getAthleteId(userId) : undefined,
    stravaConnectUrl: `${config.publicBaseUrl}/dashboard/strava/connect`,
  };

  const issuerUrl = new URL(config.publicBaseUrl);
  app.use(mcpAuthRouter({ provider, issuerUrl, baseUrl: issuerUrl, scopesSupported: ["mcp"] }));
  app.use(createWhoopCallbackRouter({ db, tokenStore, credentials, publicBaseUrl: config.publicBaseUrl, restrictAccess: config.restrictAccess, allowedWhoopEmails: config.allowedWhoopEmails }));
  if (stravaCreds && stravaStore) {
    app.use("/dashboard/strava", createStravaRouter({
      creds: stravaCreds, store: stravaStore, sessionSecret: config.sessionSecret,
      publicBaseUrl: config.publicBaseUrl, isOwner,
    }));
  }
  if (config.sleepCoach) {
    const coach = createSleepCoach(config.sleepCoach, db, tokenStore);
    app.locals.sleepCoach = coach;
    app.use("/sleep-coach", createSleepCoachRouter(coach, config.sleepCoach.secret, config.sleepCoach.timezone));
  }
  app.use("/dashboard", createDashboardRouter({ provider, tokenStore, sessionSecret: config.sessionSecret }));

  const auth = requireBearerAuth({ verifier: provider, requiredScopes: ["mcp"] });
  app.all("/mcp", auth, async (req, res) => {
    try {
      const mcpServer = buildMcpServer({ tokenStore, credentials, personal });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  return app;
}
