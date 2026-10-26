import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { platformValidator } from "./validators";

async function withPosts(ctx: QueryCtx, comments: Doc<"comments">[]) {
  const titles = new Map<string, { title: string | null; kind: string }>();
  for (const comment of comments) {
    if (titles.has(comment.postId)) continue;
    const post = await ctx.db.get("posts", comment.postId);
    titles.set(comment.postId, { title: post?.title ?? post?.text ?? null, kind: post?.kind ?? "post" });
  }
  return comments.map((comment) => ({
    _id: comment._id,
    postId: comment.postId,
    platform: comment.platform,
    authorName: comment.authorName,
    authorHandle: comment.authorHandle ?? null,
    text: comment.text,
    publishedAt: comment.publishedAt,
    likeCount: comment.likeCount ?? null,
    state: comment.state,
    reply: comment.reply ?? null,
    postTitle: titles.get(comment.postId)?.title ?? null,
  }));
}

export const list = query({
  args: {
    open: v.boolean(),
    platform: v.optional(platformValidator),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return { page: [], isDone: true, continueCursor: "" };
    const base = args.open
      ? ctx.db
          .query("comments")
          .withIndex("by_owner_and_state_and_publishedAt", (q) => q.eq("owner", owner).eq("state", "open"))
      : ctx.db.query("comments").withIndex("by_owner_and_publishedAt", (q) => q.eq("owner", owner));
    const filtered = args.platform === undefined ? base : base.filter((q) => q.eq(q.field("platform"), args.platform));
    const result = await filtered.order("desc").paginate(args.paginationOpts);
    return { ...result, page: await withPosts(ctx, result.page) };
  },
});

/** Open comments, capped at 100 so the badge can say "99+". */
export const openSummary = query({
  args: { platform: v.optional(platformValidator) },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return { count: 0, latest: [] };
    const open = await ctx.db
      .query("comments")
      .withIndex("by_owner_and_state_and_publishedAt", (q) => q.eq("owner", owner).eq("state", "open"))
      .order("desc")
      .take(100);
    const matching = args.platform === undefined ? open : open.filter((c) => c.platform === args.platform);
    return { count: matching.length, latest: await withPosts(ctx, matching.slice(0, 4)) };
  },
});

export const forPost = query({
  args: { postId: v.id("posts") },
  handler: async (ctx, args) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return [];
    const post = await ctx.db.get("posts", args.postId);
    if (post === null || post.owner !== owner) return [];
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_post_and_publishedAt", (q) => q.eq("postId", args.postId))
      .order("desc")
      .take(100);
    return await withPosts(ctx, comments);
  },
});

export const reply = mutation({
  args: { commentId: v.id("comments"), text: v.string() },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const text = args.text.trim();
    if (text.length === 0) throw new Error("Write a reply first.");
    if (text.length > 2000) throw new Error("That reply is too long.");
    const comment = await ctx.db.get("comments", args.commentId);
    if (comment === null || comment.owner !== owner) throw new Error("Comment not found.");
    if (comment.reply?.status === "sending") return;
    await ctx.db.patch("comments", comment._id, {
      state: "replied",
      reply: { text, at: Date.now(), status: "sending" },
    });
    await ctx.scheduler.runAfter(0, internal.sync.sendReply, { commentId: comment._id });
  },
});

export const setDone = mutation({
  args: { commentId: v.id("comments"), done: v.boolean() },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const comment = await ctx.db.get("comments", args.commentId);
    if (comment === null || comment.owner !== owner) throw new Error("Comment not found.");
    if (comment.reply !== undefined && comment.reply.status !== "failed") return;
    await ctx.db.patch("comments", comment._id, { state: args.done ? "done" : "open" });
  },
});

export const replyTarget = internalQuery({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get("comments", args.commentId);
    if (comment === null) return null;
    const post = await ctx.db.get("posts", comment.postId);
    if (post === null) return null;
    return { comment, post };
  },
});

export const replyResult = internalMutation({
  args: { commentId: v.id("comments"), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get("comments", args.commentId);
    if (comment === null || comment.reply === undefined) return;
    await ctx.db.patch("comments", comment._id, {
      state: args.error === undefined ? "replied" : "open",
      reply: {
        ...comment.reply,
        status: args.error === undefined ? "sent" : "failed",
        ...(args.error !== undefined ? { error: args.error } : {}),
      },
    });
  },
});
