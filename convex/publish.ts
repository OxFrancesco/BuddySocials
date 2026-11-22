"use node";

import {
  connectedAccountRef,
  SocialError,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type MediaAttachment,
  type PublishRequest,
} from "@opencoredev/social-sdk";
import { v } from "convex/values";
import { PLATFORM_LABEL } from "../shared/platforms";
import { textForPlatform, YOUTUBE_VISIBILITY, youtubeTitle } from "../shared/drafts";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { requireOwner } from "./lib/owner";
import { jpegSize } from "./social/probe";
import { sendToTikTokInbox } from "./social/tiktokInbox";
import { adapterFor, socialFor } from "./social/client";
import { setYouTubeThumbnail, updateYouTubeVideo, uploadToYouTube } from "./social/youtubeUpload";
import { errorMessage, load } from "./sync";

/** A video upload and the platform's processing can take minutes; the SDK's default allowance is 30 seconds. */
const VIDEO_BUDGET = { retryBudget: { maxAttempts: 1, maxElapsedMs: 5 * 60_000 } };
/** How long to keep asking LinkedIn whether an uploaded video is ready, inside the action's ten minutes. */
const PROCESSING_WAIT_MS = 4 * 60_000;
/** When to stop following a post the platform is still processing, leaving time to record the result. */
const FOLLOW_UNTIL_MS = 8 * 60_000;
const FOLLOW_EVERY_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

const missing = () => new Error("An attachment is missing. Add it to the draft again.");

/** Turns one stored attachment into what the account's platform takes. */
async function attachmentFor(
  ctx: ActionCtx,
  platform: Doc<"accounts">["platform"],
  item: Doc<"drafts">["media"][number],
  carousel: boolean,
): Promise<MediaAttachment> {
  // Instagram fetches each file itself from a public link, so the video never passes through here.
  if (platform === "instagram") {
    const url = await ctx.storage.getUrl(item.storageId);
    if (url === null) throw missing();
    // Every image in a carousel has to share one shape, and Instagram wants to know it up front.
    let size: { width: number; height: number } | null = null;
    if (carousel && item.kind === "image") {
      const blob = await ctx.storage.get(item.storageId);
      if (blob === null) throw missing();
      size = await jpegSize(blob);
      if (size === null) throw new Error("One of the images couldn't be read. Export it again as JPEG.");
    }
    return { kind: item.kind, source: { kind: "https-url", url }, mimeType: item.mimeType, byteSize: item.byteSize, ...(size ?? {}) };
  }
  const blob = await ctx.storage.get(item.storageId);
  if (blob === null) throw missing();
  return {
    kind: item.kind,
    source: { kind: "blob", blob, fingerprint: item.storageId },
    mimeType: item.mimeType,
    byteSize: blob.size,
    ...(item.filename ? { filename: item.filename } : {}),
  };
}

/**
 * TikTok posts go to the creator's TikTok inbox, where they add the caption and choose who sees it.
 * That needs no app audit, unlike posting directly.
 */
async function sendToTikTok(ctx: ActionCtx, loaded: Loaded, draft: Doc<"drafts">, accountRef: ConnectedAccountRef): Promise<DeliveryOutcome> {
  const video = draft.media[0];
  if (video === undefined || video.kind !== "video") throw new Error("TikTok needs a video.");
  if (loaded.credential === null) throw new Error("Sign in to TikTok again, then publish.");
  const blob = await ctx.storage.get(video.storageId);
  if (blob === null) throw missing();
  const publishId = await sendToTikTokInbox(blob, video.mimeType, loaded.credential.accessToken);
  return {
    state: "processing",
    targetIndex: 0,
    account: accountRef,
    observedAt: new Date().toISOString(),
    delivery: { kind: "delivery", version: 1, backend: accountRef.backend, platform: "tiktok", accountId: accountRef.accountId, deliveryId: publishId },
  };
}

/** Uploads the draft's video to YouTube using the draft's chosen visibility and title. */
async function sendToYouTube(ctx: ActionCtx, loaded: Loaded, draft: Doc<"drafts">, accountRef: ConnectedAccountRef): Promise<DeliveryOutcome> {
  const video = draft.media[0];
  if (video === undefined || video.kind !== "video") throw new Error("YouTube needs a video.");
  if (loaded.credential === null) throw new Error("Sign in to YouTube again, then publish.");
  const sourceUrl = await ctx.storage.getUrl(video.storageId);
  if (sourceUrl === null) throw missing();
  const text = textForPlatform(draft.text, "youtube", draft.platformText).trim();
  const visibility = draft.youtubeVisibility ?? YOUTUBE_VISIBILITY;
  const videoId = await uploadToYouTube(
    { sourceUrl, byteSize: video.byteSize, mimeType: video.mimeType, title: youtubeTitle(text, video.filename, draft.title), description: text, visibility },
    loaded.credential.accessToken,
  );
  // The video is up either way; a cover YouTube refuses is no reason to call the post failed.
  if (draft.cover) {
    try {
      const cover = await ctx.storage.get(draft.cover.storageId);
      if (cover !== null) await setYouTubeThumbnail(videoId, cover, loaded.credential.accessToken);
    } catch (error) {
      console.error("publish youtube cover", String(error));
    }
  }
  // YouTube has the whole video and finishes processing it on its own.
  return {
    state: "processing",
    targetIndex: 0,
    account: accountRef,
    observedAt: new Date().toISOString(),
    delivery: { kind: "delivery", version: 1, backend: accountRef.backend, platform: "youtube", accountId: accountRef.accountId, deliveryId: videoId },
  };
}

/** Posts through the SDK and returns what the platform said about the one target. */
async function publishWithSdk(ctx: ActionCtx, { account, social }: Loaded, draft: Doc<"drafts">, delivery: Doc<"draftDeliveries">, accountRef: ConnectedAccountRef) {
  const hasVideo = draft.media.some((item) => item.kind === "video");
  const options = hasVideo ? VIDEO_BUDGET : undefined;
  const media: MediaAttachment[] = [];
  for (const item of draft.media) {
    const attachment = await attachmentFor(ctx, account.platform, item, draft.media.length > 1);
    // LinkedIn only posts media it already holds, so the file goes there first and the post names it.
    if (account.platform === "linkedin") {
      const ref = await social.media.upload(attachment, accountRef, options);
      media.push({ kind: item.kind, source: { kind: "media-ref", ref }, mimeType: item.mimeType });
    } else {
      media.push(attachment);
    }
  }
  const text = textForPlatform(draft.text, account.platform, draft.platformText).trim();
  const targetOptions =
    account.platform === "youtube"
      ? {
          title: youtubeTitle(text, draft.media[0]?.filename, draft.title),
          visibility: draft.youtubeVisibility ?? YOUTUBE_VISIBILITY,
          madeForKids: false,
        }
      : undefined;
  const request: PublishRequest = {
    targets: [{ account: accountRef, ...(targetOptions ? { options: targetOptions } : {}) }],
    content: { ...(text ? { text } : {}), ...(media.length > 0 ? { media } : {}) },
    idempotencyKey: delivery._id,
  };
  const checked = social.posts.prepare(request as never);
  const blocking = checked.issues.find((issue) => issue.severity === "error");
  if (blocking) throw new Error(blocking.message);
  // LinkedIn refuses to post a video it is still processing and creates nothing, so asking again is safe.
  const waitUntil = Date.now() + PROCESSING_WAIT_MS;
  for (;;) {
    let delayMs: number | null = null;
    try {
      const result = await social.posts.publish(request as never, options);
      const first = result.outcomes[0];
      if (first?.state === "failed" && first.retryDisposition.kind === "after-delay" && /still processing/i.test(first.message)) {
        delayMs = first.retryDisposition.delayMs;
      } else {
        return first;
      }
    } catch (error) {
      const processing =
        error instanceof SocialError && error.code === "media_error" && error.retryDisposition?.kind === "after-delay" && /still processing/i.test(error.message);
      if (!processing) throw error;
      delayMs = 5000;
    }
    if (Date.now() + delayMs > waitUntil) throw new Error("LinkedIn is still processing the video. Try again in a few minutes.");
    await sleep(Math.max(2000, delayMs));
  }
}

/** Sends one draft to one account and records what the platform said. */
export const deliver = internalAction({
  args: { deliveryId: v.id("draftDeliveries") },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const found: { delivery: Doc<"draftDeliveries">; draft: Doc<"drafts"> } | null = await ctx.runQuery(internal.drafts.deliveryInternal, {
      deliveryId: args.deliveryId,
    });
    if (found === null || found.delivery.state !== "queued") return null;
    const { delivery, draft } = found;
    await ctx.runMutation(internal.drafts.recordDelivery, { deliveryId: delivery._id, state: "sending" });
    const label = PLATFORM_LABEL[delivery.platform];
    try {
      const loaded = await load(ctx, delivery.accountId);
      if (loaded === null) throw new Error("This account was disconnected.");
      const { account } = loaded;
      // A Reel's cover is fetched by Instagram from a link, like the video.
      const reelCoverUrl = account.platform === "instagram" && draft.cover ? await ctx.storage.getUrl(draft.cover.storageId) : null;
      const social = reelCoverUrl ? socialFor(adapterFor(account, loaded.credential, { reelCoverUrl })) : loaded.social;
      const accountRef = connectedAccountRef({ backend: "default", platform: account.platform, accountId: account.platformAccountId });
      const direct = account.source === "direct";
      let outcome: DeliveryOutcome | undefined =
        direct && account.platform === "tiktok"
          ? await sendToTikTok(ctx, loaded, draft, accountRef)
          : direct && account.platform === "youtube"
            ? await sendToYouTube(ctx, loaded, draft, accountRef)
            : await publishWithSdk(ctx, { ...loaded, social }, draft, delivery, accountRef);
      // Instagram posts a video only once it has processed it, and TikTok reports a failed upload a little later,
      // so both are followed until they settle. YouTube has the video by now and finishes on its own.
      while (
        outcome?.state === "processing" &&
        outcome.delivery !== undefined &&
        (account.platform === "instagram" || account.platform === "tiktok") &&
        Date.now() - startedAt < FOLLOW_UNTIL_MS
      ) {
        await sleep(FOLLOW_EVERY_MS);
        outcome = await social.posts.getDelivery(outcome.delivery);
      }
      if (outcome === undefined) throw new Error("The platform gave no answer. Check the account before trying again.");
      const youtubeId = account.platform === "youtube" ? (outcome.state === "published" ? outcome.post.postId : outcome.delivery?.deliveryId) : undefined;
      const youtubeLink = youtubeId ? { platformPostId: youtubeId, permalink: `https://youtu.be/${youtubeId}` } : {};
      if (outcome.state === "published") {
        await ctx.runMutation(internal.drafts.recordDelivery, {
          deliveryId: delivery._id,
          state: "published",
          platformPostId: outcome.post.postId,
          ...(outcome.url ? { permalink: outcome.url } : {}),
          ...youtubeLink,
        });
      } else if (outcome.state === "processing" && account.platform === "instagram") {
        // Nothing is posted until Instagram finishes, and the half-made post expires unpublished.
        throw new Error("Instagram is still processing the video. Publish again in a few minutes.");
      } else if (outcome.state === "accepted" || outcome.state === "processing" || outcome.state === "scheduled") {
        // The platform took the post and is still working on it; the next sync picks up its link.
        // For TikTok this means the video is in the creator's TikTok inbox.
        await ctx.runMutation(internal.drafts.recordDelivery, { deliveryId: delivery._id, state: "published", ...youtubeLink });
      } else if (outcome.state === "failed") {
        const reconnect = outcome.retryDisposition.kind === "after-reconnect";
        if (reconnect) throw new Error("Sign in to this account again, then publish.");
        // TikTok's reason, such as duration_check_failed, says more than its generic message.
        throw new Error(account.platform === "tiktok" ? `TikTok couldn't take the video (${outcome.code.replaceAll("_", " ")}).` : outcome.message);
      } else if (outcome.state === "not-submitted" && outcome.issues?.[0]) {
        throw new Error(outcome.issues[0].message);
      } else if (outcome.state === "unknown") {
        // The platform may or may not have the post, so the person is told to look before sending it twice.
        console.error("publish", delivery.platform, "unknown outcome", outcome.reason, outcome.diagnostic ?? "");
        throw new Error(`${label} didn't confirm the post. Check ${label} before publishing again, so it isn't posted twice.`);
      } else {
        throw new Error("The post was not sent. Check the account before trying again.");
      }
    } catch (error) {
      console.error("publish", delivery.platform, String(error));
      const permission = error instanceof SocialError && error.code === "missing_permission";
      await ctx.runMutation(internal.drafts.recordDelivery, {
        deliveryId: delivery._id,
        state: "failed",
        error: permission ? `Sign in to ${label} again to allow posting.` : errorMessage(error).message,
      });
    }
    return null;
  },
});

/** Puts the draft's cover on a video that is already on YouTube. Returns what went wrong, or null. */
export const applyCover = internalAction({
  args: { deliveryId: v.id("draftDeliveries") },
  handler: async (ctx, args): Promise<string | null> => {
    const found: { delivery: Doc<"draftDeliveries">; draft: Doc<"drafts"> } | null = await ctx.runQuery(internal.drafts.deliveryInternal, {
      deliveryId: args.deliveryId,
    });
    if (found === null || found.delivery.platform !== "youtube" || !found.delivery.platformPostId || !found.draft.cover) return "Nothing to set.";
    try {
      const loaded = await load(ctx, found.delivery.accountId);
      if (loaded === null || loaded.credential === null) throw new Error("Sign in to YouTube again to set the cover.");
      const cover = await ctx.storage.get(found.draft.cover.storageId);
      if (cover === null) throw new Error("The cover is missing. Add it again.");
      await setYouTubeThumbnail(found.delivery.platformPostId, cover, loaded.credential.accessToken);
      return null;
    } catch (error) {
      console.error("apply cover", String(error));
      return errorMessage(error).message;
    }
  },
});

/** Changes a YouTube video's visibility, title or description, such as making an unlisted Short public. */
export const updateYouTube = internalAction({
  args: {
    accountId: v.id("accounts"),
    videoId: v.string(),
    visibility: v.optional(v.union(v.literal("public"), v.literal("unlisted"), v.literal("private"))),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, videoId, ...change }): Promise<string | null> => {
    try {
      const loaded = await load(ctx, accountId);
      if (loaded === null || loaded.credential === null || loaded.account.platform !== "youtube") throw new Error("Sign in to YouTube again.");
      await updateYouTubeVideo(videoId, change, loaded.credential.accessToken);
      return null;
    } catch (error) {
      console.error("update youtube", videoId, String(error));
      return errorMessage(error).message;
    }
  },
});

/** Public action for the desktop and mobile apps to update a published YouTube video's visibility, title, or description. */
export const updateYouTubePost = action({
  args: {
    accountId: v.id("accounts"),
    videoId: v.string(),
    visibility: v.optional(v.union(v.literal("public"), v.literal("unlisted"), v.literal("private"))),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, videoId, ...change }): Promise<null> => {
    const owner = await requireOwner(ctx);
    const loaded = await load(ctx, accountId);
    if (loaded === null || loaded.account.owner !== owner || loaded.account.platform !== "youtube") {
      throw new Error("YouTube account not found.");
    }
    if (loaded.credential === null) throw new Error("Sign in to YouTube again.");
    await updateYouTubeVideo(videoId, change, loaded.credential.accessToken);
    return null;
  },
});
