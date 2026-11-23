import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";
import { requireOwner } from "./lib/owner";

/**
 * Records who is signed in, by email. The apps call it once after sign-in. The MCP server finds a
 * user by this email, so only a verified address is recorded, and an address already recorded for
 * someone else is never moved to a second user.
 */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const identity = await ctx.auth.getUserIdentity();
    const email = identity?.email?.trim().toLowerCase();
    if (!email || identity?.emailVerified === false) return null;
    const holders = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", email))
      .take(2);
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .unique();
    const takenByOther = holders.some((profile) => profile.owner !== owner);
    if (existing === null) {
      if (!takenByOther) await ctx.db.insert("profiles", { owner, email });
    } else if (existing.email !== email) {
      if (takenByOther) await ctx.db.delete("profiles", existing._id);
      else await ctx.db.patch("profiles", existing._id, { email });
    }
    return null;
  },
});

/** The owner key for a verified email, or null when nobody (or more than one user) has it. */
export const ownerByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const profiles = await ctx.db
      .query("profiles")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .take(2);
    const owners = new Set(profiles.map((profile) => profile.owner));
    return owners.size === 1 ? profiles[0]!.owner : null;
  },
});
