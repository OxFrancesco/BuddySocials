import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { loadOverview } from "./dashboard";
import { requireOwner } from "./lib/owner";
import { addDays, dayKey } from "../shared/format";
import { metricValue } from "../shared/metrics";

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
    const perPlatform = overview.platforms.map((platform) => ({
      platform,
      views: (overview.series[platform] ?? []).slice(7).reduce((sum, day) => sum + day.views, 0),
      engagement: (overview.series[platform] ?? []).slice(7).reduce((sum, day) => sum + metricValue(day, "engagement"), 0),
      followers: overview.followersTotal[platform] ?? null,
    }));
    const newFollowers = overview.platforms.reduce(
      (sum, platform) => sum + (overview.series[platform] ?? []).slice(7).reduce((s, day) => s + day.followers, 0),
      0,
    );
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
      perPlatform,
      openCount: open.length,
      latest: open.slice(0, 3).map((comment) => ({
        id: comment._id,
        platform: comment.platform,
        author: comment.authorHandle ?? comment.authorName,
        text: comment.text,
        publishedAt: comment.publishedAt,
      })),
    };
  },
});
