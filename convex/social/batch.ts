"use node";

import { SocialError, type JsonObject, type MetricValue } from "@opencoredev/social-sdk";
import type { Platform } from "../../shared/platforms";

/**
 * The SDK reads post counters one post at a time. These calls get the posts and their
 * counters for a whole page at once, which matters on X (billed per read) and Instagram
 * (rate limited per hour).
 */

export type PostPage = { records: JsonObject[]; metrics: Map<string, MetricValue[]> };

function metric(name: string, value: unknown, source: string): MetricValue[] {
  return typeof value === "number" && Number.isFinite(value)
    ? [{ name, value, unit: "count", period: "lifetime", fetchedAt: new Date().toISOString(), freshness: "unknown", source } as MetricValue]
    : [];
}

async function getJson(url: string, accessToken: string, operation: string): Promise<JsonObject> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (response.ok) return (await response.json()) as JsonObject;
  const status = response.status;
  // Meta answers a dead token with HTTP 400 and its own error code 190, not 401.
  const meta = status === 400 ? ((await response.json().catch(() => null)) as { error?: { code?: unknown } } | null) : null;
  const code =
    status === 401 || meta?.error?.code === 190
      ? "reconnect_required"
      : status === 402
        ? "billing_required"
        : status === 403
          ? "missing_permission"
          : status === 429
            ? "rate_limited"
            : "upstream_failure";
  throw new SocialError({ code, operation, message: `HTTP ${status}`, upstreamStatus: status });
}

/** X: one call to your own timeline, with the counters, billed at the owned-read rate. */
async function xPosts(userId: string, accessToken: string, limit: number): Promise<PostPage> {
  const url = new URL(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`);
  url.searchParams.set("tweet.fields", "id,text,author_id,created_at,conversation_id,public_metrics");
  url.searchParams.set("max_results", String(Math.min(100, Math.max(5, limit))));
  const result = await getJson(url.toString(), accessToken, "posts.list");
  const rows = Array.isArray(result["data"]) ? (result["data"] as JsonObject[]) : [];
  const records = rows.filter((row) => row["author_id"] === userId);
  const metrics = new Map<string, MetricValue[]>();
  for (const row of records) {
    const counts = (row["public_metrics"] ?? {}) as JsonObject;
    metrics.set(String(row["id"]), [
      ...metric("likes", counts["like_count"], "X API v2"),
      ...metric("reposts", counts["retweet_count"], "X API v2"),
      ...metric("replies", counts["reply_count"], "X API v2"),
      ...metric("quotes", counts["quote_count"], "X API v2"),
      ...metric("impressions", counts["impression_count"], "X API v2"),
      ...metric("bookmarks", counts["bookmark_count"], "X API v2"),
    ]);
  }
  return { records, metrics };
}

const INSTAGRAM = "https://graph.instagram.com/v25.0";
const INSTAGRAM_INSIGHTS = ["views", "likes", "comments", "saved", "shares", "reach"];

/** Instagram: media and their insights in one request per page of 50. */
async function instagramPosts(accessToken: string, limit: number): Promise<PostPage> {
  const fields = `id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count,insights.metric(${INSTAGRAM_INSIGHTS.join(",")})`;
  const records: JsonObject[] = [];
  const metrics = new Map<string, MetricValue[]>();
  let next: string | undefined = `${INSTAGRAM}/me/media?fields=${encodeURIComponent(fields)}&limit=${Math.min(limit, 50)}`;
  while (next && records.length < limit) {
    const page = await getJson(next, accessToken, "posts.list");
    for (const row of Array.isArray(page["data"]) ? (page["data"] as JsonObject[]) : []) {
      const { insights, like_count, comments_count, ...record } = row;
      records.push(record);
      const values: MetricValue[] = [];
      const data = (insights as JsonObject | undefined)?.["data"];
      for (const entry of Array.isArray(data) ? (data as JsonObject[]) : []) {
        const first = Array.isArray(entry["values"]) ? (entry["values"] as JsonObject[])[0] : undefined;
        const total = entry["total_value"] as JsonObject | undefined;
        values.push(...metric(String(entry["name"]), first?.["value"] ?? total?.["value"], "instagram:v25.0"));
      }
      // Insights can be missing on old posts; the media counts still are not.
      if (!values.some((value) => value.name === "likes")) values.push(...metric("likes", like_count, "instagram:v25.0"));
      if (!values.some((value) => value.name === "comments")) values.push(...metric("comments", comments_count, "instagram:v25.0"));
      metrics.set(String(record["id"]), values);
    }
    const paging = page["paging"] as JsonObject | undefined;
    next = typeof paging?.["next"] === "string" ? paging["next"] : undefined;
  }
  return { records: records.slice(0, limit), metrics };
}

/** Posts plus counters in one pass, for platforms where the SDK would read each post separately. */
export async function postsWithMetrics(
  platform: Platform,
  accountId: string,
  accessToken: string,
  limit: number,
): Promise<PostPage | null> {
  if (platform === "x") return xPosts(accountId, accessToken, limit);
  if (platform === "instagram") return instagramPosts(accessToken, limit);
  return null;
}

/** Counters for posts the SDK already listed: TikTok's list carries them, YouTube takes 50 videos per call. */
export async function metricsFor(
  platform: Platform,
  records: readonly JsonObject[],
  accessToken: string,
): Promise<Map<string, MetricValue[]> | null> {
  if (platform === "tiktok") {
    return new Map(
      records.map((row) => [
        String(row["id"]),
        ["like_count", "comment_count", "share_count", "view_count"].flatMap((name) => metric(name, row[name], "tiktok:video.list")),
      ]),
    );
  }
  if (platform === "youtube") {
    const ids = records.map((row) => String(row["id"] ?? (row["contentDetails"] as JsonObject | undefined)?.["videoId"]));
    const metrics = new Map<string, MetricValue[]>();
    for (let i = 0; i < ids.length; i += 50) {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&maxResults=50&id=${ids.slice(i, i + 50).map(encodeURIComponent).join(",")}`;
      const result = await getJson(url, accessToken, "analytics.post.read");
      for (const item of Array.isArray(result["items"]) ? (result["items"] as JsonObject[]) : []) {
        const stats = (item["statistics"] ?? {}) as JsonObject;
        metrics.set(
          String(item["id"]),
          ["viewCount", "likeCount", "commentCount"].flatMap((name) => metric(name, Number(stats[name] ?? Number.NaN), "youtube-data-v3")),
        );
      }
    }
    return metrics;
  }
  return null;
}
