import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { platformValidator } from "./validators";
import { PLATFORMS, type Platform } from "../shared/platforms";

const ATTEMPT_TTL = 10 * 60_000;

const APP_ENV: Record<Platform, [string, string]> = {
  youtube: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
  instagram: ["INSTAGRAM_CLIENT_ID", "INSTAGRAM_CLIENT_SECRET"],
  tiktok: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"],
  x: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
  linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
};

/** Which platforms have a developer app configured on the server, so Connect can be offered. */
export const availability = query({
  args: {},
  handler: async (ctx) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    return Object.fromEntries(
      PLATFORMS.map((platform) => {
        const [id, secret] = APP_ENV[platform];
        return [platform, Boolean(process.env[id]?.trim() && process.env[secret]?.trim())];
      }),
    ) as Record<Platform, boolean>;
  },
});

export const saveAttempt = internalMutation({
  args: {
    owner: v.string(),
    platform: platformValidator,
    state: v.string(),
    codeVerifier: v.string(),
    providerState: v.optional(v.string()),
    redirectUri: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("connectAttempts", { ...args, createdAt: Date.now() });
  },
});

/** Returns and deletes the attempt so a callback can only be used once. */
export const takeAttempt = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("connectAttempts")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (attempt === null) return null;
    await ctx.db.delete("connectAttempts", attempt._id);
    if (Date.now() - attempt.createdAt > ATTEMPT_TTL) return null;
    return attempt;
  },
});

export const storeConnection = internalMutation({
  args: {
    owner: v.string(),
    platform: platformValidator,
    platformAccountId: v.string(),
    displayName: v.string(),
    handle: v.string(),
    sealed: v.object({ keyId: v.string(), iv: v.string(), ciphertext: v.string() }),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_owner_and_platform", (q) => q.eq("owner", args.owner).eq("platform", args.platform))
      .take(20);
    const match = existing.find(
      (account) => account.source === "direct" && account.platformAccountId === args.platformAccountId,
    );
    let accountId = match?._id;
    // A real account replaces the demo one for the same platform.
    for (const account of existing) {
      if (account.source !== "demo") continue;
      await ctx.db.delete("accounts", account._id);
      await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountData, { accountId: account._id });
    }
    if (accountId === undefined) {
      accountId = await ctx.db.insert("accounts", {
        owner: args.owner,
        platform: args.platform,
        source: "direct",
        platformAccountId: args.platformAccountId,
        handle: args.handle,
        displayName: args.displayName,
        status: "syncing",
      });
    } else {
      await ctx.db.patch("accounts", accountId, { status: "syncing", lastError: undefined, displayName: args.displayName });
    }
    const credential = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    const fields = { ...args.sealed, updatedAt: Date.now(), ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) };
    if (credential === null) await ctx.db.insert("credentials", { accountId, ...fields });
    else await ctx.db.replace("credentials", credential._id, { accountId, ...fields });
    await ctx.scheduler.runAfter(0, internal.sync.syncAccount, { accountId, backfill: true });
    return { accountId, existing: match !== undefined };
  },
});

export const replaceCredential = internalMutation({
  args: {
    accountId: v.id("accounts"),
    sealed: v.object({ keyId: v.string(), iv: v.string(), ciphertext: v.string() }),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const credential = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (credential === null) return;
    await ctx.db.replace("credentials", credential._id, {
      accountId: args.accountId,
      ...args.sealed,
      updatedAt: Date.now(),
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
    });
  },
});

export const disconnect = mutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null || account.owner !== owner) throw new Error("Account not found.");
    await ctx.db.delete("accounts", account._id);
    await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountData, { accountId: account._id });
  },
});

export const setPlatformAccountId = internalMutation({
  args: { accountId: v.id("accounts"), platformAccountId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch("accounts", args.accountId, { platformAccountId: args.platformAccountId, status: "syncing", lastError: undefined });
  },
});
