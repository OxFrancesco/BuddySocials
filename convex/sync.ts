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
import { adapterFor, openCredential, sealCredential, socialFor, supports } from "./social/client";
import { refreshIfNeeded } from "./social/oauth";
import type { DemoNative } from "./social/demo";
import { countersFrom, extractPost, followersFrom, type ExtractedPost } from "./social/extract";
import { addDays, dayKey } from "../shared/format";
import type { Platform } from "../shared/platforms";

const DAY = 86_400_000;
const POST_LIMIT = 50;
const COMMENT_WINDOW = 30 * DAY;
const COMMENTS_PER_POST = 50;
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

function errorMessage(error: unknown): { message: string; reconnect: boolean } {
  if (error instanceof SocialError) {
    const reconnect = error.code === "reconnect_required" || error.code === "unauthorized";
    const friendly: Record<string, string> = {
      reconnect_required: "Sign in to this account again.",
      unauthorized: "Sign in to this account again.",
      missing_permission: "The account did not grant a permission BuddySocials needs.",
      rate_limited: "The platform asked us to slow down. Trying again later.",
      unsupported_capability: "This platform does not offer that data.",
    };
    return { message: friendly[error.code] ?? error.message, reconnect };
  }
  return { message: error instanceof Error ? error.message : "Sync failed.", reconnect: false };
}

async function load(ctx: ActionCtx, accountId: Id<"accounts">) {
  const loaded: { account: Doc<"accounts">; sealed: { iv: string; ciphertext: string } | null } | null =
    await ctx.runQuery(internal.accounts.getInternal, { accountId });
  if (loaded === null) return null;
  let credential = loaded.sealed === null ? null : openCredential(loaded.sealed);
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
  return { account: loaded.account, adapter, social: socialFor(adapter) };
}

export const syncAccount = internalAction({
  args: { accountId: v.id("accounts"), backfill: v.boolean() },
  handler: async (ctx, args) => {
    const loaded = await load(ctx, args.accountId);
    if (loaded === null) return null;
    const { account, adapter, social } = loaded;
    const platform = account.platform;
    const manifest = adapter.capabilities;
    const ref = connectedAccountRef({ backend: "default", platform, accountId: account.platformAccountId });
    const now = Date.now();

    try {
      // 1. Days, when the platform reports them (YouTube Analytics; demo).
      const hasReport = supports(manifest, "analytics.report.read", platform);
      if (hasReport) {
        const names = REPORT_METRICS[adapter.id === "demo" ? "demo" : platform] ?? {};
        const today = dayKey(now);
        const report = await social.analytics.getReport(ref, {
          from: addDays(today, args.backfill ? -179 : -6),
          to: today,
          metrics: Object.keys(names),
          dimensions: ["day"],
        });
        const rows: DayRow[] = report.rows.flatMap((row) => {
          const day = row.dimensions["day"];
          if (typeof day !== "string") return [];
          const out: DayRow = { day, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers: 0 };
          for (const [name, key] of Object.entries(names)) {
            const value = row.metrics[name];
            if (typeof value === "number" && key !== "day") out[key] = value;
          }
          return [out];
        });
        for (const part of chunks(rows, 60)) {
          await ctx.runMutation(internal.ingest.days, { accountId: account._id, rows: part });
        }
      }

      // 2. Recent posts and their counters.
      const records: JsonObject[] = [];
      let cursor: string | undefined;
      while (records.length < POST_LIMIT) {
        const page = await social.posts.list(ref, { limit: 25, ...(cursor ? { cursor } : {}) });
        records.push(...page.items);
        if (!page.nextCursor || page.items.length === 0) break;
        cursor = page.nextCursor;
      }
      const posts = records
        .map((record) => extractPost(platform, record))
        .filter((post): post is ExtractedPost => post !== null)
        .slice(0, POST_LIMIT);

      const withMetrics = await mapLimit(posts, 5, async (post) => {
        let metrics: readonly MetricValue[] = [];
        try {
          metrics = await social.analytics.getPostMetrics(
            platformPostRef({ ...ref, postId: post.platformPostId }),
          );
        } catch (error) {
          if (!(error instanceof SocialError) || error.code === "reconnect_required") throw error;
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
      for (const part of chunks(withMetrics, CHUNK)) {
        await ctx.runMutation(internal.ingest.posts, {
          accountId: account._id,
          takenAt: now,
          deltaDaily: !hasReport,
          posts: part,
        });
      }

      // 3. Followers.
      let followers: number | undefined;
      if (supports(manifest, "analytics.account.read", platform)) {
        followers = followersFrom(await social.analytics.getAccountMetrics(ref));
        if (followers !== undefined) {
          await ctx.runMutation(internal.ingest.followers, { accountId: account._id, total: followers, takenAt: now });
        }
      }

      // 4. Comments on posts from the last 30 days.
      if (supports(manifest, "comments.read", platform)) {
        const recent = posts.filter((post) => now - post.publishedAt < COMMENT_WINDOW);
        const ownHandle = account.handle.replace(/^@/, "").toLowerCase();
        const lists = await mapLimit(recent, 4, async (post) => {
          const page = await social.comments.list(platformPostRef({ ...ref, postId: post.platformPostId }), {
            limit: COMMENTS_PER_POST,
          });
          return page.items.flatMap((item) => {
            const id = typeof item.id === "string" ? item.id : undefined;
            const text = typeof item.text === "string" ? item.text : undefined;
            const created = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
            if (!id || !text || !Number.isFinite(created)) return [];
            const handle = typeof item.authorHandle === "string" ? item.authorHandle : undefined;
            if (handle !== undefined && handle.replace(/^@/, "").toLowerCase() === ownHandle) return [];
            const likes = item["likeCount"];
            return [
              {
                platformPostId: post.platformPostId,
                platformCommentId: id,
                ...(typeof item.parentId === "string" ? { parentId: item.parentId } : {}),
                authorName: (typeof item.authorName === "string" ? item.authorName : handle) ?? "Someone",
                ...(handle !== undefined ? { authorHandle: handle } : {}),
                text,
                publishedAt: created,
                ...(typeof likes === "number" ? { likeCount: likes } : {}),
              },
            ];
          });
        });
        for (const part of chunks(lists.flat(), 100)) {
          await ctx.runMutation(internal.ingest.comments, {
            accountId: account._id,
            platform,
            items: part,
            ...(args.backfill ? { doneBefore: now - (adapter.id === "demo" ? 1 : 3) * DAY } : {}),
          });
        }
      }

      await ctx.runMutation(internal.accounts.finishSync, {
        accountId: account._id,
        ...(followers !== undefined ? { followers } : {}),
      });
    } catch (error) {
      const { message, reconnect } = errorMessage(error);
      await ctx.runMutation(internal.accounts.finishSync, { accountId: account._id, error: message, reconnect });
    }
    return null;
  },
});

/** Hourly. X is billed per read, so X accounts sync every three hours. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const accounts: Doc<"accounts">[] = await ctx.runQuery(internal.accounts.listAllInternal, {});
    const now = Date.now();
    for (const account of accounts) {
      if (account.status === "reconnect") continue;
      const every = account.platform === "x" && account.source === "direct" ? 3 * 3_600_000 : 50 * 60_000;
      if (account.lastSyncedAt !== undefined && now - account.lastSyncedAt < every) continue;
      await ctx.scheduler.runAfter(0, internal.sync.syncAccount, { accountId: account._id, backfill: false });
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
    const loaded = await load(ctx, target.comment.accountId);
    if (loaded === null) return null;
    const { account, social } = loaded;
    try {
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
