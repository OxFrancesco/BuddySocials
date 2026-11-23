import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { enforceRateLimit } from "./lib/rateLimits";
import { discard, hold, release, uploadFor } from "./media";
import {
  accountIssues,
  COVER_TYPE,
  MAX_COVER_BYTES,
  MAX_DRAFT_MEDIA,
  MAX_DRAFT_TEXT,
  postingIssues,
  textForPlatform,
  YOUTUBE_TITLE_LIMIT,
  YOUTUBE_VISIBILITY,
  type YoutubeVisibility,
} from "../shared/drafts";
import { isPlatform } from "../shared/platforms";

const mediaValidator = v.object({
  storageId: v.id("_storage"),
  kind: v.union(v.literal("image"), v.literal("video")),
  mimeType: v.string(),
  byteSize: v.number(),
  filename: v.optional(v.string()),
});

const youtubeVisibilityValidator = v.union(v.literal("public"), v.literal("unlisted"), v.literal("private"));
const platformTextValidator = v.record(v.string(), v.string());

const saveArgs = {
  /** Omit to create a draft. */
  draftId: v.optional(v.id("drafts")),
  /** Optional working title (and YouTube video title). Null clears it; omit to leave unchanged. */
  title: v.optional(v.union(v.null(), v.string())),
  text: v.string(),
  /** Optional per-platform copy overrides. Null clears all overrides; omit to leave unchanged. */
  platformText: v.optional(v.union(v.null(), platformTextValidator)),
  /** YouTube upload visibility. Null resets to default; omit to leave unchanged. */
  youtubeVisibility: v.optional(v.union(v.null(), youtubeVisibilityValidator)),
  accountIds: v.array(v.id("accounts")),
  media: v.optional(v.array(mediaValidator)),
  /** An uploaded JPEG to show before the video plays. Null takes the cover off; omit it to leave the cover as it is. */
  cover: v.optional(v.union(v.null(), v.id("_storage"))),
  /** Optional linked Claude Code Studio session ID. */
  claudeSessionId: v.optional(v.union(v.null(), v.string())),
};

type Status = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed";

/** A post takes at most ten minutes to send. One still marked as going after this long was cut off part way. */
const STALLED_MS = 15 * 60_000;
const STALLED = "Publishing stopped part way. Check the platform, then publish again.";

/** Where a delivery stands now: a cut-off one counts as failed, so the draft can be edited and sent again. */
function settled(delivery: Doc<"draftDeliveries">, now: number): { state: Doc<"draftDeliveries">["state"]; error: string | null } {
  const going = delivery.state === "queued" || delivery.state === "sending";
  if (going && now - delivery.updatedAt > STALLED_MS) return { state: "failed", error: STALLED };
  return { state: delivery.state, error: delivery.error ?? null };
}

function statusOf(targets: number, deliveries: Doc<"draftDeliveries">[], scheduledFor: number | undefined, now: number): Status {
  if (deliveries.length === 0) return scheduledFor !== undefined ? "scheduled" : "draft";
  const states = deliveries.map((delivery) => settled(delivery, now).state);
  if (states.some((state) => state === "queued" || state === "sending")) return "publishing";
  const published = states.filter((state) => state === "published").length;
  if (published === 0) return scheduledFor !== undefined ? "scheduled" : "failed";
  return published >= targets ? "published" : "partial";
}

async function hydrateDraft(ctx: QueryCtx, draft: Doc<"drafts">, accounts: Doc<"accounts">[], now: number) {
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draft._id))
    .take(40);
  const targets = draft.accountIds.flatMap((accountId) => {
    const account = accounts.find((candidate) => candidate._id === accountId);
    if (!account) return [];
    const delivery = deliveries.find((candidate) => candidate.accountId === accountId);
    const current = delivery ? settled(delivery, now) : null;
    const effectiveText = textForPlatform(draft.text, account.platform, draft.platformText);
    return [
      {
        accountId,
        platform: account.platform,
        handle: account.handle,
        text: effectiveText,
        issues:
          current?.state === "published"
            ? []
            : postingIssues(account, draft.text, draft.media, { platformText: draft.platformText, title: draft.title }),
        state: current?.state ?? null,
        permalink: delivery?.permalink ?? null,
        platformPostId: delivery?.platformPostId ?? null,
        error: current?.error ?? null,
      },
    ];
  });
  return {
    _id: draft._id,
    title: draft.title ?? null,
    text: draft.text,
    platformText: draft.platformText ?? {},
    youtubeVisibility: draft.youtubeVisibility ?? YOUTUBE_VISIBILITY,
    media: await Promise.all(
      draft.media.map(async (item) => ({ ...item, filename: item.filename ?? null, url: await ctx.storage.getUrl(item.storageId) })),
    ),
    cover: draft.cover ? { storageId: draft.cover.storageId, url: await ctx.storage.getUrl(draft.cover.storageId) } : null,
    targets,
    status: statusOf(targets.length, deliveries, draft.scheduledFor, now),
    scheduledFor: draft.scheduledFor ?? null,
    claudeSessionId: draft.claudeSessionId ?? null,
    updatedAt: draft.updatedAt,
  };
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
  return await Promise.all(drafts.map((draft) => hydrateDraft(ctx, draft, accounts, now)));
}

function normalizePlatformText(input: Record<string, string> | null | undefined): Record<string, string> | undefined {
  if (!input) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isPlatform(key)) throw new Error(`Unknown platform override: ${key}.`);
    if (value.length > MAX_DRAFT_TEXT) throw new Error(`${key} text holds up to ${MAX_DRAFT_TEXT} characters.`);
    if (value.trim().length > 0) cleaned[key] = value;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

async function cancelJob(ctx: MutationCtx, jobId: Id<"_scheduled_functions"> | undefined) {
  if (jobId === undefined) return;
  try {
    await ctx.scheduler.cancel(jobId);
  } catch {
    // Already ran or was cancelled earlier.
  }
}

async function saveFor(
  ctx: MutationCtx,
  owner: string,
  args: {
    draftId?: Id<"drafts">;
    title?: string | null;
    text: string;
    platformText?: Record<string, string> | null;
    youtubeVisibility?: YoutubeVisibility | null;
    accountIds: Id<"accounts">[];
    media?: Doc<"drafts">["media"];
    cover?: Id<"_storage"> | null;
    claudeSessionId?: string | null;
  },
): Promise<Id<"drafts">> {
  if (args.text.length > MAX_DRAFT_TEXT) throw new Error(`A draft holds up to ${MAX_DRAFT_TEXT} characters.`);
  if (args.title && [...args.title.trim()].length > YOUTUBE_TITLE_LIMIT * 2) {
    throw new Error(`Title holds up to ${YOUTUBE_TITLE_LIMIT * 2} characters.`);
  }
  if (args.media && args.media.length > MAX_DRAFT_MEDIA) throw new Error(`A draft holds up to ${MAX_DRAFT_MEDIA} attachments.`);
  const accountIds = [...new Set(args.accountIds)];
  for (const accountId of accountIds) {
    const account = await ctx.db.get("accounts", accountId);
    if (account === null || account.owner !== owner) throw new Error("Account not found.");
  }
  const now = Date.now();
  const draft = args.draftId === undefined ? null : await ctx.db.get("drafts", args.draftId);
  if (args.draftId !== undefined && (draft === null || draft.owner !== owner)) throw new Error("Draft not found.");
  const cleanedTitle = args.title === undefined ? undefined : args.title === null || !args.title.trim() ? null : args.title.trim();
  const cleanedPlatformText = args.platformText === undefined ? undefined : args.platformText === null ? null : normalizePlatformText(args.platformText) ?? null;
  const cleanedSession =
    args.claudeSessionId === undefined ? undefined : args.claudeSessionId === null || !args.claudeSessionId.trim() ? null : args.claudeSessionId.trim();

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
      ...(cleanedTitle ? { title: cleanedTitle } : {}),
      text: args.text,
      ...(cleanedPlatformText ? { platformText: cleanedPlatformText } : {}),
      ...(args.youtubeVisibility ? { youtubeVisibility: args.youtubeVisibility } : {}),
      media: media ?? [],
      ...(cover ? { cover } : {}),
      accountIds,
      ...(cleanedSession ? { claudeSessionId: cleanedSession } : {}),
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
    ...(cleanedTitle !== undefined ? { title: cleanedTitle ?? undefined } : {}),
    text: args.text,
    ...(cleanedPlatformText !== undefined ? { platformText: cleanedPlatformText ?? undefined } : {}),
    ...(args.youtubeVisibility !== undefined ? { youtubeVisibility: args.youtubeVisibility ?? undefined } : {}),
    accountIds: [...new Set([...sent, ...accountIds])],
    ...(media ? { media } : {}),
    ...(cover !== undefined ? { cover: cover ?? undefined } : {}),
    ...(cleanedSession !== undefined ? { claudeSessionId: cleanedSession ?? undefined } : {}),
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
  await cancelJob(ctx, draft.scheduledJobId);
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .take(40);
  for (const delivery of deliveries) await ctx.db.delete("draftDeliveries", delivery._id);
  for (const item of draft.media) await discard(ctx, item.storageId);
  if (draft.cover) await discard(ctx, draft.cover.storageId);
  await ctx.db.delete("drafts", draftId);
}

/** Queues the draft for every account it hasn't reached yet (or only `onlyAccountIds` when provided). */
async function publishFor(
  ctx: MutationCtx,
  owner: string,
  draftId: Id<"drafts">,
  onlyAccountIds?: Id<"accounts">[],
): Promise<number> {
  const draft = await ctx.db.get("drafts", draftId);
  if (draft === null || draft.owner !== owner) throw new Error("Draft not found.");
  if (draft.accountIds.length === 0) throw new Error("Choose at least one account to post to.");
  const filter = onlyAccountIds && onlyAccountIds.length > 0 ? new Set(onlyAccountIds) : null;
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .take(40);
  const started = Date.now();
  const pending: { account: Doc<"accounts">; delivery: Doc<"draftDeliveries"> | undefined }[] = [];
  for (const accountId of draft.accountIds) {
    if (filter !== null && !filter.has(accountId)) continue;
    const delivery = deliveries.find((candidate) => candidate.accountId === accountId);
    if (delivery && settled(delivery, started).state !== "failed") continue;
    const account = await ctx.db.get("accounts", accountId);
    if (account === null || account.owner !== owner) continue;
    const issues = postingIssues(account, draft.text, draft.media, { platformText: draft.platformText, title: draft.title });
    // Nothing is sent unless every remaining account can take the post, so a draft never goes out half-checked.
    if (issues.length > 0) throw new Error(`${account.handle}: ${issues[0]}`);
    pending.push({ account, delivery });
  }
  if (draft.scheduledJobId !== undefined && filter === null) {
    await cancelJob(ctx, draft.scheduledJobId);
    await ctx.db.patch("drafts", draft._id, { scheduledFor: undefined, scheduledJobId: undefined, updatedAt: started });
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

async function scheduleFor(ctx: MutationCtx, owner: string, draftId: Id<"drafts">, at: number): Promise<Id<"_scheduled_functions">> {
  const now = Date.now();
  if (!Number.isFinite(at) || at <= now + 10_000) throw new Error("Choose a time in the future.");
  const draft = await ctx.db.get("drafts", draftId);
  if (draft === null || draft.owner !== owner) throw new Error("Draft not found.");
  if (draft.accountIds.length === 0) throw new Error("Choose at least one account to post to.");
  const deliveries = await ctx.db
    .query("draftDeliveries")
    .withIndex("by_draft", (q) => q.eq("draftId", draftId))
    .take(40);
  let remaining = 0;
  for (const accountId of draft.accountIds) {
    const delivery = deliveries.find((candidate) => candidate.accountId === accountId);
    if (delivery && settled(delivery, now).state !== "failed") continue;
    const account = await ctx.db.get("accounts", accountId);
    if (account === null || account.owner !== owner) continue;
    const issues = postingIssues(account, draft.text, draft.media, { platformText: draft.platformText, title: draft.title });
    if (issues.length > 0) throw new Error(`${account.handle}: ${issues[0]}`);
    remaining += 1;
  }
  if (remaining === 0) throw new Error("This draft has already been published to every target account.");
  await cancelJob(ctx, draft.scheduledJobId);
  const jobId = await ctx.scheduler.runAt(at, internal.drafts.runScheduledPublish, { owner, draftId });
  await ctx.db.patch("drafts", draftId, { scheduledFor: at, scheduledJobId: jobId, updatedAt: now });
  return jobId;
}

async function cancelScheduleFor(ctx: MutationCtx, owner: string, draftId: Id<"drafts">) {
  const draft = await ctx.db.get("drafts", draftId);
  if (draft === null || draft.owner !== owner) throw new Error("Draft not found.");
  await cancelJob(ctx, draft.scheduledJobId);
  await ctx.db.patch("drafts", draftId, { scheduledFor: undefined, scheduledJobId: undefined, updatedAt: Date.now() });
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
  args: { draftId: v.id("drafts"), accountIds: v.optional(v.array(v.id("accounts"))) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    await enforceRateLimit(ctx, "publish", owner);
    return await publishFor(ctx, owner, args.draftId, args.accountIds);
  },
});

export const schedule = mutation({
  args: { draftId: v.id("drafts"), at: v.number() },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    await enforceRateLimit(ctx, "publish", owner);
    await scheduleFor(ctx, owner, args.draftId, args.at);
    return null;
  },
});

export const cancelSchedule = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    await cancelScheduleFor(ctx, await requireOwner(ctx), args.draftId);
    return null;
  },
});

/** Where a client uploads an image before saving it on a draft. Valid for one hour. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await enforceRateLimit(ctx, "uploadUrl", await requireOwner(ctx));
    return await ctx.storage.generateUploadUrl();
  },
});

// The MCP server has already verified who is calling, so these take the owner directly.

export const listInternal = internalQuery({
  args: { owner: v.string() },
  handler: async (ctx, args) => listFor(ctx, args.owner),
});

export const getInternal = internalQuery({
  args: { owner: v.string(), draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get("drafts", args.draftId);
    if (draft === null || draft.owner !== args.owner) return null;
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("owner", args.owner))
      .take(20);
    return await hydrateDraft(ctx, draft, accounts, Date.now());
  },
});

export const saveInternal = internalMutation({
  /** `mediaIds` names uploads by their storage ID; omit it to leave a draft's attachments as they are. */
  args: {
    owner: v.string(),
    draftId: saveArgs.draftId,
    title: saveArgs.title,
    text: saveArgs.text,
    platformText: saveArgs.platformText,
    youtubeVisibility: saveArgs.youtubeVisibility,
    accountIds: saveArgs.accountIds,
    mediaIds: v.optional(v.array(v.id("_storage"))),
    cover: saveArgs.cover,
    claudeSessionId: saveArgs.claudeSessionId,
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
  args: { owner: v.string(), draftId: v.id("drafts"), accountIds: v.optional(v.array(v.id("accounts"))) },
  handler: async (ctx, args) => {
    await enforceRateLimit(ctx, "publish", args.owner);
    return await publishFor(ctx, args.owner, args.draftId, args.accountIds);
  },
});

export const runScheduledPublish = internalMutation({
  args: { owner: v.string(), draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    const draft = await ctx.db.get("drafts", args.draftId);
    if (draft === null || draft.owner !== args.owner) return null;
    await ctx.db.patch("drafts", args.draftId, { scheduledFor: undefined, scheduledJobId: undefined, updatedAt: Date.now() });
    await publishFor(ctx, args.owner, args.draftId);
    return null;
  },
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
      displayName: account.displayName,
      status: account.status,
      canPost: accountIssues(account).length === 0,
      issues: accountIssues(account),
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
    await enforceRateLimit(ctx, "publish", args.owner);
    return await scheduleFor(ctx, args.owner, args.draftId, args.at);
  },
});

export const cancelScheduleInternal = internalMutation({
  args: { owner: v.string(), draftId: v.id("drafts") },
  handler: async (ctx, args) => {
    await cancelScheduleFor(ctx, args.owner, args.draftId);
    return null;
  },
});

/** Makes a YouTube video public later, at `at`. */
export const scheduleYouTubePublicInternal = internalMutation({
  args: { accountId: v.id("accounts"), videoId: v.string(), at: v.number() },
  handler: async (ctx, args): Promise<Id<"_scheduled_functions">> =>
    await ctx.scheduler.runAt(args.at, internal.publish.updateYouTube, { accountId: args.accountId, videoId: args.videoId, visibility: "public" }),
});
