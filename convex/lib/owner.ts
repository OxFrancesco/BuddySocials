import type { UserIdentity } from "convex/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Who may use BuddySocials.
 *
 * - OWNER_EMAILS (comma separated, optional): a private-beta allowlist. When it is set, only
 *   those verified emails may sign in. When it is empty or unset, sign-ups are open and every
 *   signed-in user may use the app, each seeing only their own data.
 * - ADMIN_EMAILS (comma separated, optional): people who may run owner-only operations
 *   (see `requireAdmin`). Empty or unset means nobody is an admin; there is no open default.
 *
 * Every user's data is keyed by `identity.tokenIdentifier`, the auth provider's stable ID.
 */

function emailList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/** True when sign-ups are open, or `email` is on the OWNER_EMAILS allowlist. */
export function emailMayUseApp(email: string | undefined | null, verified: boolean): boolean {
  const allowed = emailList(process.env.OWNER_EMAILS);
  if (allowed.length === 0) return true;
  return verified && typeof email === "string" && allowed.includes(email.trim().toLowerCase());
}

/** True when `email` is a verified address on the ADMIN_EMAILS list. */
export function emailIsAdmin(email: string | undefined | null, verified: boolean): boolean {
  const admins = emailList(process.env.ADMIN_EMAILS);
  return verified && typeof email === "string" && admins.includes(email.trim().toLowerCase());
}

/** Providers that leave `email_verified` out of the token are trusted; only an explicit false is refused. */
function verifiedEmail(identity: UserIdentity): boolean {
  return identity.emailVerified !== false;
}

async function signedIn(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Sign in to continue.");
  if (!emailMayUseApp(identity.email, verifiedEmail(identity))) {
    throw new Error("This account cannot open BuddySocials.");
  }
  return identity;
}

/** The signed-in user's stable key. Every per-user row is stored and looked up by it. */
export async function requireOwner(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string> {
  return (await signedIn(ctx)).tokenIdentifier;
}

/** Same check for queries that should render empty while auth is still settling. */
export async function optionalOwner(ctx: QueryCtx): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  return requireOwner(ctx);
}

/**
 * For anything global or owner-only (releases, other people's data, seeding). Ordinary users are
 * refused. Today every such operation is an internal function run from the Convex CLI, so nothing
 * public calls this yet; use it for any public endpoint of that kind added later.
 */
export async function requireAdmin(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string> {
  const identity = await signedIn(ctx);
  if (!emailIsAdmin(identity.email, verifiedEmail(identity))) throw new Error("Only an admin can do that.");
  return identity.tokenIdentifier;
}
