"use node";

import {
  instagramOAuth,
  linkedinOAuth,
  refreshOAuthToken,
  tiktokOAuth,
  xOAuth,
  youtubeOAuth,
  type OAuthTokenSet,
} from "@opencoredev/social-sdk/server";
import type { Platform } from "../../shared/platforms";
import type { PlatformCredential } from "./client";

/**
 * Each platform's registered developer app. These live only on the Convex
 * deployment; the phone never sees them. The user signs in with OAuth.
 */
const ENV: Record<Platform, { id: string; secret: string; scopes?: string }> = {
  youtube: { id: "YOUTUBE_CLIENT_ID", secret: "YOUTUBE_CLIENT_SECRET" },
  instagram: { id: "INSTAGRAM_CLIENT_ID", secret: "INSTAGRAM_CLIENT_SECRET" },
  tiktok: { id: "TIKTOK_CLIENT_KEY", secret: "TIKTOK_CLIENT_SECRET" },
  x: { id: "X_CLIENT_ID", secret: "X_CLIENT_SECRET" },
  linkedin: { id: "LINKEDIN_CLIENT_ID", secret: "LINKEDIN_CLIENT_SECRET", scopes: "LINKEDIN_SCOPES" },
  facebook: { id: "FACEBOOK_APP_ID", secret: "FACEBOOK_APP_SECRET", scopes: "FACEBOOK_SCOPES" },
};

/**
 * Scopes for stats, comments and posting. LinkedIn's comment and analytics scopes need
 * Community Management approval. `media.write` lets X posts carry images. YouTube uploads ride on
 * youtube.force-ssl; TikTok posts go to the creator's inbox (video.upload), which needs no app audit.
 */
const SCOPES: Record<Platform, readonly string[]> = {
  youtube: [
    "openid",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ],
  instagram: [
    "instagram_business_basic",
    "instagram_business_manage_insights",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
  ],
  tiktok: ["user.info.basic", "user.info.stats", "video.list", "video.upload"],
  x: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  linkedin: ["openid", "profile", "w_member_social"],
  // Facebook signs in through social/facebook.ts, which holds its own scope list.
  facebook: [],
};

export const LINKEDIN_API_VERSION = "202610";

export function appCredentials(platform: Platform): { clientId: string; clientSecret: string } | null {
  const env = ENV[platform];
  const clientId = process.env[env.id]?.trim();
  const clientSecret = process.env[env.secret]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function scopes(platform: Platform): readonly string[] {
  const override = ENV[platform].scopes ? process.env[ENV[platform].scopes!] : undefined;
  return override ? override.split(/[\s,]+/).filter(Boolean) : SCOPES[platform];
}

export function providerFor(
  platform: Platform,
  redirectUri: string,
  onToken: (accountId: string, displayName: string, token: OAuthTokenSet) => void,
) {
  const app = appCredentials(platform);
  if (platform === "facebook") throw new Error("Facebook signs in through its own flow.");
  if (app === null) throw new Error(`${platform} is not set up on the server yet.`);
  const options = {
    ...app,
    redirectUri,
    scopes: scopes(platform),
    linkedinApiVersion: LINKEDIN_API_VERSION,
    credentialSink: {
      async save(input: { account: { ref: { accountId: string }; displayName: string }; token: OAuthTokenSet }) {
        onToken(input.account.ref.accountId, input.account.displayName, input.token);
      },
    },
  };
  switch (platform) {
    case "youtube":
      return youtubeOAuth(options);
    case "instagram":
      return instagramOAuth(options);
    case "tiktok":
      return tiktokOAuth(options);
    case "x":
      return xOAuth(options);
    case "linkedin":
      return linkedinOAuth(options);
  }
}

export function toCredential(token: OAuthTokenSet): PlatformCredential {
  const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : undefined;
  return {
    accessToken: token.accessToken,
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
    ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(token.scopes ? { scopes: [...token.scopes] } : {}),
  };
}

/**
 * Returns a refreshed credential when the stored one is about to expire. Most platforms
 * refresh with a separate refresh token, so five minutes ahead is enough. Instagram extends
 * the access token itself and refuses once it has expired, so it refreshes a week ahead.
 */
export async function refreshIfNeeded(
  platform: Platform,
  credential: PlatformCredential,
): Promise<PlatformCredential | null> {
  // Facebook Page tokens taken from a long-lived user token never expire.
  if (platform === "facebook") return null;
  const ahead = platform === "instagram" ? 7 * 86_400_000 : 5 * 60_000;
  if (credential.expiresAt === undefined || credential.expiresAt - Date.now() > ahead) return null;
  const app = appCredentials(platform);
  if (app === null || (!credential.refreshToken && platform !== "instagram")) return null;
  const next = await refreshOAuthToken(platform, app, {
    accessToken: credential.accessToken,
    ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
    ...(credential.expiresAt ? { expiresAt: new Date(credential.expiresAt).toISOString() } : {}),
  });
  return { ...toCredential(next), refreshToken: next.refreshToken ?? credential.refreshToken };
}
