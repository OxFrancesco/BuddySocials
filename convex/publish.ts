"use node";

import { connectedAccountRef, type MediaAttachment, type PublishRequest } from "@opencoredev/social-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { errorMessage, load } from "./sync";

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
      const media: MediaAttachment[] = [];
      for (const item of draft.media) {
        const blob = await ctx.storage.get(item.storageId);
        if (blob === null) throw new Error("An attachment is missing. Add it to the draft again.");
        media.push({
          kind: item.kind,
          source: { kind: "blob", blob, fingerprint: item.storageId },
          mimeType: item.mimeType,
          byteSize: item.byteSize,
          ...(item.filename ? { filename: item.filename } : {}),
        });
      }
      const request: PublishRequest = {
        targets: [{ account: connectedAccountRef({ backend: "default", platform: account.platform, accountId: account.platformAccountId }) }],
        content: { ...(draft.text.trim() ? { text: draft.text.trim() } : {}), ...(media.length > 0 ? { media } : {}) },
        // The delivery's ID makes a retry of this same send safe: the platform is asked once.
        idempotencyKey: delivery._id,
      };
      const checked = social.posts.prepare(request as never);
      const blocking = checked.issues.find((issue) => issue.severity === "error");
      if (blocking) throw new Error(blocking.message);
      const result = await social.posts.publish(request as never);
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
