import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { optionalOwner } from "./lib/owner";
import { metricValidator, platformValidator } from "./validators";
import { addDays } from "../shared/format";
import { EMPTY_DAY, postEngagement, postViews, type DayCounters } from "../shared/metrics";
import { PLATFORMS, type Platform } from "../shared/platforms";

function counters(row: Doc<"dailyStats">): DayCounters {
  return {
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    saves: row.saves,
    followers: row.followers,
  };
}

function add(a: DayCounters, b: DayCounters): DayCounters {
  return {
    views: a.views + b.views,
    likes: a.likes + b.likes,
    comments: a.comments + b.comments,
    shares: a.shares + b.shares,
    saves: a.saves + b.saves,
    followers: a.followers + b.followers,
  };
}

export type Overview = {
  days: string[];
  platforms: Platform[];
  /** Per platform, one entry per day in `days`. */
  series: Record<string, DayCounters[]>;
  /** Per platform, totals for the period before `days`. */
  previous: Record<string, DayCounters>;
  followersTotal: Record<string, number>;
};

export async function loadOverview(ctx: QueryCtx, owner: string, today: string, length: number): Promise<Overview> {
  const from = addDays(today, -(length - 1));
  const previousFrom = addDays(from, -length);
  const days = Array.from({ length }, (_, index) => addDays(from, index));
  const position = new Map(days.map((day, index) => [day, index]));

  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .take(20);
  const platforms = PLATFORMS.filter((platform) => accounts.some((account) => account.platform === platform));
  const series: Record<string, DayCounters[]> = {};
  const previous: Record<string, DayCounters> = {};
  const followersTotal: Record<string, number> = {};
  for (const platform of platforms) {
    series[platform] = days.map(() => ({ ...EMPTY_DAY }));
    previous[platform] = { ...EMPTY_DAY };
  }
  for (const account of accounts) {
    if (account.followers !== undefined) {
      followersTotal[account.platform] = (followersTotal[account.platform] ?? 0) + account.followers;
    }
  }

  const rows = await ctx.db
    .query("dailyStats")
    .withIndex("by_owner_and_day", (q) => q.eq("owner", owner).gte("day", previousFrom).lte("day", today))
    .take(length * 2 * 20);
  for (const row of rows) {
    const index = position.get(row.day);
    if (index !== undefined) {
      const list = series[row.platform];
      if (list) list[index] = add(list[index]!, counters(row));
    } else if (previous[row.platform]) {
      previous[row.platform] = add(previous[row.platform]!, counters(row));
    }
  }
  return { days, platforms, series, previous, followersTotal };
}

export const overview = query({
  args: { today: v.string(), days: v.number() },
  handler: async (ctx, args): Promise<Overview | null> => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    const length = Math.min(Math.max(Math.round(args.days), 1), 90);
    return await loadOverview(ctx, owner, args.today, length);
  },
});

function postSummary(post: Doc<"posts">) {
  return {
    _id: post._id,
    platform: post.platform,
    kind: post.kind,
    title: post.title ?? null,
    text: post.text ?? null,
    permalink: post.permalink ?? null,
    thumbnailUrl: post.thumbnailUrl ?? null,
    publishedAt: post.publishedAt,
    views: postViews(post.counters) ?? null,
    likes: post.counters.likes ?? null,
    comments: post.counters.comments ?? null,
    shares: post.counters.shares ?? null,
    saves: post.counters.saves ?? null,
    engagement: postEngagement(post.counters),
  };
}

export type PostSummary = ReturnType<typeof postSummary>;

export const topPosts = query({
  args: {
    since: v.number(),
    platform: v.optional(platformValidator),
    metric: metricValidator,
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return [];
    const platform = args.platform;
    const posts =
      platform === undefined
        ? await ctx.db
            .query("posts")
            .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner).gte("publishedAt", args.since))
            .take(400)
        : await ctx.db
            .query("posts")
            .withIndex("by_owner_and_platform_and_publishedAt", (q) =>
              q.eq("owner", owner).eq("platform", platform).gte("publishedAt", args.since),
            )
            .take(400);
    const metric = args.metric === "followers" ? "views" : args.metric;
    return posts
      .map(postSummary)
      .sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0))
      .slice(0, Math.min(args.limit, 20));
  },
});

export const latestPost = query({
  args: { platform: v.optional(platformValidator) },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    const platform = args.platform;
    const post =
      platform === undefined
        ? await ctx.db
            .query("posts")
            .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner))
            .order("desc")
            .first()
        : await ctx.db
            .query("posts")
            .withIndex("by_owner_and_platform_and_publishedAt", (q) => q.eq("owner", owner).eq("platform", platform))
            .order("desc")
            .first();
    if (post === null) return null;
    const snapshots = await ctx.db
      .query("postSnapshots")
      .withIndex("by_post_and_takenAt", (q) => q.eq("postId", post._id))
      .order("desc")
      .take(40);
    return {
      post: postSummary(post),
      curve: snapshots
        .reverse()
        .map((snapshot) => snapshot.views)
        .filter((value): value is number => value !== undefined),
    };
  },
});

export const posts = query({
  args: { platform: v.optional(platformValidator), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return { page: [], isDone: true, continueCursor: "" };
    const platform = args.platform;
    const result =
      platform === undefined
        ? await ctx.db
            .query("posts")
            .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner))
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("posts")
            .withIndex("by_owner_and_platform_and_publishedAt", (q) => q.eq("owner", owner).eq("platform", platform))
            .order("desc")
            .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(postSummary) };
  },
});

export const post = query({
  args: { postId: v.id("posts") },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    const post = await ctx.db.get("posts", args.postId);
    if (post === null || post.owner !== owner) return null;
    const account = await ctx.db.get("accounts", post.accountId);
    const snapshots = await ctx.db
      .query("postSnapshots")
      .withIndex("by_post_and_takenAt", (q) => q.eq("postId", post._id))
      .order("desc")
      .take(120);
    return {
      ...postSummary(post),
      native: post.native,
      handle: account?.handle ?? null,
      lastSyncedAt: post.lastSyncedAt,
      snapshots: snapshots.reverse().map((snapshot) => ({
        at: snapshot.takenAt,
        views: snapshot.views ?? null,
        likes: snapshot.likes ?? null,
      })),
    };
  },
});
