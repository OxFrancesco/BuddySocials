"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { openCredential } from "./social/client";

/**
 * Records the app-scoped Instagram user behind each Instagram account, which is the ID Meta's
 * deauthorize and deletion callbacks send. It has to happen while the token still works, so it
 * runs on a schedule rather than when the callback arrives.
 */
export const linkInstagramAccounts = internalAction({
  args: {},
  handler: async (ctx) => {
    const pending: { accountId: Id<"accounts">; sealed: { iv: string; ciphertext: string } }[] = await ctx.runQuery(
      internal.compliance.unlinkedInstagram,
      {},
    );
    for (const { accountId, sealed } of pending) {
      try {
        const { accessToken } = openCredential(sealed);
        const response = await fetch("https://graph.instagram.com/v25.0/me?fields=id", {
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) continue;
        const data = (await response.json()) as { id?: unknown };
        const id = typeof data.id === "string" || typeof data.id === "number" ? String(data.id) : "";
        if (id) await ctx.runMutation(internal.compliance.linkMetaUser, { accountId, source: "instagram", metaUserId: id });
      } catch (error) {
        console.error("Could not read the Instagram user for", accountId, error instanceof Error ? error.message : String(error));
      }
    }
    return null;
  },
});
