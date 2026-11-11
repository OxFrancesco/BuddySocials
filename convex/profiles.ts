import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { requireOwner } from "./lib/owner";

/** Records who is signed in, by email. The apps call it once after sign-in. */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const email = (await ctx.auth.getUserIdentity())?.email?.trim().toLowerCase();
    if (!email) return null;
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .unique();
    if (existing === null) await ctx.db.insert("profiles", { owner, email });
    else if (existing.email !== email) await ctx.db.patch("profiles", existing._id, { email });
    return null;
  },
});

/** The owner key for a verified email, or null when nobody with that email has used the app. */
export const ownerByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .first();
    return profile?.owner ?? null;
  },
});
