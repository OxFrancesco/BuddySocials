"use node";

import type { JsonObject, MetricValue } from "@opencoredev/social-sdk";
import { EXTRA_CANONICAL, canonicalMetricName, type PostCounters } from "../../shared/metrics";
import type { Platform } from "../../shared/platforms";

export type ExtractedPost = {
  platformPostId: string;
  kind: string;
  title?: string;
  text?: string;
  permalink?: string;
  thumbnailUrl?: string;
  publishedAt: number;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function obj(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function time(value: unknown): number | undefined {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").find((line) => line.trim().length > 0)?.trim().slice(0, 140);
}

/** Reads the provider record each adapter's posts.list returns. */
export function extractPost(platform: Platform, row: JsonObject): ExtractedPost | null {
  switch (platform) {
    case "youtube": {
      const snippet = obj(row["snippet"]);
      const id = str(row["id"]) ?? str(obj(row["contentDetails"])["videoId"]);
      const publishedAt = time(snippet["publishedAt"]);
      if (!id || publishedAt === undefined) return null;
      const thumbs = obj(snippet["thumbnails"]);
      return {
        platformPostId: id,
        kind: str(row["kind"]) === "short" ? "short" : "video",
        title: str(snippet["title"]),
        text: str(snippet["description"]),
        permalink: `https://www.youtube.com/watch?v=${id}`,
        thumbnailUrl: str(obj(thumbs["high"])["url"]) ?? str(obj(thumbs["medium"])["url"]),
        publishedAt,
      };
    }
    case "instagram": {
      const id = str(row["id"]);
      const publishedAt = time(row["timestamp"]);
      if (!id || publishedAt === undefined) return null;
      const caption = str(row["caption"]);
      return {
        platformPostId: id,
        kind: str(row["media_product_type"]) === "REELS" ? "reel" : (str(row["media_type"]) ?? "post").toLowerCase(),
        title: firstLine(caption),
        text: caption,
        permalink: str(row["permalink"]),
        thumbnailUrl: str(row["thumbnail_url"]) ?? (str(row["media_type"]) === "IMAGE" ? str(row["media_url"]) : undefined),
        publishedAt,
      };
    }
    case "tiktok": {
      const id = str(row["id"]);
      const publishedAt = time(row["create_time"]);
      if (!id || publishedAt === undefined) return null;
      const description = str(row["video_description"]);
      return {
        platformPostId: id,
        kind: "video",
        title: str(row["title"]) ?? firstLine(description),
        text: description,
        permalink: str(row["share_url"]),
        thumbnailUrl: str(row["cover_image_url"]),
        publishedAt,
      };
    }
    case "x": {
      const id = str(row["id"]);
      const publishedAt = time(row["created_at"]);
      if (!id || publishedAt === undefined) return null;
      const text = str(row["text"]);
      return {
        platformPostId: id,
        kind: "post",
        title: firstLine(text),
        text,
        permalink: `https://x.com/i/web/status/${id}`,
        publishedAt,
      };
    }
    case "linkedin": {
      const id = str(row["id"]);
      const publishedAt = time(row["publishedAt"]) ?? time(row["createdAt"]) ?? time(obj(row["created"])["time"]);
      if (!id || publishedAt === undefined) return null;
      const text = str(row["commentary"]);
      return {
        platformPostId: id,
        kind: "post",
        title: firstLine(text),
        text,
        permalink: `https://www.linkedin.com/feed/update/${id}/`,
        publishedAt,
      };
    }
    case "facebook": {
      const id = str(row["id"]);
      const publishedAt = time(row["created_time"]);
      if (!id || publishedAt === undefined) return null;
      const message = str(row["message"]);
      const status = str(row["status_type"]);
      return {
        platformPostId: id,
        kind: status === "added_video" ? "video" : status === "added_photos" ? "photo" : "post",
        title: firstLine(message),
        text: message,
        permalink: str(row["permalink_url"]) ?? `https://www.facebook.com/${id}`,
        thumbnailUrl: str(row["full_picture"]),
        publishedAt,
      };
    }
  }
}

export function countersFrom(metrics: readonly MetricValue[]): {
  counters: PostCounters;
  native: Record<string, number>;
} {
  const counters: PostCounters = {};
  const native: Record<string, number> = {};
  for (const metric of metrics) {
    if (!Number.isFinite(metric.value)) continue;
    native[metric.name] = metric.value;
    if (metric.unit !== "count") continue;
    const key = canonicalMetricName(metric.name) ?? EXTRA_CANONICAL[metric.name];
    if (key !== undefined && key !== "followers" && counters[key] === undefined) counters[key] = metric.value;
  }
  return { counters, native };
}

export function followersFrom(metrics: readonly MetricValue[]): number | undefined {
  for (const metric of metrics) {
    const key = canonicalMetricName(metric.name);
    if (key === "followers" && Number.isFinite(metric.value)) return metric.value;
  }
  return undefined;
}

export type ExtractedComment = {
  id: string;
  text: string;
  publishedAt: number;
  authorName?: string;
  authorHandle?: string;
  authorId?: string;
  parentId?: string;
  likeCount?: number;
};

/** Reads the record each adapter's comments.list returns. Field names differ per platform. */
export function extractComment(row: JsonObject, now: number): ExtractedComment | null {
  const id = str(row["id"]) ?? str(row["commentUrn"]);
  const text = str(row["text"]) ?? str(row["textDisplay"]);
  if (!id || !text) return null;
  // LinkedIn comments carry no timestamp in this response; treat them as seen now.
  const publishedAt = time(row["createdAt"]) ?? time(row["publishedAt"]) ?? time(row["created_at"]) ?? time(row["timestamp"]) ?? now;
  const authorName = str(row["authorName"]) ?? str(row["authorDisplayName"]);
  const authorHandle = str(row["authorHandle"]) ?? str(row["username"]);
  const authorId = str(row["author_id"]) ?? str(row["actor"]);
  const likes = row["likeCount"] ?? obj(row["public_metrics"])["like_count"];
  return {
    id,
    text,
    publishedAt,
    ...(authorName ? { authorName } : {}),
    ...(authorHandle ? { authorHandle } : {}),
    ...(authorId ? { authorId } : {}),
    ...(str(row["parentId"]) ? { parentId: str(row["parentId"])! } : {}),
    ...(typeof likes === "number" ? { likeCount: likes } : {}),
  };
}
