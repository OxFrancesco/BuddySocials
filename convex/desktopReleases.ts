import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** Older builds kept per platform, so a download that started just before a release still finishes. */
const KEPT = 2;

const sha256 = (value: string) => /^[0-9a-f]{64}$/.test(value);

const hexOfBase64 = (value: string) => [...atob(value)].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** The newest build for a platform and where to download it, or null when there is none. */
export const latest = internalQuery({
  args: { platform: v.string() },
  handler: async (ctx, args) => {
    const release = await ctx.db
      .query("desktopReleases")
      .withIndex("by_platform_and_createdAt", (q) => q.eq("platform", args.platform))
      .order("desc")
      .first();
    if (release === null) return null;
    const url = await ctx.storage.getUrl(release.storageId);
    if (url === null) return null;
    return {
      version: release.version,
      url,
      byteSize: release.byteSize,
      fileSha256: release.fileSha256,
      programSha256: release.programSha256,
      createdAt: release.createdAt,
    };
  },
});

// `desktop/release.sh` runs these two with the Convex CLI, so only someone who can deploy can publish a build.

/** Where to send a build's file before publishing it. Valid for one hour. */
export const uploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** Makes an uploaded file the newest build for its platform and deletes builds older than the last few. */
export const publish = internalMutation({
  args: { platform: v.string(), version: v.string(), storageId: v.id("_storage"), fileSha256: v.string(), programSha256: v.string() },
  handler: async (ctx, args) => {
    if (!sha256(args.fileSha256) || !sha256(args.programSha256)) throw new Error("Both checksums must be SHA-256 in lowercase hex.");
    const file = await ctx.db.system.get("_storage", args.storageId);
    if (file === null) throw new Error("The uploaded file was not found.");
    // The server's own checksum of what arrived must match what the build script measured.
    if (file.sha256 !== undefined && hexOfBase64(file.sha256) !== args.fileSha256) {
      throw new Error("The uploaded file does not match its checksum. Upload it again.");
    }
    await ctx.db.insert("desktopReleases", { ...args, byteSize: file.size, createdAt: Date.now() });
    const all = await ctx.db
      .query("desktopReleases")
      .withIndex("by_platform_and_createdAt", (q) => q.eq("platform", args.platform))
      .order("desc")
      .take(20);
    for (const old of all.slice(1 + KEPT)) {
      await ctx.storage.delete(old.storageId);
      await ctx.db.delete("desktopReleases", old._id);
    }
    return { platform: args.platform, version: args.version, byteSize: file.size };
  },
});
