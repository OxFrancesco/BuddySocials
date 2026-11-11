"use node";

import type { PlatformCredential } from "./client";
import { LINKEDIN_API_VERSION } from "./oauth";

/**
 * Sign-in for LinkedIn company Pages. LinkedIn only grants the Community Management API
 * to an app that has no other product, so Pages use their own developer app
 * (LINKEDIN_PAGES_CLIENT_ID / _SECRET). That app can't have "Sign In with LinkedIn",
 * so there is no /userinfo to call: the Pages a member administers come from
 * organizationAcls instead.
 */

const SCOPES = ["rw_organization_admin", "w_organization_social", "r_organization_social"];

/** Roles that may post as the Page. */
const POSTING_ROLES = new Set(["ADMINISTRATOR", "CONTENT_ADMINISTRATOR"]);

export function pagesApp(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.LINKEDIN_PAGES_CLIENT_ID?.trim();
  const clientSecret = process.env.LINKEDIN_PAGES_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function requireApp() {
  const app = pagesApp();
  if (app === null) throw new Error("LinkedIn Pages are not set up on the server yet.");
  return app;
}

function scopes(): string[] {
  const override = process.env.LINKEDIN_PAGES_SCOPES;
  return override ? override.split(/[\s,]+/).filter(Boolean) : SCOPES;
}

export function authorizationUrl(state: string, redirectUri: string): string {
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", requireApp().clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scopes().join(" "));
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<PlatformCredential> {
  const app = requireApp();
  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: app.clientId, client_secret: app.clientSecret }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(`LinkedIn did not issue a token: ${String(data.error_description ?? data.error ?? response.status)}`);
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
    ...(expiresIn !== undefined ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
    ...(typeof data.scope === "string" ? { scopes: data.scope.split(/[\s,]+/).filter(Boolean) } : {}),
  };
}

export async function exchangeCode(callbackUrl: string, redirectUri: string): Promise<PlatformCredential> {
  const params = new URL(callbackUrl).searchParams;
  const error = params.get("error");
  if (error) throw new Error(params.get("error_description") ?? error);
  const code = params.get("code");
  if (!code) throw new Error("LinkedIn sent no authorization code.");
  return await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export async function refreshPagesToken(credential: PlatformCredential): Promise<PlatformCredential | null> {
  if (!credential.refreshToken) return null;
  const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refreshToken });
  return { ...next, refreshToken: next.refreshToken ?? credential.refreshToken };
}

async function api(path: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.linkedin.com${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "LinkedIn-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (!response.ok) throw new Error(`LinkedIn ${path.split("?")[0]} answered ${response.status}.`);
  return (await response.json()) as Record<string, unknown>;
}

export type LinkedInPage = { urn: `urn:li:organization:${string}`; name: string; handle: string };

/** Every Page the signed-in member may post as, with its name. */
export async function administeredPages(accessToken: string): Promise<LinkedInPage[]> {
  const ids = new Set<string>();
  for (let start = 0; start < 1000; start += 100) {
    const page = await api(`/rest/organizationAcls?q=roleAssignee&state=APPROVED&start=${start}&count=100`, accessToken);
    const elements = Array.isArray(page.elements) ? (page.elements as Record<string, unknown>[]) : [];
    for (const row of elements) {
      const target = row.organization ?? row.organizationTarget;
      if (typeof target !== "string" || typeof row.role !== "string" || !POSTING_ROLES.has(row.role)) continue;
      const match = /^urn:li:organization:(\d+)$/.exec(target);
      if (match) ids.add(match[1]!);
    }
    if (elements.length < 100) break;
  }
  return await Promise.all(
    [...ids].map(async (id): Promise<LinkedInPage> => {
      const org = await api(`/rest/organizations/${id}`, accessToken).catch(() => ({}) as Record<string, unknown>);
      const name = typeof org.localizedName === "string" && org.localizedName ? org.localizedName : `LinkedIn Page ${id}`;
      const handle = typeof org.vanityName === "string" && org.vanityName ? org.vanityName : name;
      return { urn: `urn:li:organization:${id}`, name, handle };
    }),
  );
}
