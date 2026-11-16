// Strava OAuth (https://developers.strava.com/docs/authentication/).
const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";
export const STRAVA_SCOPES = ["read", "activity:read_all", "profile:read_all"];

type FetchImpl = typeof fetch;
export type StravaCreds = { clientId: string; clientSecret: string };
export interface StravaTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  athleteId?: string;
  scopes: string[];
}

export function buildStravaAuthorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("approval_prompt", "auto");
  u.searchParams.set("scope", STRAVA_SCOPES.join(","));
  u.searchParams.set("state", p.state);
  return u.toString();
}

async function tokenRequest(body: Record<string, string>, fetchImpl: FetchImpl, scopes: string[]): Promise<StravaTokenSet> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Strava token endpoint ${res.status}`);
  const d: any = await res.json();
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: new Date(Number(d.expires_at) * 1000),
    athleteId: d.athlete?.id != null ? String(d.athlete.id) : undefined,
    scopes,
  };
}

export function exchangeStravaCode(code: string, creds: StravaCreds, grantedScope: string, fetchImpl: FetchImpl = fetch) {
  return tokenRequest(
    { client_id: creds.clientId, client_secret: creds.clientSecret, code, grant_type: "authorization_code" },
    fetchImpl,
    grantedScope.split(",").filter(Boolean),
  );
}

export function refreshStravaTokens(refreshToken: string, creds: StravaCreds, scopes: string[], fetchImpl: FetchImpl = fetch) {
  return tokenRequest(
    { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" },
    fetchImpl,
    scopes,
  );
}
