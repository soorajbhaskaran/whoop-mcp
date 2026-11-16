import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { encrypt, decrypt } from "../crypto.js";
import { schema } from "../db/client.js";
import type { StravaTokenSet } from "./oauth.js";

type Db = NodePgDatabase<typeof schema>;
export type StravaRefreshFn = (refreshToken: string, scopes: string[]) => Promise<StravaTokenSet>;
const EXPIRY_SKEW_MS = 120_000;

export class StravaTokenStore {
  constructor(private db: Db, private keyHex: string, private refresh: StravaRefreshFn) {}

  async save(userId: string, t: StravaTokenSet): Promise<void> {
    const values = {
      athleteId: t.athleteId ?? "",
      accessTokenEnc: encrypt(t.accessToken, this.keyHex),
      refreshTokenEnc: encrypt(t.refreshToken, this.keyHex),
      accessTokenExpiresAt: t.expiresAt,
      scopes: t.scopes,
      updatedAt: new Date(),
    };
    await this.db.insert(schema.stravaTokens).values({ userId, ...values })
      .onConflictDoUpdate({ target: schema.stravaTokens.userId, set: values });
  }

  async status(userId: string): Promise<{ connected: boolean; athleteId?: string; scopes?: string[] }> {
    const [row] = await this.db.select().from(schema.stravaTokens).where(eq(schema.stravaTokens.userId, userId));
    return row ? { connected: true, athleteId: row.athleteId, scopes: row.scopes } : { connected: false };
  }

  async getAthleteId(userId: string): Promise<string> {
    const [row] = await this.db.select().from(schema.stravaTokens).where(eq(schema.stravaTokens.userId, userId));
    if (!row) throw new Error("Strava not connected");
    return row.athleteId;
  }

  async getValidAccessToken(userId: string, force = false): Promise<string> {
    const [row] = await this.db.select().from(schema.stravaTokens).where(eq(schema.stravaTokens.userId, userId));
    if (!row) throw new Error("Strava not connected");
    if (!force && row.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
      return decrypt(row.accessTokenEnc, this.keyHex);
    }
    const refreshed = await this.refresh(decrypt(row.refreshTokenEnc, this.keyHex), row.scopes);
    await this.db.update(schema.stravaTokens).set({
      accessTokenEnc: encrypt(refreshed.accessToken, this.keyHex),
      refreshTokenEnc: encrypt(refreshed.refreshToken, this.keyHex),
      accessTokenExpiresAt: refreshed.expiresAt,
      updatedAt: new Date(),
    }).where(eq(schema.stravaTokens.userId, userId));
    return refreshed.accessToken;
  }

  async disconnect(userId: string): Promise<void> {
    await this.db.delete(schema.stravaTokens).where(eq(schema.stravaTokens.userId, userId));
  }
}
