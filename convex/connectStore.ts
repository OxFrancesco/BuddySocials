import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query, internalQuery } from "./_generated/server";
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
  facebook: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
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

/**
 * Whether "Add a LinkedIn Page" can be offered. Besides its keys, the Pages app needs LinkedIn to
 * approve the Community Management API; until then LinkedIn refuses the sign-in, so the button
 * stays hidden until LINKEDIN_PAGES_ENABLED is set.
 */
export const pagesAvailable = query({
  args: {},
  handler: async (ctx) => {
    if ((await optionalOwner(ctx)) === null) return false;
    return Boolean(
      process.env.LINKEDIN_PAGES_ENABLED?.trim() &&
        process.env.LINKEDIN_PAGES_CLIENT_ID?.trim() &&
        process.env.LINKEDIN_PAGES_CLIENT_SECRET?.trim(),
    );
  },
});

const appValidator = v.optional(v.literal("linkedinPages"));

export const saveAttempt = internalMutation({
  args: {
    owner: v.string(),
    platform: platformValidator,
    state: v.string(),
    codeVerifier: v.string(),
    providerState: v.optional(v.string()),
    redirectUri: v.string(),
    client: v.optional(v.literal("desktop")),
    ownerLabel: v.optional(v.string()),
    app: appValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("connectAttempts", { ...args, createdAt: Date.now() });
  },
});

/** What the confirm page shows before the code is exchanged; null when the link is unknown or stale. */
export const peekAttempt = internalQuery({
  args: { state: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("connectAttempts")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (attempt === null || args.now - attempt.createdAt > ATTEMPT_TTL) return null;
    return { platform: attempt.platform, ownerLabel: attempt.ownerLabel ?? null, desktop: attempt.client === "desktop" };
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
    scopes: v.optional(v.array(v.string())),
    app: appValidator,
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
        syncStartedAt: Date.now(),
        ...(args.scopes ? { scopes: args.scopes } : {}),
        ...(args.app ? { app: args.app } : {}),
      });
    } else {
      await ctx.db.patch("accounts", accountId, { status: "syncing", syncStartedAt: Date.now(), lastError: undefined, displayName: args.displayName, ...(args.scopes ? { scopes: args.scopes } : {}) });
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
    await ctx.db.patch("accounts", args.accountId, { platformAccountId: args.platformAccountId, status: "syncing", syncStartedAt: Date.now(), lastError: undefined });
  },
});
