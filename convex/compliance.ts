import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { requireOwner } from "./lib/owner";

/** Which BuddySocials platforms each Meta app signs requests for. */
const META_PLATFORMS: Record<MetaSource, readonly string[]> = {
  instagram: ["instagram"],
  facebook: ["facebook"],
};
export type MetaSource = "instagram" | "facebook";
const metaSourceValidator = v.union(v.literal("instagram"), v.literal("facebook"));

/**
 * Accounts connected through this Meta app for this person. Meta sends only the app-scoped user ID,
 * so this looks it up in metaUsers, and also matches accounts stored under that same ID.
 */
async function metaAccounts(ctx: MutationCtx, source: MetaSource, userId: string): Promise<Doc<"accounts">[]> {
  const platforms = META_PLATFORMS[source];
  const found = new Map<Id<"accounts">, Doc<"accounts">>();
  const links = await ctx.db
    .query("metaUsers")
    .withIndex("by_source_and_metaUserId", (q) => q.eq("source", source).eq("metaUserId", userId))
    .take(100);
  for (const link of links) {
    const account = await ctx.db.get("accounts", link.accountId);
    if (account !== null) found.set(account._id, account);
  }
  // Accounts have no index on platformAccountId; the table holds a few rows per user.
  for await (const account of ctx.db.query("accounts")) {
    if (account.source === "direct" && account.platformAccountId === userId && platforms.includes(account.platform)) {
      found.set(account._id, account);
    }
  }
  return [...found.values()];
}

/**
 * Records which Meta user an account belongs to. Facebook sign-in should call this with the
 * user token's /me ID; Instagram accounts are filled in by complianceNode.linkInstagramAccounts.
 */
export const linkMetaUser = internalMutation({
  args: { accountId: v.id("accounts"), source: metaSourceValidator, metaUserId: v.string() },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return null;
    const existing = await ctx.db
      .query("metaUsers")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .take(10);
    if (existing.some((link) => link.source === args.source && link.metaUserId === args.metaUserId)) return null;
    for (const link of existing) await ctx.db.delete("metaUsers", link._id);
    await ctx.db.insert("metaUsers", { owner: account.owner, accountId: args.accountId, source: args.source, metaUserId: args.metaUserId });
    return null;
  },
});

/** Instagram accounts with a token and no Meta user recorded yet. */
export const unlinkedInstagram = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").take(500);
    const out: { accountId: Id<"accounts">; sealed: { iv: string; ciphertext: string } }[] = [];
    for (const account of accounts) {
      if (account.platform !== "instagram" || account.source !== "direct" || account.status === "reconnect") continue;
      const link = await ctx.db
        .query("metaUsers")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .first();
      if (link !== null) continue;
      const credential = await ctx.db
        .query("credentials")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .first();
      if (credential !== null) out.push({ accountId: account._id, sealed: { iv: credential.iv, ciphertext: credential.ciphertext } });
      if (out.length >= 25) break;
    }
    return out;
  },
});

function newCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deletes one batch of an account's synced data, then the account itself.
 * Returns true while anything is left.
 */
async function purgeAccountBatch(ctx: MutationCtx, accountId: Id<"accounts">): Promise<boolean> {
  const BATCH = 200;
  const credentials = await ctx.db
    .query("credentials")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(10);
  for (const credential of credentials) await ctx.db.delete("credentials", credential._id);

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
  for (const post of posts) await deletePost(ctx, post._id);
  if (posts.length > 0) return true;

  const links = await ctx.db
    .query("metaUsers")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .take(10);
  for (const link of links) await ctx.db.delete("metaUsers", link._id);
  if ((await ctx.db.get("accounts", accountId)) !== null) await ctx.db.delete("accounts", accountId);
  return false;
}

/** Deletes a post once its snapshots are gone; a post with many snapshots takes several batches. */
async function deletePost(ctx: MutationCtx, postId: Id<"posts">) {
  const snapshots = await ctx.db
    .query("postSnapshots")
    .withIndex("by_post_and_takenAt", (q) => q.eq("postId", postId))
    .take(100);
  for (const snapshot of snapshots) await ctx.db.delete("postSnapshots", snapshot._id);
  if (snapshots.length < 100) await ctx.db.delete("posts", postId);
}

async function deleteFile(ctx: MutationCtx, storageId: Id<"_storage">) {
  const upload = await ctx.db
    .query("uploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .first();
  if (upload !== null) await ctx.db.delete("uploads", upload._id);
  if ((await ctx.db.system.get("_storage", storageId)) !== null) await ctx.storage.delete(storageId);
}

/** Purges the listed accounts one batch at a time, then marks the deletion request done. */
export const purgeAccounts = internalMutation({
  args: { accountIds: v.array(v.id("accounts")), requestId: v.optional(v.id("deletionRequests")) },
  handler: async (ctx, args) => {
    const [accountId, ...rest] = args.accountIds;
    if (accountId !== undefined) {
      const more = await purgeAccountBatch(ctx, accountId);
      await ctx.scheduler.runAfter(0, internal.compliance.purgeAccounts, { ...args, accountIds: more ? args.accountIds : rest });
      return null;
    }
    if (args.requestId !== undefined) {
      await ctx.db.patch("deletionRequests", args.requestId, { state: "done", doneAt: Date.now() });
    }
    return null;
  },
});

/** Meta's data deletion callback: removes the person's accounts, tokens and synced data. */
export const metaDeletion = internalMutation({
  args: { source: metaSourceValidator, userId: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const accounts = await metaAccounts(ctx, args.source, args.userId);
    const code = newCode();
    const requestId = await ctx.db.insert("deletionRequests", {
      code,
      source: args.source,
      state: "pending",
      accountsFound: accounts.length,
      requestedAt: Date.now(),
    });
    // Stop syncs and posting right away; the rows go in the batches that follow.
    for (const account of accounts) {
      await ctx.db.patch("accounts", account._id, { status: "reconnect", lastError: "Deleted at your request." });
    }
    await ctx.scheduler.runAfter(0, internal.compliance.purgeAccounts, { accountIds: accounts.map((a) => a._id), requestId });
    return code;
  },
});

/** Meta's deauthorize callback: the person removed the app, so drop the tokens and ask for a new sign-in. */
export const metaDeauthorize = internalMutation({
  args: { source: metaSourceValidator, userId: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const accounts = await metaAccounts(ctx, args.source, args.userId);
    for (const account of accounts) {
      const credentials = await ctx.db
        .query("credentials")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .take(10);
      for (const credential of credentials) await ctx.db.delete("credentials", credential._id);
      await ctx.db.patch("accounts", account._id, {
        status: "reconnect",
        lastError: "BuddySocials was removed from this account's app settings.",
        syncStartedAt: undefined,
      });
    }
    return accounts.length;
  },
});

export const deletionStatus = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("deletionRequests")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (request === null) return null;
    return {
      state: request.state,
      source: request.source,
      accountsFound: request.accountsFound,
      requestedAt: request.requestedAt,
      doneAt: request.doneAt ?? null,
    };
  },
});

/** One step of deleting everything an owner has. Each returns true while its table still has rows. */
const OWNER_STEPS: ((ctx: MutationCtx, owner: string) => Promise<boolean>)[] = [
  // Drafts first: cancel scheduled publishing before the accounts disappear.
  async (ctx, owner) => {
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_owner_and_updatedAt", (q) => q.eq("owner", owner))
      .take(25);
    for (const draft of drafts) {
      if (draft.scheduledJobId !== undefined) {
        try {
          await ctx.scheduler.cancel(draft.scheduledJobId);
        } catch {
          // Already ran or was cancelled.
        }
      }
      const deliveries = await ctx.db
        .query("draftDeliveries")
        .withIndex("by_draft", (q) => q.eq("draftId", draft._id))
        .take(100);
      for (const delivery of deliveries) await ctx.db.delete("draftDeliveries", delivery._id);
      if (deliveries.length === 100) return true;
      for (const item of draft.media) await deleteFile(ctx, item.storageId);
      if (draft.cover) await deleteFile(ctx, draft.cover.storageId);
      await ctx.db.delete("drafts", draft._id);
    }
    return drafts.length > 0;
  },
  async (ctx, owner) => {
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_owner_and_unusedSince", (q) => q.eq("owner", owner))
      .take(100);
    for (const upload of uploads) await deleteFile(ctx, upload.storageId);
    return uploads.length > 0;
  },
  async (ctx, owner) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .first();
    if (account === null) return false;
    await purgeAccountBatch(ctx, account._id);
    return true;
  },
  // Rows left behind by accounts removed earlier.
  async (ctx, owner) => {
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner))
      .take(200);
    for (const comment of comments) await ctx.db.delete("comments", comment._id);
    return comments.length > 0;
  },
  async (ctx, owner) => {
    const days = await ctx.db
      .query("dailyStats")
      .withIndex("by_owner_and_day", (q) => q.eq("owner", owner))
      .take(200);
    for (const day of days) await ctx.db.delete("dailyStats", day._id);
    return days.length > 0;
  },
  async (ctx, owner) => {
    const posts = await ctx.db
      .query("posts")
      .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner))
      .take(20);
    for (const post of posts) await deletePost(ctx, post._id);
    return posts.length > 0;
  },
  async (ctx, owner) => {
    let deleted = 0;
    for (const doc of await ctx.db.query("layouts").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)) {
      await ctx.db.delete("layouts", doc._id);
      deleted++;
    }
    for (const doc of await ctx.db.query("goals").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)) {
      await ctx.db.delete("goals", doc._id);
      deleted++;
    }
    for (const doc of await ctx.db.query("settings").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)) {
      await ctx.db.delete("settings", doc._id);
      deleted++;
    }
    for (const doc of await ctx.db.query("widgetTokens").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)) {
      await ctx.db.delete("widgetTokens", doc._id);
      deleted++;
    }
    for (const doc of await ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)) {
      await ctx.db.delete("profiles", doc._id);
      deleted++;
    }
    for (const doc of await ctx.db.query("metaUsers").withIndex("by_owner", (q) => q.eq("owner", owner)).take(50)) {
      await ctx.db.delete("metaUsers", doc._id);
      deleted++;
    }
    return deleted > 0;
  },
  // Sign-ins still in progress. They expire after ten minutes and have no owner index, so read a bounded slice.
  async (ctx, owner) => {
    for (const attempt of await ctx.db.query("connectAttempts").take(500)) {
      if (attempt.owner === owner) await ctx.db.delete("connectAttempts", attempt._id);
    }
    return false;
  },
];

export const purgeOwner = internalMutation({
  args: { owner: v.string(), step: v.number() },
  handler: async (ctx, args) => {
    const run = OWNER_STEPS[args.step];
    if (run === undefined) return null;
    const more = await run(ctx, args.owner);
    const step = more ? args.step : args.step + 1;
    if (step < OWNER_STEPS.length) await ctx.scheduler.runAfter(0, internal.compliance.purgeOwner, { owner: args.owner, step });
    return null;
  },
});

/**
 * Deletes the signed-in person's BuddySocials data: connected accounts, their tokens and
 * synced stats, posts and comments, drafts and uploaded files, goals, layouts and settings.
 * The work continues in the background in batches. The sign-in itself lives with Clerk.
 */
export const deleteMyAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    // Stop syncing and publishing now; the batches below remove the rows.
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(50);
    for (const account of accounts) {
      await ctx.db.patch("accounts", account._id, { status: "reconnect", lastError: "Being deleted.", syncStartedAt: undefined });
    }
    await ctx.scheduler.runAfter(0, internal.compliance.purgeOwner, { owner, step: 0 });
    return null;
  },
});
