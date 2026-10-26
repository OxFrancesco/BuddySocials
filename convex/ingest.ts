import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { platformValidator, postCountersValidator } from "./validators";
import { postViews, type PostCounters } from "../shared/metrics";
import { addDays, dayKey } from "../shared/format";

const HOUR = 3_600_000;
const SNAPSHOT_GAP_RECENT = 2 * HOUR;
const SNAPSHOT_GAP_OLD = 24 * HOUR;
const RECENT = 14 * 24 * HOUR;

type Counters = { views: number; likes: number; comments: number; shares: number; saves: number; followers: number };

async function dayRow(
  ctx: MutationCtx,
  account: Doc<"accounts">,
  day: string,
): Promise<Doc<"dailyStats"> | null> {
  return await ctx.db
    .query("dailyStats")
    .withIndex("by_account_and_day", (q) => q.eq("accountId", account._id).eq("day", day))
    .unique();
}

async function addToDay(ctx: MutationCtx, account: Doc<"accounts">, day: string, delta: Counters) {
  const row = await dayRow(ctx, account, day);
  if (row === null) {
    await ctx.db.insert("dailyStats", {
      owner: account.owner,
      accountId: account._id,
      platform: account.platform,
      day,
      ...delta,
      fromReport: false,
    });
    return;
  }
  if (row.fromReport) return;
  await ctx.db.patch("dailyStats", row._id, {
    views: row.views + delta.views,
    likes: row.likes + delta.likes,
    comments: row.comments + delta.comments,
    shares: row.shares + delta.shares,
    saves: row.saves + delta.saves,
    followers: row.followers + delta.followers,
  });
}

function asDayCounters(counters: PostCounters): Counters {
  return {
    views: postViews(counters) ?? 0,
    likes: counters.likes ?? 0,
    comments: counters.comments ?? 0,
    shares: counters.shares ?? 0,
    saves: counters.saves ?? 0,
    followers: 0,
  };
}

function minus(a: Counters, b: Counters): Counters {
  return {
    views: Math.max(0, a.views - b.views),
    likes: Math.max(0, a.likes - b.likes),
    comments: Math.max(0, a.comments - b.comments),
    shares: Math.max(0, a.shares - b.shares),
    saves: Math.max(0, a.saves - b.saves),
    followers: 0,
  };
}

const postInput = v.object({
  platformPostId: v.string(),
  kind: v.string(),
  title: v.optional(v.string()),
  text: v.optional(v.string()),
  permalink: v.optional(v.string()),
  thumbnailUrl: v.optional(v.string()),
  publishedAt: v.number(),
  counters: postCountersValidator,
  native: v.record(v.string(), v.number()),
  /** Lifetime views at earlier instants, only sent on the first sync of a demo account. */
  history: v.optional(v.array(v.object({ at: v.number(), views: v.number() }))),
});

export const posts = internalMutation({
  args: {
    accountId: v.id("accounts"),
    takenAt: v.number(),
    /** False when the platform reports days directly (YouTube Analytics, demo). */
    deltaDaily: v.boolean(),
    posts: v.array(postInput),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return;
    const today = dayKey(args.takenAt);
    for (const input of args.posts) {
      const { history, ...fields } = input;
      const existing = await ctx.db
        .query("posts")
        .withIndex("by_account_and_platformPostId", (q) =>
          q.eq("accountId", account._id).eq("platformPostId", input.platformPostId),
        )
        .unique();

      let postId: Id<"posts">;
      if (existing === null) {
        postId = await ctx.db.insert("posts", {
          ...fields,
          owner: account.owner,
          accountId: account._id,
          platform: account.platform,
          lastSyncedAt: args.takenAt,
        });
        if (args.deltaDaily) {
          // A post seen for the first time lands on the day it was published.
          await addToDay(ctx, account, dayKey(input.publishedAt), asDayCounters(input.counters));
        }
        for (const point of history ?? []) {
          await ctx.db.insert("postSnapshots", { postId, takenAt: point.at, views: point.views });
        }
      } else {
        postId = existing._id;
        if (args.deltaDaily) {
          await addToDay(ctx, account, today, minus(asDayCounters(input.counters), asDayCounters(existing.counters)));
        }
        await ctx.db.patch("posts", existing._id, { ...fields, lastSyncedAt: args.takenAt });
      }

      const last = await ctx.db
        .query("postSnapshots")
        .withIndex("by_post_and_takenAt", (q) => q.eq("postId", postId))
        .order("desc")
        .first();
      const gap = args.takenAt - input.publishedAt < RECENT ? SNAPSHOT_GAP_RECENT : SNAPSHOT_GAP_OLD;
      if (last === null || args.takenAt - last.takenAt >= gap) {
        await ctx.db.insert("postSnapshots", {
          postId,
          takenAt: args.takenAt,
          views: postViews(input.counters),
          likes: input.counters.likes,
          comments: input.counters.comments,
          shares: input.counters.shares,
        });
      }
    }
  },
});

export const days = internalMutation({
  args: {
    accountId: v.id("accounts"),
    rows: v.array(
      v.object({
        day: v.string(),
        views: v.number(),
        likes: v.number(),
        comments: v.number(),
        shares: v.number(),
        saves: v.number(),
        followers: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return;
    for (const row of args.rows) {
      const existing = await dayRow(ctx, account, row.day);
      if (existing === null) {
        await ctx.db.insert("dailyStats", {
          owner: account.owner,
          accountId: account._id,
          platform: account.platform,
          ...row,
          fromReport: true,
        });
      } else {
        await ctx.db.patch("dailyStats", existing._id, { ...row, fromReport: true });
      }
    }
  },
});

/** Stores today's follower total; derives new followers when the platform has no daily report. */
export const followers = internalMutation({
  args: { accountId: v.id("accounts"), total: v.number(), takenAt: v.number() },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return;
    const today = dayKey(args.takenAt);
    const row = await dayRow(ctx, account, today);
    const yesterday = await dayRow(ctx, account, addDays(today, -1));
    if (row === null) {
      await ctx.db.insert("dailyStats", {
        owner: account.owner,
        accountId: account._id,
        platform: account.platform,
        day: today,
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        saves: 0,
        followers:
          yesterday?.followersTotal !== undefined ? Math.max(0, args.total - yesterday.followersTotal) : 0,
        followersTotal: args.total,
        fromReport: false,
      });
      return;
    }
    const patch: Partial<Doc<"dailyStats">> = { followersTotal: args.total };
    if (!row.fromReport && yesterday?.followersTotal !== undefined) {
      patch.followers = Math.max(0, args.total - yesterday.followersTotal);
    }
    await ctx.db.patch("dailyStats", row._id, patch);
  },
});

export const comments = internalMutation({
  args: {
    accountId: v.id("accounts"),
    platform: platformValidator,
    /** On the first sync, older comments arrive already handled so the inbox starts clean. */
    doneBefore: v.optional(v.number()),
    items: v.array(
      v.object({
        platformPostId: v.string(),
        platformCommentId: v.string(),
        parentId: v.optional(v.string()),
        authorName: v.string(),
        authorHandle: v.optional(v.string()),
        text: v.string(),
        publishedAt: v.number(),
        likeCount: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get("accounts", args.accountId);
    if (account === null) return;
    const postIds = new Map<string, Id<"posts"> | null>();
    for (const item of args.items) {
      if (!postIds.has(item.platformPostId)) {
        const post = await ctx.db
          .query("posts")
          .withIndex("by_account_and_platformPostId", (q) =>
            q.eq("accountId", account._id).eq("platformPostId", item.platformPostId),
          )
          .unique();
        postIds.set(item.platformPostId, post?._id ?? null);
      }
      const postId = postIds.get(item.platformPostId);
      if (!postId) continue;
      const { platformPostId: _ignored, ...fields } = item;
      const existing = await ctx.db
        .query("comments")
        .withIndex("by_account_and_platformCommentId", (q) =>
          q.eq("accountId", account._id).eq("platformCommentId", item.platformCommentId),
        )
        .unique();
      if (existing === null) {
        await ctx.db.insert("comments", {
          ...fields,
          owner: account.owner,
          accountId: account._id,
          postId,
          platform: args.platform,
          state: args.doneBefore !== undefined && item.publishedAt < args.doneBefore ? "done" : "open",
        });
      } else {
        await ctx.db.patch("comments", existing._id, { text: item.text, likeCount: item.likeCount });
      }
    }
  },
});
