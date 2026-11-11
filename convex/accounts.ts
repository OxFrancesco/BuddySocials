import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { PLATFORMS } from "../shared/platforms";

const DEMO_PROFILES = {
  youtube: { handle: "@oddofrancesco", id: "UCdemo-oddofrancesco" },
  instagram: { handle: "oddofrancesco", id: "17841400000000000" },
  tiktok: { handle: "oddofrancesco", id: "demo-open-id" },
  x: { handle: "oddofrancesco", id: "1400000000000000000" },
  linkedin: { handle: "francesco-oddo", id: "urn:li:person:demo" },
} as const;

const MINUTE = 60_000;
/** An action can die without reporting back (timeout, redeploy). After this long its claim is void. */
export const SYNC_STALE_MS = 5 * MINUTE;

/**
 * Marks the account as syncing and starts the sync, unless one is already running.
 * Every sync starts here, so two never run for the same account and race on token refresh.
 */
async function claimSync(ctx: MutationCtx, account: Doc<"accounts">, backfill: boolean): Promise<boolean> {
  const now = Date.now();
  const running =
    account.status === "syncing" && account.syncStartedAt !== undefined && now - account.syncStartedAt < SYNC_STALE_MS;
  if (running) return false;
  await ctx.db.patch("accounts", account._id, { status: "syncing", syncStartedAt: now });
  await ctx.scheduler.runAfter(0, internal.sync.syncAccount, { accountId: account._id, backfill });
  return true;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return [];
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(20);
    return accounts.map((account) => ({
      _id: account._id,
      platform: account.platform,
      source: account.source,
      handle: account.handle,
      displayName: account.displayName,
      status: account.status,
      syncStartedAt: account.syncStartedAt ?? null,
      followers: account.followers ?? null,
      lastSyncedAt: account.lastSyncedAt ?? null,
      lastError: account.lastError ?? null,
      limited: account.limited ?? null,
      /** "page" for LinkedIn company Pages, so a reconnect goes through the Pages sign-in. */
      kind: account.app === "linkedinPages" ? ("page" as const) : ("profile" as const),
    }));
  },
});

/** Adds a demo account for every platform that has no account yet, then syncs them. */
export const loadDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const created: Id<"accounts">[] = [];
    for (const platform of PLATFORMS) {
      const existing = await ctx.db
        .query("accounts")
        .withIndex("by_owner_and_platform", (q) => q.eq("owner", owner).eq("platform", platform))
        .first();
      if (existing !== null) continue;
      const profile = DEMO_PROFILES[platform];
      const id = await ctx.db.insert("accounts", {
        owner,
        platform,
        source: "demo",
        platformAccountId: profile.id,
        handle: profile.handle,
        displayName: "Francesco Oddo",
        status: "syncing",
        syncStartedAt: Date.now(),
      });
      created.push(id);
      await ctx.scheduler.runAfter(0, internal.sync.syncAccount, { accountId: id, backfill: true });
    }
    return created.length;
  },
});

export const removeDemo = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(20);
    for (const account of accounts) {
      if (account.source !== "demo") continue;
      await ctx.db.delete("accounts", account._id);
      await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountData, { accountId: account._id });
    }
  },
});

export const syncNow = mutation({
  args: { accountId: v.optional(v.id("accounts")) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(20);
    for (const account of accounts) {
      if (args.accountId !== undefined && account._id !== args.accountId) continue;
      // A dead sign-in can't sync; only an explicit request for that account retries it.
      if (account.status === "reconnect" && args.accountId === undefined) continue;
      await claimSync(ctx, account, false);
    }
  },
});

/**
 * Runs every 30 minutes and syncs what is due. X is billed per read and a failing
 * account rarely recovers by itself, so both wait three hours between attempts.
 */
export const syncDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const accounts = await ctx.db.query("accounts").take(200);
    for (const account of accounts) {
      if (account.status === "reconnect") continue;
      const slow = (account.platform === "x" && account.source === "direct") || account.status === "error";
      const last = Math.max(account.lastAttemptAt ?? 0, account.lastSyncedAt ?? 0);
      if (now - last < (slow ? 180 : 50) * MINUTE) continue;
      await claimSync(ctx, account, false);
    }
  },
});

async function deleteBatch(ctx: MutationCtx, accountId: Id<"accounts">): Promise<boolean> {
  const BATCH = 200;
  const comments = await ctx.db
    .query("comments")
    .withIndex("by_account_and_platformCommentId", (q) => q.eq("accountId", accountId))
    .take(BATCH);
  for (const comment of comments) await ctx.db.delete("comments", comment._id);
  if (comments.length === BATCH) return true;

  const days = await ctx.db
    .query("dailyStats")
    .withIndex("by_account_and_day", (q) => q.eq("accountId", accountId))
    .take(BATCH);
  for (const day of days) await ctx.db.delete("dailyStats", day._id);
  if (days.length === BATCH) return true;

  const posts = await ctx.db
    .query("posts")
    .withIndex("by_account_and_platformPostId", (q) => q.eq("accountId", accountId))
    .take(20);
  for (const post of posts) {
    const snapshots = await ctx.db
      .query("postSnapshots")
      .withIndex("by_post_and_takenAt", (q) => q.eq("postId", post._id))
      .take(100);
    for (const snapshot of snapshots) await ctx.db.delete("postSnapshots", snapshot._id);
    if (snapshots.length < 100) await ctx.db.delete("posts", post._id);
  }
  if (posts.length > 0) return true;

  const credentials = await ctx.db
    .query("credentials")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(10);
  for (const credential of credentials) await ctx.db.delete("credentials", credential._id);
  return false;
}

export const purgeAccountData = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const more = await deleteBatch(ctx, args.accountId);
    if (more) await ctx.scheduler.runAfter(0, internal.accounts.purgeAccountData, args);
  },
});

export const getInternal = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return null;
    const credential = await ctx.db
      .query("credentials")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    return { account, sealed: credential === null ? null : { iv: credential.iv, ciphertext: credential.ciphertext } };
  },
});

export const finishSync = internalMutation({
  args: {
    accountId: v.id("accounts"),
    error: v.optional(v.string()),
    reconnect: v.optional(v.boolean()),
    followers: v.optional(v.number()),
    limited: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return;
    const now = Date.now();
    if (args.error !== undefined) {
      await ctx.db.patch("accounts", args.accountId, {
        status: args.reconnect ? "reconnect" : "error",
        lastError: args.error,
        lastAttemptAt: now,
        syncStartedAt: undefined,
      });
      return;
    }
    await ctx.db.patch("accounts", args.accountId, {
      status: "connected",
      lastSyncedAt: now,
      lastAttemptAt: now,
      syncStartedAt: undefined,
      lastError: undefined,
      limited: args.limited !== undefined && args.limited.length > 0 ? args.limited : undefined,
      ...(args.followers !== undefined ? { followers: args.followers } : {}),
    });
  },
});
