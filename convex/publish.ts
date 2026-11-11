"use node";

import { connectedAccountRef, SocialError, type MediaAttachment, type PublishRequest } from "@opencoredev/social-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { errorMessage, load } from "./sync";

/** A video upload and the platform's processing can take minutes; the SDK's default allowance is 30 seconds. */
const VIDEO_BUDGET = { retryBudget: { maxAttempts: 1, maxElapsedMs: 5 * 60_000 } };
/** How long to keep asking LinkedIn whether an uploaded video is ready, inside the action's ten minutes. */
const PROCESSING_WAIT_MS = 4 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends one draft to one account and records what the platform said. */
export const deliver = internalAction({
  args: { deliveryId: v.id("draftDeliveries") },
  handler: async (ctx, args) => {
    const found: { delivery: Doc<"draftDeliveries">; draft: Doc<"drafts"> } | null = await ctx.runQuery(internal.drafts.deliveryInternal, {
      deliveryId: args.deliveryId,
    });
    if (found === null || found.delivery.state !== "queued") return null;
    const { delivery, draft } = found;
    await ctx.runMutation(internal.drafts.recordDelivery, { deliveryId: delivery._id, state: "sending" });
    try {
      const loaded = await load(ctx, delivery.accountId);
      if (loaded === null) throw new Error("This account was disconnected.");
      const { account, social } = loaded;
      const accountRef = connectedAccountRef({ backend: "default", platform: account.platform, accountId: account.platformAccountId });
      const hasVideo = draft.media.some((item) => item.kind === "video");
      const options = hasVideo ? VIDEO_BUDGET : undefined;
      const media: MediaAttachment[] = [];
      for (const item of draft.media) {
        const blob = await ctx.storage.get(item.storageId);
        if (blob === null) throw new Error("An attachment is missing. Add it to the draft again.");
        const attachment: MediaAttachment = {
          kind: item.kind,
          source: { kind: "blob", blob, fingerprint: item.storageId },
          mimeType: item.mimeType,
          byteSize: blob.size,
          ...(item.filename ? { filename: item.filename } : {}),
        };
        // LinkedIn only posts media it already holds, so the file goes there first and the post names it.
        if (account.platform === "linkedin") {
          const ref = await social.media.upload(attachment, accountRef, options);
          media.push({ kind: item.kind, source: { kind: "media-ref", ref }, mimeType: item.mimeType });
        } else {
          media.push(attachment);
        }
      }
      const request: PublishRequest = {
        targets: [{ account: accountRef }],
        content: { ...(draft.text.trim() ? { text: draft.text.trim() } : {}), ...(media.length > 0 ? { media } : {}) },
        idempotencyKey: delivery._id,
      };
      const checked = social.posts.prepare(request as never);
      const blocking = checked.issues.find((issue) => issue.severity === "error");
      if (blocking) throw new Error(blocking.message);
      // LinkedIn refuses to post a video it is still processing and creates nothing, so asking again is safe.
      const waitUntil = Date.now() + PROCESSING_WAIT_MS;
      let result;
      for (;;) {
        let delayMs: number | null = null;
        try {
          result = await social.posts.publish(request as never, options);
          const first = result.outcomes[0];
          if (first?.state === "failed" && first.retryDisposition.kind === "after-delay" && /still processing/i.test(first.message)) {
            delayMs = first.retryDisposition.delayMs;
          }
        } catch (error) {
          const processing =
            error instanceof SocialError && error.code === "media_error" && error.retryDisposition?.kind === "after-delay" && /still processing/i.test(error.message);
          if (!processing) throw error;
          delayMs = 5000;
        }
        if (delayMs === null) break;
        if (Date.now() + delayMs > waitUntil) throw new Error("LinkedIn is still processing the video. Try again in a few minutes.");
        await sleep(Math.max(2000, delayMs));
      }
      if (result === undefined) throw new Error("The platform gave no answer. Check the account before trying again.");
      const outcome = result.outcomes[0];
      if (outcome === undefined) throw new Error("The platform gave no answer. Check the account before trying again.");
      if (outcome.state === "published") {
        await ctx.runMutation(internal.drafts.recordDelivery, {
          deliveryId: delivery._id,
          state: "published",
          platformPostId: outcome.post.postId,
          ...(outcome.url ? { permalink: outcome.url } : {}),
        });
      } else if (outcome.state === "accepted" || outcome.state === "processing" || outcome.state === "scheduled") {
        // The platform took the post and is still working on it; the next sync picks up its link.
        await ctx.runMutation(internal.drafts.recordDelivery, { deliveryId: delivery._id, state: "published" });
      } else if (outcome.state === "failed") {
        const reconnect = outcome.retryDisposition.kind === "after-reconnect";
        throw new Error(reconnect ? "Sign in to this account again, then publish." : outcome.message);
      } else {
        throw new Error("The post was not sent. Check the account before trying again.");
      }
    } catch (error) {
      console.error("publish", delivery.platform, String(error));
      await ctx.runMutation(internal.drafts.recordDelivery, {
        deliveryId: delivery._id,
        state: "failed",
        error: errorMessage(error).message,
      });
    }
    return null;
  },
});
