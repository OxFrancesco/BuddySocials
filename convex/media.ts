import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalOwner, requireOwner } from "./lib/owner";
import { CLEANUP_DAYS, DEFAULT_CLEANUP_DAYS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, mediaKindOf, type DraftMediaKind } from "../shared/drafts";

/**
 * Every file uploaded for a draft has a row here. A file is "unused" while no draft
 * holds it: picked and never saved, replaced by an edited copy, or removed from a
 * draft. Unused files are deleted after the owner's chosen number of days, or only
 * when they ask.
 */

const DAY_MS = 86_400_000;
const BATCH = 100;

/** Days an unused file is kept, or null when the owner cleans up by hand. */
export async function cleanupDays(ctx: QueryCtx, owner: string): Promise<number | null> {
  const settings = await ctx.db
    .query("settings")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .unique();
  return settings === null ? DEFAULT_CLEANUP_DAYS : settings.cleanupAfterDays;
}

function unusedFields(now: number, days: number | null) {
  return { draftId: undefined, unusedSince: now, expiresAt: days === null ? undefined : now + days * DAY_MS };
}

export async function uploadFor(ctx: QueryCtx, storageId: Id<"_storage">): Promise<Doc<"uploads"> | null> {
  return await ctx.db
    .query("uploads")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .unique();
}

/** Marks a file as held by a draft, so cleanup leaves it alone. */
export async function hold(ctx: MutationCtx, upload: Doc<"uploads">, draftId: Id<"drafts">) {
  await ctx.db.patch("uploads", upload._id, { draftId, unusedSince: undefined, expiresAt: undefined });
}

/** Marks a file a draft no longer holds as unused. Files from before uploads were tracked get their row here. */
export async function release(ctx: MutationCtx, owner: string, item: Doc<"drafts">["media"][number]) {
  const days = await cleanupDays(ctx, owner);
  const upload = await uploadFor(ctx, item.storageId);
  if (upload !== null) {
    await ctx.db.patch("uploads", upload._id, unusedFields(Date.now(), days));
    return;
  }
  await ctx.db.insert("uploads", {
    owner,
    storageId: item.storageId,
    kind: item.kind,
    mimeType: item.mimeType,
    byteSize: item.byteSize,
    ...(item.filename ? { filename: item.filename } : {}),
    ...unusedFields(Date.now(), days),
  });
}

/** Deletes a file and its row. */
export async function discard(ctx: MutationCtx, storageId: Id<"_storage">) {
  const upload = await uploadFor(ctx, storageId);
  if (upload !== null) await ctx.db.delete("uploads", upload._id);
  if ((await ctx.db.system.get("_storage", storageId)) !== null) await ctx.storage.delete(storageId);
}

/**
 * Registers a file the client just uploaded and returns what the server knows about it.
 * Its type and size come from storage, so a draft never holds numbers a client made up.
 */
export const attach = mutation({
  args: { storageId: v.id("_storage"), filename: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const existing = await uploadFor(ctx, args.storageId);
    if (existing !== null && existing.owner !== owner) throw new Error("File not found.");
    const file = await ctx.db.system.get("_storage", args.storageId);
    if (file === null) throw new Error("File not found.");
    const kind: DraftMediaKind | null = mediaKindOf(file.contentType ?? "");
    const tooBig = kind === "image" ? file.size > MAX_IMAGE_BYTES : file.size > MAX_VIDEO_BYTES;
    if (existing === null && (kind === null || tooBig)) {
      await ctx.storage.delete(args.storageId);
      if (kind === null) throw new Error("Only images and videos can be attached.");
      throw new Error(kind === "image" ? "Images can be up to 20 MB." : "Videos can be up to 200 MB. Trim it or export it smaller.");
    }
    const filename = args.filename?.trim().slice(0, 200) || undefined;
    const upload =
      existing ??
      (await ctx.db.get(
        "uploads",
        await ctx.db.insert("uploads", {
          owner,
          storageId: args.storageId,
          kind: kind!,
          mimeType: file.contentType!,
          byteSize: file.size,
          ...(filename ? { filename } : {}),
          ...unusedFields(Date.now(), await cleanupDays(ctx, owner)),
        }),
      ))!;
    return {
      storageId: upload.storageId,
      kind: upload.kind,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
      filename: upload.filename ?? null,
      url: await ctx.storage.getUrl(upload.storageId),
    };
  },
});

async function unusedFor(ctx: QueryCtx, owner: string) {
  return await ctx.db
    .query("uploads")
    .withIndex("by_owner_and_unusedSince", (q) => q.eq("owner", owner).gt("unusedSince", 0))
    .take(BATCH + 1);
}

/** The cleanup setting and how much unused media is waiting. `more` means the count stopped at 100. */
export const cleanup = query({
  args: {},
  handler: async (ctx) => {
    const owner = await optionalOwner(ctx);
    if (owner === null) return null;
    const unused = await unusedFor(ctx, owner);
    const shown = unused.slice(0, BATCH);
    return {
      afterDays: await cleanupDays(ctx, owner),
      options: CLEANUP_DAYS,
      files: shown.length,
      bytes: shown.reduce((sum, upload) => sum + upload.byteSize, 0),
      more: unused.length > BATCH,
    };
  },
});

/** Chooses when unused files are deleted: after 1, 7 or 30 days, or null for only by hand. */
export const setCleanup = mutation({
  args: { afterDays: v.union(v.null(), v.number()) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    if (args.afterDays !== null && !CLEANUP_DAYS.includes(args.afterDays)) throw new Error("Choose 1, 7 or 30 days.");
    const settings = await ctx.db
      .query("settings")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .unique();
    if (settings === null) await ctx.db.insert("settings", { owner, cleanupAfterDays: args.afterDays });
    else await ctx.db.patch("settings", settings._id, { cleanupAfterDays: args.afterDays });
    // Files already waiting follow the new choice, counted from when each became unused.
    const unused = await ctx.db
      .query("uploads")
      .withIndex("by_owner_and_unusedSince", (q) => q.eq("owner", owner).gt("unusedSince", 0))
      .take(1000);
    for (const upload of unused) {
      const expiresAt = args.afterDays === null ? undefined : (upload.unusedSince ?? Date.now()) + args.afterDays * DAY_MS;
      if (upload.expiresAt !== expiresAt) await ctx.db.patch("uploads", upload._id, { expiresAt });
    }
    return null;
  },
});

/** Deletes the owner's unused files now. Returns how many went and whether more are left. */
export const cleanupNow = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const unused = await unusedFor(ctx, owner);
    const batch = unused.slice(0, BATCH);
    for (const upload of batch) await discard(ctx, upload.storageId);
    return { deleted: batch.length, more: unused.length > BATCH };
  },
});

/** Runs hourly: deletes every unused file whose time is up, in batches. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("uploads")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", 0).lt("expiresAt", Date.now()))
      .take(BATCH);
    for (const upload of due) {
      // A file a draft picked up again is never deleted, whatever its row says.
      if (upload.draftId === undefined) await discard(ctx, upload.storageId);
      else await ctx.db.patch("uploads", upload._id, { expiresAt: undefined, unusedSince: undefined });
    }
    if (due.length === BATCH) {
      await ctx.scheduler.runAfter(0, internal.media.sweep, {});
    }
    return null;
  },
});
