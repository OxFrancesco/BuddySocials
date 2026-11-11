"use node";

import {
  SocialError,
  connectedAccountRef,
  platformPostRef,
  type JsonObject,
  type MetricValue,
} from "@opencoredev/social-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import { metricsFor, postsWithMetrics } from "./social/batch";
import { adapterFor, openCredential, sealCredential, socialFor, supports } from "./social/client";
import { refreshIfNeeded } from "./social/oauth";
import type { DemoNative } from "./social/demo";
import { countersFrom, extractComment, extractPost, followersFrom, type ExtractedPost } from "./social/extract";
import { addDays, dayKey } from "../shared/format";
import type { Platform } from "../shared/platforms";

const DAY = 86_400_000;
const POST_LIMIT = 50;
const COMMENT_WINDOW = 30 * DAY;
const COMMENTS_PER_POST = 50;
/** Largest page each platform accepts for its post list. */
const PAGE_SIZE: Partial<Record<Platform, number>> = { tiktok: 20, youtube: 50 };
const CHUNK = 25;

/** Report metric names per source. YouTube Analytics uses its own names; demo uses ours. */
const REPORT_METRICS: Partial<Record<string, Record<string, keyof DayRow>>> = {
  youtube: { views: "views", likes: "likes", comments: "comments", shares: "shares", subscribersGained: "followers" },
  demo: { views: "views", likes: "likes", comments: "comments", shares: "shares", saves: "saves", followers: "followers" },
};

type DayRow = { day: string; views: number; likes: number; comments: number; shares: number; saves: number; followers: number };

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The stored sign-in is missing or can't be read, so only signing in again helps. */
class ReconnectError extends Error {}

function errorMessage(error: unknown): { message: string; reconnect: boolean } {
  if (error instanceof ReconnectError) return { message: "Sign in to this account again.", reconnect: true };
  if (error instanceof SocialError) {
    const reconnect = error.code === "reconnect_required" || error.code === "unauthorized";
    const friendly: Record<string, string> = {
      reconnect_required: "Sign in to this account again.",
      unauthorized: "Sign in to this account again.",
      missing_permission: "The account did not grant a permission BuddySocials needs.",
      rate_limited: "The platform asked us to slow down. Trying again later.",
      unsupported_capability: "This platform does not offer that data.",
    };
    if (error.code === "billing_required" || /HTTP 402/.test(error.message)) {
      return { message: "The developer account is out of API credits.", reconnect: false };
    }
    return { message: friendly[error.code] ?? error.message, reconnect };
  }
  return { message: error instanceof Error ? error.message : "Sync failed.", reconnect: false };
}

async function load(ctx: ActionCtx, accountId: Id<"accounts">) {
  const loaded: { account: Doc<"accounts">; sealed: { iv: string; ciphertext: string } | null } | null =
    await ctx.runQuery(internal.accounts.getInternal, { accountId });
  if (loaded === null) return null;
  let credential = loaded.sealed === null ? null : openCredential(loaded.sealed);
  if (credential === null && loaded.account.source === "direct") throw new ReconnectError();
  if (credential !== null) {
    const refreshed = await refreshIfNeeded(loaded.account.platform, credential);
    if (refreshed !== null) {
      credential = refreshed;
      await ctx.runMutation(internal.connectStore.replaceCredential, {
        accountId,
        sealed: sealCredential(refreshed),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      });
    }
  }
  const adapter = adapterFor(loaded.account, credential);
  return { account: loaded.account, adapter, social: socialFor(adapter), credential };
}

/** The SDK's Instagram post insights skip `views`, the metric Instagram's own dashboard leads with. */
async function instagramViews(postId: string, accessToken: string): Promise<MetricValue[]> {
  const response = await fetch(`https://graph.instagram.com/v25.0/${encodeURIComponent(postId)}/insights?metric=views`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { data?: { name?: string; values?: { value?: unknown }[] }[] };
  const value = data.data?.find((row) => row.name === "views")?.values?.[0]?.value;
  if (typeof value !== "number") return [];
  return [
    { name: "views", value, unit: "count", period: "lifetime", fetchedAt: new Date().toISOString(), freshness: "unknown", source: "instagram:v25.0" } as MetricValue,
  ];
}

export const syncAccount = internalAction({
  args: { accountId: v.id("accounts"), backfill: v.boolean() },
  handler: async (ctx, args) => {
    // Loading refreshes the token, which fails when the sign-in was revoked or expired.
    // That has to end the sync like any other failure, or the account stays "syncing".
    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load(ctx, args.accountId);
    } catch (error) {
      const { message, reconnect } = errorMessage(error);
      console.error("sync load", error instanceof SocialError ? `${error.code} ${error.operation ?? ""} ${error.message}` : String(error));
      await ctx.runMutation(internal.accounts.finishSync, { accountId: args.accountId, error: message, reconnect });
      return null;
    }
    if (loaded === null) return null;
    const { account, adapter, social, credential } = loaded;
    const platform = account.platform;
    const manifest = adapter.capabilities;
    const ref = connectedAccountRef({ backend: "default", platform, accountId: account.platformAccountId });
    const now = Date.now();
    // A part the platform won't share (missing permission, not offered) is skipped, not fatal.
    const limited: string[] = [];
    async function part<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
      try {
        return await run();
      } catch (error) {
        if (error instanceof SocialError && (error.code === "missing_permission" || error.code === "unsupported_capability")) {
          limited.push(name);
          return undefined;
        }
        throw error;
      }
    }

    try {
      // 1. Days, when the platform reports them (YouTube Analytics; demo).
      const hasReport = supports(manifest, "analytics.report.read", platform);
      if (hasReport) {
        const names = REPORT_METRICS[adapter.id === "demo" ? "demo" : platform] ?? {};
        const today = dayKey(now);
        const report = await part("daily stats", () =>
          social.analytics.getReport(ref, {
            from: addDays(today, args.backfill ? -179 : -6),
            to: today,
            metrics: Object.keys(names),
            dimensions: ["day"],
          }),
        );
        const rows: DayRow[] = (report?.rows ?? []).flatMap((row) => {
          const day = row.dimensions["day"];
          if (typeof day !== "string") return [];
          const out: DayRow = { day, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers: 0 };
          for (const [name, key] of Object.entries(names)) {
            const value = row.metrics[name];
            if (typeof value === "number" && key !== "day") out[key] = value;
          }
          return [out];
        });
        for (const batch of chunks(rows, 60)) {
          await ctx.runMutation(internal.ingest.days, { accountId: account._id, rows: batch });
        }
      }

      // Followers are one independent call; start it now so it overlaps the post reads.
      const followersRead = supports(manifest, "analytics.account.read", platform)
        ? part("followers", () => social.analytics.getAccountMetrics(ref)).then(
            (metrics) => ({ metrics }),
            (error: unknown) => ({ error }),
          )
        : null;

      // 2. Recent posts and their counters, in as few calls as each platform allows.
      const direct = adapter.id !== "demo" && credential ? credential.accessToken : null;
      const previousComments = new Map(
        (await ctx.runQuery(internal.comments.countsInternal, { accountId: account._id })).map((row) => [row.id, row.comments]),
      );
      let records: JsonObject[] = [];
      let known: Map<string, MetricValue[]> | null = null;
      // A batched call the platform rejects falls back to the SDK's post-by-post reads; sign-in and billing problems don't.
      const fallback = (error: unknown) => {
        if (!(error instanceof SocialError) || error.code !== "upstream_failure") throw error;
        console.warn(`sync ${platform}`, "batched read failed, reading post by post", error.message);
        return null;
      };
      let listed = false;
      if (direct) {
        const page = await part("posts", () => postsWithMetrics(platform, account.platformAccountId, direct, POST_LIMIT).catch(fallback));
        if (page) ({ records, metrics: known } = page);
        listed = page !== null;
      }
      if (!listed) {
        await part("posts", async () => {
          let cursor: string | undefined;
          while (records.length < POST_LIMIT) {
            const page = await social.posts.list(ref, { limit: PAGE_SIZE[platform] ?? 25, ...(cursor ? { cursor } : {}) });
            records.push(...page.items);
            if (!page.nextCursor || page.items.length === 0) break;
            cursor = page.nextCursor;
          }
        });
        if (direct) known = await metricsFor(platform, records.slice(0, POST_LIMIT), direct).catch(fallback);
      }
      const posts = records
        .map((record) => extractPost(platform, record))
        .filter((post): post is ExtractedPost => post !== null)
        .slice(0, POST_LIMIT);

      const withMetrics = await mapLimit(posts, 5, async (post) => {
        let metrics: readonly MetricValue[] = known?.get(post.platformPostId) ?? [];
        if (known === null) {
          try {
            metrics = await social.analytics.getPostMetrics(
              platformPostRef({ ...ref, postId: post.platformPostId }),
            );
          } catch (error) {
            if (!(error instanceof SocialError) || error.code === "reconnect_required") throw error;
          }
          if (platform === "instagram" && direct) {
            metrics = [...metrics, ...(await instagramViews(post.platformPostId, direct))];
          }
        }
        const { counters, native } = countersFrom(metrics);
        let history: { at: number; views: number }[] | undefined;
        if (args.backfill && adapter.id === "demo" && now - post.publishedAt < COMMENT_WINDOW) {
          const points: number[] = [];
          for (let at = post.publishedAt + 3 * 3_600_000; at < now - 3_600_000; at += Math.max(6 * 3_600_000, (now - post.publishedAt) / 16)) {
            points.push(at);
          }
          const views = (adapter.native as DemoNative).history(platform as Platform, post.platformPostId, points);
          history = points.map((at, index) => ({ at, views: views[index] ?? 0 }));
        }
        return { ...post, counters, native, ...(history ? { history } : {}) };
      });
      for (const batch of chunks(withMetrics, CHUNK)) {
        await ctx.runMutation(internal.ingest.posts, {
          accountId: account._id,
          takenAt: now,
          deltaDaily: !hasReport,
          posts: batch,
        });
      }

      // 3. Followers.
      let followers: number | undefined;
      if (followersRead !== null) {
        const read = await followersRead;
        if ("error" in read) throw read.error;
        const metrics = read.metrics;
        followers = metrics ? followersFrom(metrics) : undefined;
        if (followers !== undefined) {
          await ctx.runMutation(internal.ingest.followers, { accountId: account._id, total: followers, takenAt: now });
        }
      }

      // 4. Comments.
      if (supports(manifest, "comments.read", platform)) {
        // Last 30 days, plus the latest few posts so a quiet month still fills the inbox. X bills every read.
        const latest = platform === "x" ? [] : [...posts].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 10);
        const candidates = [...new Map([...posts.filter((post) => now - post.publishedAt < COMMENT_WINDOW), ...latest].map((post) => [post.platformPostId, post])).values()];
        // Only posts whose comment count moved since the last sync. The first sync of each UTC day
        // reads them all to catch edits and deletions, except on X where every read is billed.
        const sweep = args.backfill || (platform !== "x" && (account.lastSyncedAt === undefined || dayKey(account.lastSyncedAt) !== dayKey(now)));
        const counted = new Map(withMetrics.map((post) => [post.platformPostId, post.counters.comments]));
        const recent = sweep
          ? candidates
          : candidates.filter((post) => {
              const count = counted.get(post.platformPostId);
              return count === undefined || count !== previousComments.get(post.platformPostId);
            });
        const ownHandle = account.handle.replace(/^@/, "").toLowerCase();
        // Some posts have comments turned off; only flag comments when every post refuses them.
        let refused = 0;
        const lists = await mapLimit(recent, 4, async (post) => {
          const page = await part("comments", () =>
            social.comments.list(platformPostRef({ ...ref, postId: post.platformPostId }), { limit: COMMENTS_PER_POST }).catch((error: unknown) => {
              // A post deleted since it was listed has no comments to read; the rest still do.
              if (error instanceof SocialError && (error.code === "not_found" || error.code === "gone")) return { items: [] };
              throw error;
            }),
          );
          if (page === undefined) refused += 1;
          return (page?.items ?? []).flatMap((item) => {
            const comment = extractComment(item, now);
            if (comment === null) return [];
            const own =
              comment.authorId === account.platformAccountId ||
              comment.authorHandle?.replace(/^@/, "").toLowerCase() === ownHandle ||
              comment.authorName?.toLowerCase() === account.displayName.toLowerCase();
            if (own) return [];
            return [
              {
                platformPostId: post.platformPostId,
                platformCommentId: comment.id,
                ...(comment.parentId ? { parentId: comment.parentId } : {}),
                authorName: comment.authorName ?? comment.authorHandle ?? "Someone",
                ...(comment.authorHandle ? { authorHandle: comment.authorHandle } : {}),
                text: comment.text,
                publishedAt: comment.publishedAt,
                ...(comment.likeCount !== undefined ? { likeCount: comment.likeCount } : {}),
              },
            ];
          });
        });
        if (recent.length === 0) limited.push(...(account.limited ?? []).filter((name) => name === "comments"));
        else if (refused < recent.length) limited.splice(0, limited.length, ...limited.filter((name) => name !== "comments"));
        for (const batch of chunks(lists.flat(), 100)) {
          await ctx.runMutation(internal.ingest.comments, {
            accountId: account._id,
            platform,
            items: batch,
            ...(args.backfill ? { doneBefore: now - (adapter.id === "demo" ? 1 : 3) * DAY } : {}),
          });
        }
      }

      await ctx.runMutation(internal.accounts.finishSync, {
        accountId: account._id,
        limited: [...new Set(limited)],
        ...(followers !== undefined ? { followers } : {}),
      });
    } catch (error) {
      const { message, reconnect } = errorMessage(error);
      // The friendly message hides the cause; keep the platform's own error in the logs (no tokens in it).
      console.error(`sync ${platform}`, error instanceof SocialError ? `${error.code} ${error.operation ?? ""} ${error.message}` : String(error));
      await ctx.runMutation(internal.accounts.finishSync, { accountId: account._id, error: message, reconnect });
    }
    return null;
  },
});

export const sendReply = internalAction({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const target: { comment: Doc<"comments">; post: Doc<"posts"> } | null = await ctx.runQuery(
      internal.comments.replyTarget,
      { commentId: args.commentId },
    );
    if (target === null || target.comment.reply === undefined) return null;
    try {
      // Inside the try: a failed token refresh has to mark the reply failed, not leave it "sending".
      const loaded = await load(ctx, target.comment.accountId);
      if (loaded === null) return null;
      const { account, social } = loaded;
      await social.comments.reply(
        {
          ...platformPostRef({
            ...connectedAccountRef({ backend: "default", platform: account.platform, accountId: account.platformAccountId }),
            postId: target.post.platformPostId,
          }),
          kind: "comment",
          commentId: target.comment.platformCommentId,
        },
        { text: target.comment.reply.text },
      );
      await ctx.runMutation(internal.comments.replyResult, { commentId: args.commentId });
    } catch (error) {
      await ctx.runMutation(internal.comments.replyResult, {
        commentId: args.commentId,
        error: errorMessage(error).message,
      });
    }
    return null;
  },
});
