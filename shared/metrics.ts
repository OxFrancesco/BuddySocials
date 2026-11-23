import type { Platform } from "./platforms";

/** Counters the dashboard can add up across platforms. */
export const DASHBOARD_METRICS = [
  "views",
  "likes",
  "comments",
  "shares",
  "saves",
  "followers",
  "engagement",
] as const;

export type DashboardMetric = (typeof DASHBOARD_METRICS)[number];

export const METRIC_LABEL: Record<DashboardMetric, string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  followers: "New followers",
  engagement: "Interactions",
};

/** The per-day counters stored for every account. */
export type DayCounters = {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  followers: number;
};

export const EMPTY_DAY: DayCounters = {
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  followers: 0,
};

export function metricValue(day: DayCounters, metric: DashboardMetric): number {
  if (metric === "engagement") return day.likes + day.comments + day.shares + day.saves;
  return day[metric];
}

/** Canonical lifetime counters kept on each post. Missing means the platform did not report it. */
export type PostCounters = Partial<{
  views: number;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  profile_views: number;
}>;

/** X and LinkedIn report impressions instead of views; the dashboard counts them as views. */
export function postViews(counters: PostCounters): number | undefined {
  return counters.views ?? counters.impressions;
}

export function postEngagement(counters: PostCounters): number {
  return (
    (counters.likes ?? 0) + (counters.comments ?? 0) + (counters.shares ?? 0) + (counters.saves ?? 0)
  );
}

type NativeMetric = { readonly name: string; readonly label: string; readonly unit?: "seconds" | "minutes" | "percent" };

/**
 * The provider metrics shown on a post, in the order each platform's own dashboard lists them.
 * Names match what the platform API returns; anything the platform omits is hidden.
 */
export const NATIVE_POST_METRICS: Record<Platform, readonly NativeMetric[]> = {
  youtube: [
    { name: "viewCount", label: "Views" },
    { name: "estimatedMinutesWatched", label: "Watch time", unit: "minutes" },
    { name: "averageViewDuration", label: "Avg view duration", unit: "seconds" },
    { name: "likeCount", label: "Likes" },
    { name: "commentCount", label: "Comments" },
    { name: "shares", label: "Shares" },
    { name: "subscribersGained", label: "Subscribers gained" },
  ],
  instagram: [
    { name: "views", label: "Views" },
    { name: "reach", label: "Accounts reached" },
    { name: "likes", label: "Likes" },
    { name: "comments", label: "Comments" },
    { name: "saved", label: "Saves" },
    { name: "shares", label: "Shares" },
    { name: "profile_visits", label: "Profile visits" },
    { name: "follows", label: "Follows" },
  ],
  tiktok: [
    { name: "view_count", label: "Views" },
    { name: "like_count", label: "Likes" },
    { name: "comment_count", label: "Comments" },
    { name: "share_count", label: "Shares" },
    { name: "reach", label: "Reach" },
    { name: "average_time_watched", label: "Avg watch time", unit: "seconds" },
    { name: "full_video_watched_rate", label: "Watched in full", unit: "percent" },
  ],
  x: [
    { name: "impressions", label: "Impressions" },
    { name: "likes", label: "Likes" },
    { name: "replies", label: "Replies" },
    { name: "reposts", label: "Reposts" },
    { name: "quotes", label: "Quotes" },
    { name: "bookmarks", label: "Bookmarks" },
    { name: "url_link_clicks", label: "Link clicks" },
    { name: "user_profile_clicks", label: "Profile clicks" },
  ],
  linkedin: [
    { name: "IMPRESSION", label: "Impressions" },
    { name: "MEMBERS_REACHED", label: "Members reached" },
    { name: "REACTION", label: "Reactions" },
    { name: "COMMENT", label: "Comments" },
    { name: "RESHARE", label: "Reposts" },
    { name: "POST_SAVE", label: "Saves" },
    { name: "POST_SEND", label: "Sends" },
    { name: "LINK_CLICKS", label: "Link clicks" },
    { name: "PROFILE_VIEW_FROM_CONTENT", label: "Profile views" },
    { name: "FOLLOWER_GAINED_FROM_CONTENT", label: "Followers gained" },
  ],
  facebook: [
    { name: "post_media_view", label: "Views" },
    { name: "post_total_media_view_unique", label: "Viewers" },
    { name: "reactions", label: "Reactions" },
    { name: "comments", label: "Comments" },
    { name: "shares", label: "Shares" },
    { name: "post_clicks", label: "Clicks" },
  ],
};

/** Provider names the SDK does not map to a canonical counter. */
export const EXTRA_CANONICAL: Record<string, keyof PostCounters> = {
  IMPRESSION: "impressions",
  MEMBERS_REACHED: "reach",
  REACTION: "likes",
  COMMENT: "comments",
  RESHARE: "shares",
  POST_SAVE: "saves",
  LINK_CLICKS: "clicks",
  PROFILE_VIEW_FROM_CONTENT: "profile_views",
  view_count: "views",
  like_count: "likes",
  comment_count: "comments",
  share_count: "shares",
  url_link_clicks: "clicks",
  user_profile_clicks: "profile_views",
  profile_visits: "profile_views",
  post_media_view: "views",
  post_total_media_view_unique: "reach",
  reactions: "likes",
  post_clicks: "clicks",
};

export type CanonicalMetric =
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "impressions"
  | "reach"
  | "saves"
  | "clicks"
  | "followers"
  | "profile_views";

/**
 * Provider metric name to canonical counter. Copied from the Social SDK's
 * `canonicalMetricName` on main, which is not in the 0.5.0 npm release yet.
 * Replace with the SDK export once it ships.
 */
const CANONICAL_NAMES: Record<string, CanonicalMetric> = {
  views: "views",
  view: "views",
  viewcount: "views",
  viewscount: "views",
  videoviews: "views",
  videoviewcount: "views",
  mediaviews: "views",
  plays: "views",
  playcount: "views",
  likes: "likes",
  like: "likes",
  likecount: "likes",
  likescount: "likes",
  favorites: "likes",
  favoritecount: "likes",
  comments: "comments",
  comment: "comments",
  commentcount: "comments",
  commentscount: "comments",
  replies: "comments",
  replycount: "comments",
  shares: "shares",
  share: "shares",
  sharecount: "shares",
  sharescount: "shares",
  reposts: "shares",
  repostcount: "shares",
  retweets: "shares",
  retweetcount: "shares",
  reshares: "shares",
  resharecount: "shares",
  impressions: "impressions",
  impressioncount: "impressions",
  reach: "reach",
  accountsreached: "reach",
  uniqueimpressionscount: "reach",
  saves: "saves",
  saved: "saves",
  savecount: "saves",
  bookmarks: "saves",
  bookmarkcount: "saves",
  clicks: "clicks",
  clickcount: "clicks",
  linkclicks: "clicks",
  linkclickcount: "clicks",
  urlclicks: "clicks",
  followers: "followers",
  followercount: "followers",
  followerscount: "followers",
  subscribers: "followers",
  subscribercount: "followers",
  profileviews: "profile_views",
  profileviewcount: "profile_views",
};

export function canonicalMetricName(name: string): CanonicalMetric | undefined {
  return CANONICAL_NAMES[name.replace(/[\s_-]/g, "").toLowerCase()];
}
