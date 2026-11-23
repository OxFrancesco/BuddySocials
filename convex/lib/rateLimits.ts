import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";

/**
 * Per-user limits on the endpoints that cost money, call platforms, or store files.
 * Token buckets: `rate` per `period` on average, with bursts up to `capacity`.
 * Keys are the user's tokenIdentifier, so one user can never use up another's allowance.
 */
const rateLimiter = new RateLimiter(components.rateLimiter, {
  /** Queuing a draft to platforms, now or on a schedule. */
  publish: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
  /** "Sync now" and loading demo accounts; each starts platform reads. */
  sync: { kind: "token bucket", rate: 12, period: HOUR, capacity: 4 },
  /** Starting a platform sign-in. */
  oauthBegin: { kind: "token bucket", rate: 20, period: HOUR, capacity: 5 },
  /** Creating a storage upload URL. */
  uploadUrl: { kind: "token bucket", rate: 120, period: HOUR, capacity: 30 },
  /** Fetching media from a link into storage. */
  mediaImport: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
  /** Replying to a comment on a platform. */
  commentReply: { kind: "token bucket", rate: 60, period: HOUR, capacity: 20 },
  /** Changing an uploaded YouTube video. */
  youtubeUpdate: { kind: "token bucket", rate: 30, period: HOUR, capacity: 10 },
  /** Each MCP tool call. */
  mcp: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 30 },
});

export type RateLimitName = "publish" | "sync" | "oauthBegin" | "uploadUrl" | "mediaImport" | "commentReply" | "youtubeUpdate" | "mcp";

/** Spends one unit of `name` for `owner`, or throws a readable error saying when to try again. */
export async function enforceRateLimit(ctx: MutationCtx | ActionCtx, name: RateLimitName, owner: string): Promise<void> {
  const status = await rateLimiter.limit(ctx, name, { key: owner });
  if (status.ok) return;
  const seconds = Math.max(1, Math.ceil(status.retryAfter / 1000));
  const wait = seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
  throw new Error(`Too many requests. Try again in ${wait}.`);
}
