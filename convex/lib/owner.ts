import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

/**
 * The signed-in owner's stable key. BuddySocials is a personal dashboard, so
 * OWNER_EMAILS (comma separated) limits who may read or act on any data.
 */
export async function requireOwner(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Sign in to continue.");
  const allowed = (process.env.OWNER_EMAILS ?? "")
    .split(",")
    .map((email: string) => email.trim().toLowerCase())
    .filter(Boolean);
  const email = identity.email?.toLowerCase();
  if (allowed.length > 0 && (email === undefined || !allowed.includes(email))) {
    throw new Error("This account cannot open BuddySocials.");
  }
  return identity.tokenIdentifier;
}

/** Same check for queries that should render empty while auth is still settling. */
export async function optionalOwner(ctx: QueryCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  return requireOwner(ctx);
}
