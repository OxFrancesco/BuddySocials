import { v } from "convex/values";

export const platformValidator = v.union(
  v.literal("youtube"),
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("x"),
  v.literal("linkedin"),
);

export const metricValidator = v.union(
  v.literal("views"),
  v.literal("likes"),
  v.literal("comments"),
  v.literal("shares"),
  v.literal("saves"),
  v.literal("followers"),
  v.literal("engagement"),
);

export const postCountersValidator = v.object({
  views: v.optional(v.number()),
  impressions: v.optional(v.number()),
  reach: v.optional(v.number()),
  likes: v.optional(v.number()),
  comments: v.optional(v.number()),
  shares: v.optional(v.number()),
  saves: v.optional(v.number()),
  clicks: v.optional(v.number()),
  profile_views: v.optional(v.number()),
});

export const widgetValidator = v.object({
  id: v.string(),
  type: v.union(
    v.literal("metric"),
    v.literal("trend"),
    v.literal("split"),
    v.literal("topPosts"),
    v.literal("latestPost"),
    v.literal("inbox"),
    v.literal("platform"),
    v.literal("goals"),
  ),
  size: v.union(v.literal("s"), v.literal("m"), v.literal("l"), v.literal("w"), v.literal("xl")),
  config: v.object({
    metric: metricValidator,
    range: v.union(v.literal(7), v.literal(28), v.literal(90)),
    platform: v.union(v.literal("all"), platformValidator),
  }),
});

export const dayCountersFields = {
  views: v.number(),
  likes: v.number(),
  comments: v.number(),
  shares: v.number(),
  saves: v.number(),
  followers: v.number(),
};
