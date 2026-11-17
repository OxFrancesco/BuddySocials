import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { discard, hold, release, uploadFor } from "./media";
import { accountIssues, COVER_TYPE, MAX_COVER_BYTES, MAX_DRAFT_MEDIA, MAX_DRAFT_TEXT, postingIssues } from "../shared/drafts";

const mediaValidator = v.object({
  storageId: v.id("_storage"),
  kind: v.union(v.literal("image"), v.literal("video")),
  mimeType: v.string(),
  byteSize: v.number(),
  filename: v.optional(v.string()),
});

const saveArgs = {
  /** Omit to create a draft. */
  draftId: v.optional(v.id("drafts")),
  text: v.string(),
  accountIds: v.array(v.id("accounts")),
  media: v.optional(v.array(mediaValidator)),
  /** An uploaded JPEG to show before the video plays. Null takes the cover off; omit it to leave the cover as it is. */
  cover: v.optional(v.union(v.null(), v.id("_storage"))),
};

type Status = "draft" | "publishing" | "published" | "partial" | "failed";

/** A post takes at most ten minutes to send. One still marked as going after this long was cut off part way. */
const STALLED_MS = 15 * 60_000;
const STALLED = "Publishing stopped part way. Check the platform, then publish again.";

/** Where a delivery stands now: a cut-off one counts as failed, so the draft can be edited and sent again. */
function settled(delivery: Doc<"draftDeliveries">, now: number): { state: Doc<"draftDeliveries">["state"]; error: string | null } {
  const going = delivery.state === "queued" || delivery.state === "sending";
  if (going && now - delivery.updatedAt > STALLED_MS) return { state: "failed", error: STALLED };
  return { state: delivery.state, error: delivery.error ?? null };
}

function statusOf(targets: number, deliveries: Doc<"draftDeliveries">[], now: number): Status {
  if (deliveries.length === 0) return "draft";
  const states = deliveries.map((delivery) => settled(delivery, now).state);
  if (states.some((state) => state === "queued" || state === "sending")) return "publishing";
  const published = states.filter((state) => state === "published").length;
  if (published === 0) return "failed";
  return published >= targets ? "published" : "partial";
}

/** The owner's drafts, newest first, each with where it goes and what happened there. */
async function listFor(ctx: QueryCtx, owner: string) {
  const drafts = await ctx.db
    .query("drafts")
    .withIndex("by_owner_and_updatedAt", (q) => q.eq("owner", owner))
    .order("desc")
    .take(100);
  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .take(20);
  const now = Date.now();
  return await Promise.all(
    drafts.map(async (draft) => {
      const deliveries = await ctx.db
        .query("draftDeliveries")
        .withIndex("by_draft", (q) => q.eq("draftId", draft._id))
        .take(40);
      const targets = draft.accountIds.flatMap((accountId) => {
        const account = accounts.find((candidate) => candidate._id === accountId);
        if (!account) return [];
        const delivery = deliveries.find((candidate) => candidate.accountId === accountId);
        const current = delivery ? settled(delivery, now) : null;
        return [
          {
            accountId,
            platform: account.platform,
            handle: account.handle,
            issues: current?.state === "published" ? [] : postingIssues(account, draft.text, draft.media),
            state: current?.state ?? null,
            permalink: delivery?.permalink ?? null,
            error: current?.error ?? null,
          },
        ];
      });
      return {
        _id: draft._id,
        text: draft.text,
        media: await Promise.all(
          draft.media.map(async (item) => ({ ...item, filename: item.filename ?? null, url: await ctx.storage.getUrl(item.storageId) })),
        ),
        cover: draft.cover ? { storageId: draft.cover.storageId, url: await ctx.storage.getUrl(draft.cover.storageId) } : null,
        targets,
        status: statusOf(targets.length, deliveries, now),
        updatedAt: draft.updatedAt,
      };
    }),
  );
}

async function saveFor(
  ctx: MutationCtx,
  owner: string,
  args: { draftId?: Id<"drafts">; text: string; accountIds: Id<"accounts">[]; media?: Doc<"drafts">["media"]; cover?: Id<"_storage"> | null },
): Promise<Id<"drafts">> {
  if (args.text.length > MAX_DRAFT_TEXT) throw new Error(`A draft holds up to ${MAX_DRAFT_TEXT} characters.`);
  if (args.media && args.media.length > MAX_DRAFT_MEDIA) throw new Error(`A draft holds up to ${MAX_DRAFT_MEDIA} attachments.`);
  const accountIds = [...new Set(args.accountIds)];
  for (const accountId of accountIds) {
    const account = await ctx.db.get("accounts", accountId);
    if (account === null || account.owner !== owner) throw new Error("Account not found.");
  }
  const now = Date.now();
  const draft = args.draftId === undefined ? null : await ctx.db.get("drafts", args.draftId);
  if (args.draftId !== undefined && (draft === null || draft.owner !== owner)) throw new Error("Draft not found.");
  // Each attachment must be a file this person uploaded, and its type and size are the server's own record.
  let media: Doc<"drafts">["media"] | undefined;
  const uploads: Doc<"uploads">[] = [];
  if (args.media) {
    media = [];
    for (const item of args.media) {
      const kept = draft?.media.find((existing) => existing.storageId === item.storageId);
      const upload = await uploadFor(ctx, item.storageId);
      if (upload === null) {
        // Attached before uploads were tracked.
        if (!kept) throw new Error("An attachment is missing. Add it again.");
        media.push(kept);
        continue;
      }
      if (upload.owner !== owner) throw new Error("An attachment is missing. Add it again.");
      if (upload.draftId !== undefined && upload.draftId !== draft?._id) throw new Error("That file is already on another draft. Add it again to use it here.");
      uploads.push(upload);
      media.push({
        storageId: upload.storageId,
        kind: upload.kind,
        mimeType: upload.mimeType,
        byteSize: upload.byteSize,
        ...(upload.filename ? { filename: upload.filename } : {}),
      });
    }
  }
  // A cover is one of this person's uploads too. Undefined leaves the draft's cover alone; null takes it off.
  let cover: Doc<"drafts">["cover"] | null | undefined;
  if (args.cover === null) cover = null;
  else if (args.cover !== undefined && args.cover !== draft?.cover?.storageId) {
    const upload = await uploadFor(ctx, args.cover);
    if (upload === null || upload.owner !== owner) throw new Error("The cover is missing. Add it again.");
    if (upload.draftId !== undefined && upload.draftId !== draft?._id) throw new Error("That cover is already on another draft. Add it again to use it here.");
    if (upload.mimeType !== COVER_TYPE) throw new Error("A cover has to be a JPEG image.");
    if (upload.byteSize > MAX_COVER_BYTES) throw new Error("A cover can be up to 2 MB.");
    if (media?.some((item) => item.storageId === upload.storageId)) throw new Error("The cover can't also be an attachment.");
    uploads.push(upload);
    cover = { storageId: upload.storageId, mimeType: upload.mimeType, byteSize: upload.byteSize };
  }
  if (draft === null) {
    const draftId = await ctx.db.insert("drafts", {
      owner,
      text: args.text,
      media: media ?? [],
      ...(cover ? { cover } : {}),
      accountIds,
      createdAt: now,
      updatedAt: now,
    });
    for (const upload of uploads) await hold(ctx, upload, draftId);
    return draftId;
  }
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draft._id))
    .take(40);
  if (deliveries.some((delivery) => ["queued", "sending"].includes(settled(delivery, now).state))) {
    throw new Error("This draft is being published. Wait for it to finish.");
  }
  // What already went out stays as it was posted; only the text for the remaining accounts changes.
  const sent = deliveries.filter((delivery) => delivery.state === "published").map((delivery) => delivery.accountId);
  await ctx.db.patch("drafts", draft._id, {
    text: args.text,
    accountIds: [...new Set([...sent, ...accountIds])],
    ...(media ? { media } : {}),
    ...(cover !== undefined ? { cover: cover ?? undefined } : {}),
    updatedAt: now,
  });
  for (const upload of uploads) if (upload.draftId === undefined) await hold(ctx, upload, draft._id);
  if (cover !== undefined && draft.cover) await release(ctx, owner, { ...draft.cover, kind: "image" });
  if (cover) {
    // A video already on YouTube gets the new cover as its thumbnail.
    for (const delivery of deliveries) {
      if (delivery.platform === "youtube" && delivery.state === "published" && delivery.platformPostId) {
        await ctx.scheduler.runAfter(0, internal.publish.applyCover, { deliveryId: delivery._id });
      }
    }
  }
  if (media) {
    // Anything taken off the draft waits for cleanup instead of staying in storage for good.
    for (const item of draft.media) {
      if (!media.some((next) => next.storageId === item.storageId)) await release(ctx, owner, item);
    }
  }
  return draft._id;
}

async function removeFor(ctx: MutationCtx, owner: string, draftId: Id<"drafts">) {
  const draft = await ctx.db.get("drafts", draftId);
  if (draft === null || draft.owner !== owner) return;
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .take(40);
  for (const delivery of deliveries) await ctx.db.delete("draftDeliveries", delivery._id);
  for (const item of draft.media) await discard(ctx, item.storageId);
  if (draft.cover) await discard(ctx, draft.cover.storageId);
  await ctx.db.delete("drafts", draftId);
}

/** Queues the draft for every account it hasn't reached yet. Returns how many posts were queued. */
async function publishFor(ctx: MutationCtx, owner: string, draftId: Id<"drafts">): Promise<number> {
  const draft = await ctx.db.get("drafts", draftId);
  if (draft === null || draft.owner !== owner) throw new Error("Draft not found.");
  if (draft.accountIds.length === 0) throw new Error("Choose at least one account to post to.");
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .take(40);
  const started = Date.now();
  const pending: { account: Doc<"accounts">; delivery: Doc<"draftDeliveries"> | undefined }[] = [];
  for (const accountId of draft.accountIds) {
    const delivery = deliveries.find((candidate) => candidate.accountId === accountId);
    if (delivery && settled(delivery, started).state !== "failed") continue;
    const account = await ctx.db.get("accounts", accountId);
    if (account === null || account.owner !== owner) continue;
    const issues = postingIssues(account, draft.text, draft.media);
    // Nothing is sent unless every remaining account can take the post, so a draft never goes out half-checked.
    if (issues.length > 0) throw new Error(`${account.handle}: ${issues[0]}`);
    pending.push({ account, delivery });
  }
  const now = Date.now();
  for (const { account, delivery } of pending) {
    const deliveryId =
      delivery?._id ??
      (await ctx.db.insert("draftDeliveries", { owner, draftId, accountId: account._id, platform: account.platform, state: "queued", updatedAt: now }));
    if (delivery) await ctx.db.patch("draftDeliveries", delivery._id, { state: "queued", error: undefined, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.publish.deliver, { deliveryId });
  }
  return pending.length;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await optionalOwner(ctx);
    return owner === null ? [] : await listFor(ctx, owner);
  },
});

export const save = mutation({
  args: saveArgs,
  handler: async (ctx, args) => saveFor(ctx, await requireOwner(ctx), args),
});

export const remove = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => removeFor(ctx, await requireOwner(ctx), args.draftId),
});

export const publish = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => publishFor(ctx, await requireOwner(ctx), args.draftId),
});

/** Where a client uploads an image before saving it on a draft. Valid for one hour. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// The MCP server has already verified who is calling, so these take the owner directly.

export const listInternal = internalQuery({
  args: { owner: v.string() },
  handler: async (ctx, args) => listFor(ctx, args.owner),
});

export const saveInternal = internalMutation({
  /** `mediaIds` names uploads by their storage ID; omit it to leave a draft's attachments as they are. */
  args: {
    owner: v.string(),
    draftId: saveArgs.draftId,
    text: saveArgs.text,
    accountIds: saveArgs.accountIds,
    mediaIds: v.optional(v.array(v.id("_storage"))),
    cover: saveArgs.cover,
  },
  handler: async (ctx, { owner, mediaIds, ...args }) =>
    // saveFor replaces these with the server's own record of each upload.
    saveFor(ctx, owner, {
      ...args,
      ...(mediaIds ? { media: mediaIds.map((storageId) => ({ storageId, kind: "image" as const, mimeType: "", byteSize: 0 })) } : {}),
    }),
});

export const removeInternal = internalMutation({
  args: { owner: v.string(), draftId: v.id("drafts") },
  handler: async (ctx, args) => removeFor(ctx, args.owner, args.draftId),
});

export const publishInternal = internalMutation({
  args: { owner: v.string(), draftId: v.id("drafts") },
  handler: async (ctx, args) => publishFor(ctx, args.owner, args.draftId),
});

export const accountsInternal = internalQuery({
  args: { owner: v.string() },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(20);
    return accounts.map((account) => ({
      accountId: account._id,
      platform: account.platform,
      handle: account.handle,
      canPost: accountIssues(account).length === 0,
    }));
  },
});

export const deliveryInternal = internalQuery({
  args: { deliveryId: v.id("draftDeliveries") },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get("draftDeliveries", args.deliveryId);
    if (delivery === null) return null;
    const draft = await ctx.db.get("drafts", delivery.draftId);
    return draft === null ? null : { delivery, draft };
  },
});

export const recordDelivery = internalMutation({
  args: {
    deliveryId: v.id("draftDeliveries"),
    state: v.union(v.literal("sending"), v.literal("published"), v.literal("failed")),
    permalink: v.optional(v.string()),
    platformPostId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { deliveryId, ...fields }) => {
    const delivery = await ctx.db.get("draftDeliveries", deliveryId);
    if (delivery === null) return;
    await ctx.db.patch("draftDeliveries", deliveryId, { ...fields, updatedAt: Date.now() });
  },
});

/**
 * Publishes a draft later, at `at` (milliseconds since 1970), so a batch of posts goes out spaced apart.
 * The checks run again at that time, so a post that can no longer go out fails then instead of being sent.
 */
export const scheduleInternal = internalMutation({
  args: { owner: v.string(), draftId: v.id("drafts"), at: v.number() },
  handler: async (ctx, args): Promise<Id<"_scheduled_functions">> => {
    const draft = await ctx.db.get("drafts", args.draftId);
    if (draft === null || draft.owner !== args.owner) throw new Error("Draft not found.");
    return await ctx.scheduler.runAt(args.at, internal.drafts.publishInternal, { owner: args.owner, draftId: args.draftId });
  },
});

/** Makes a YouTube video public later, at `at`. */
export const scheduleYouTubePublicInternal = internalMutation({
  args: { accountId: v.id("accounts"), videoId: v.string(), at: v.number() },
  handler: async (ctx, args): Promise<Id<"_scheduled_functions">> =>
    await ctx.scheduler.runAt(args.at, internal.publish.updateYouTube, { accountId: args.accountId, videoId: args.videoId, visibility: "public" }),
});
