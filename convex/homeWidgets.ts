import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { loadOverview } from "./dashboard";
import { requireOwner } from "./lib/owner";
import { addDays, dayKey } from "../shared/format";
import { metricValue, postViews } from "../shared/metrics";
import { loadGoals } from "./goals";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Issues the read-only token the Android home screen widgets send to
 * /widget-snapshot. One token per owner; issuing a new one revokes the old.
 */
export const issueToken = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const old = await ctx.db
      .query("widgetTokens")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .take(10);
    for (const row of old) await ctx.db.delete("widgetTokens", row._id);
    await ctx.db.insert("widgetTokens", { owner, tokenHash: await sha256(token), createdAt: Date.now() });
    return token;
  },
});

export const snapshotForToken = internalQuery({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const tokenHash = await sha256(args.token);
    const token = await ctx.db
      .query("widgetTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (token === null) return null;
    const owner = token.owner;
    const today = dayKey(args.now);
    const overview = await loadOverview(ctx, owner, today, 14);
    const daily = overview.days.map((_, index) =>
      overview.platforms.reduce((sum, platform) => sum + (overview.series[platform]?.[index]?.views ?? 0), 0),
    );
    const week = daily.slice(7).reduce((a, b) => a + b, 0);
    const previousWeek = daily.slice(0, 7).reduce((a, b) => a + b, 0);
    const perPlatform = overview.platforms.map((platform) => {
      const series = overview.series[platform] ?? [];
      return {
        platform,
        views: series.slice(7).reduce((sum, day) => sum + day.views, 0),
        previousViews: series.slice(0, 7).reduce((sum, day) => sum + day.views, 0),
        engagement: series.slice(7).reduce((sum, day) => sum + metricValue(day, "engagement"), 0),
        newFollowers: series.slice(7).reduce((sum, day) => sum + day.followers, 0),
        followers: overview.followersTotal[platform] ?? null,
        daily: series.map((day) => day.views),
      };
    });
    const newFollowers = perPlatform.reduce((sum, entry) => sum + entry.newFollowers, 0);
    const followersTotal = perPlatform.reduce((sum, entry) => sum + (entry.followers ?? 0), 0);
    const engagement = perPlatform.reduce((sum, entry) => sum + entry.engagement, 0);
    const goalData = await loadGoals(ctx, owner, today);
    const latestPost = await ctx.db
      .query("posts")
      .withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner))
      .order("desc")
      .first();
    const curve =
      latestPost === null
        ? []
        : (
            await ctx.db
              .query("postSnapshots")
              .withIndex("by_post_and_takenAt", (q) => q.eq("postId", latestPost._id))
              .order("desc")
              .take(30)
          )
            .reverse()
            .map((snapshot) => snapshot.views)
            .filter((value): value is number => value !== undefined);
    const open = await ctx.db
      .query("comments")
      .withIndex("by_owner_and_state_and_publishedAt", (q) => q.eq("owner", owner).eq("state", "open"))
      .order("desc")
      .take(100);
    return {
      today,
      since: addDays(today, -6),
      daily,
      week,
      previousWeek,
      newFollowers,
      followersTotal,
      engagement,
      perPlatform,
      goals: goalData.goals
        .filter((goal) => goal.state !== "missed")
        .slice(0, 5)
        .map((goal) => ({
          id: goal._id,
          title: goal.title,
          value: goal.value,
          target: goal.target,
          progress: goal.progress,
          pace: goal.elapsedShare,
          state: goal.state,
          daysLeft: goal.daysLeft,
          streak: goal.streak,
        })),
      latestPost:
        latestPost === null
          ? null
          : {
              id: latestPost._id,
              platform: latestPost.platform,
              title: latestPost.title ?? latestPost.text ?? "Untitled",
              publishedAt: latestPost.publishedAt,
              views: postViews(latestPost.counters) ?? null,
              likes: latestPost.counters.likes ?? null,
              comments: latestPost.counters.comments ?? null,
              curve,
            },
      openCount: open.length,
      latest: open.slice(0, 6).map((comment) => ({
        id: comment._id,
        platform: comment.platform,
        author: comment.authorHandle ?? comment.authorName,
        text: comment.text,
        publishedAt: comment.publishedAt,
      })),
    };
  },
});
