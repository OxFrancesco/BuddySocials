"use node";

import { createHash, randomBytes } from "node:crypto";
import type { OAuthTokenSet } from "@opencoredev/social-sdk/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { requireOwner } from "./lib/owner";
import { sealCredential } from "./social/client";
import { providerFor, toCredential } from "./social/oauth";
import { platformValidator } from "./validators";

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function callbackUri(): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is missing.");
  return `${site}/oauth/callback`;
}

/** Starts the platform's OAuth consent flow and returns the URL the phone opens. */
export const begin = action({
  args: { platform: platformValidator },
  handler: async (ctx, args): Promise<string> => {
    const owner = await requireOwner(ctx);
    const redirectUri = callbackUri();
    const state = base64url(randomBytes(24));
    const codeVerifier = base64url(randomBytes(48));
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
    const provider = providerFor(args.platform, redirectUri, () => {});
    const started = await provider.start({
      platforms: [args.platform],
      capabilities: [],
      redirectUri,
      state,
      codeChallenge,
    });
    await ctx.runMutation(internal.connectStore.saveAttempt, {
      owner,
      platform: args.platform,
      state,
      codeVerifier,
      redirectUri,
      ...(started.providerState ? { providerState: started.providerState } : {}),
    });
    return started.authorizationUrl;
  },
});

/** Runs from the HTTP callback: exchanges the code, seals the token, creates the account. */
export const complete = internalAction({
  args: { state: v.string(), callbackUrl: v.string() },
  handler: async (ctx, args): Promise<{ platform: string } | { error: string }> => {
    const attempt = await ctx.runMutation(internal.connectStore.takeAttempt, { state: args.state });
    if (attempt === null) return { error: "That sign-in link expired. Try connecting again." };
    const tokens: { accountId: string; displayName: string; token: OAuthTokenSet }[] = [];
    try {
      const provider = providerFor(attempt.platform, attempt.redirectUri, (accountId, displayName, token) => {
        tokens.push({ accountId, displayName, token });
      });
      const now = new Date();
      const accounts = await provider.complete({
        callbackUrl: args.callbackUrl,
        attempt: {
          id: attempt._id,
          backend: "default",
          tenantId: attempt.owner,
          principalId: attempt.owner,
          platforms: [attempt.platform],
          capabilities: [],
          redirectUri: attempt.redirectUri,
          state: attempt.state,
          codeVerifier: attempt.codeVerifier,
          ...(attempt.providerState ? { providerState: attempt.providerState } : {}),
          createdAt: new Date(attempt.createdAt).toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      });
      if (tokens.length === 0 || accounts.length === 0) return { error: "No account came back from the platform." };
      for (const entry of tokens) {
        const credential = toCredential(entry.token);
        await ctx.runMutation(internal.connectStore.storeConnection, {
          owner: attempt.owner,
          platform: attempt.platform,
          platformAccountId: entry.accountId,
          displayName: entry.displayName,
          handle: entry.displayName,
          sealed: sealCredential(credential),
          ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        });
      }
      return { platform: attempt.platform };
    } catch (error) {
      console.error("OAuth completion failed", attempt.platform, error);
      return { error: "The platform did not accept the sign-in. Try again." };
    }
  },
});
