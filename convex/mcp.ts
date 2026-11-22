import { createRemoteJWKSet, jwtVerify } from "jose";
import { YOUTUBE_VISIBILITIES, type YoutubeVisibility } from "../shared/drafts";
import { isPlatform, type Platform } from "../shared/platforms";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";

/**
 * A stateless MCP server over HTTP: every request carries a WorkOS AuthKit access
 * token and gets one JSON answer, so there are no sessions to keep. It can read
 * accounts, posts, comments, overview metrics, and drafts; create/edit/schedule
 * drafts (including per-platform copy, media, covers, and YouTube visibility);
 * update uploaded YouTube videos; and publish directly.
 *
 * Set WORKOS_AUTHKIT_DOMAIN on the deployment (for example `your-app.authkit.app`).
 * The token's verified email decides whose data is used: it must belong to someone
 * who has signed in to the app, and pass OWNER_EMAILS like every other sign-in.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function authkitIssuer(): string | null {
  const domain = process.env.WORKOS_AUTHKIT_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return domain ? `https://${domain}` : null;
}

type AuthorizationServer = { keys: ReturnType<typeof createRemoteJWKSet>; userinfo: string | null };
let known: { issuer: string; server: AuthorizationServer } | null = null;

/** Reads where the sign-in service publishes its keys and user details, once per running instance. */
async function authorizationServer(issuer: string): Promise<AuthorizationServer> {
  if (known?.issuer === issuer) return known.server;
  let metadata: { jwks_uri?: unknown; userinfo_endpoint?: unknown } = {};
  for (const path of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
    const response = await fetch(`${issuer}${path}`);
    if (response.ok) metadata = { ...((await response.json()) as typeof metadata), ...metadata };
  }
  const jwks = typeof metadata.jwks_uri === "string" ? metadata.jwks_uri : `${issuer}/oauth2/jwks`;
  const server = {
    keys: createRemoteJWKSet(new URL(jwks)),
    userinfo: typeof metadata.userinfo_endpoint === "string" ? metadata.userinfo_endpoint : `${issuer}/oauth2/userinfo`,
  };
  known = { issuer, server };
  return server;
}

function resourceUrl(): string {
  return `${process.env.CONVEX_SITE_URL}/mcp`;
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-expose-headers": "www-authenticate",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...headers } });
}

/** Tells an MCP client where to sign in (RFC 9728). */
export const protectedResource = httpAction(async () => {
  const issuer = authkitIssuer();
  if (issuer === null) return json({ error: "The MCP server is not set up yet." }, 503);
  return json({ resource: resourceUrl(), authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["openid", "profile", "email"] });
});

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: cors }));

function unauthorized(description: string): Response {
  const metadata = `${process.env.CONVEX_SITE_URL}/.well-known/oauth-protected-resource/mcp`;
  return json({ error: "invalid_token", error_description: description }, 401, {
    "www-authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${metadata}"`,
  });
}

/** The app owner behind a bearer token, or a response to send back. */
async function ownerFor(ctx: ActionCtx, request: Request): Promise<string | Response> {
  const issuer = authkitIssuer();
  if (issuer === null) return json({ error: "The MCP server is not set up yet." }, 503);
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return unauthorized("Sign in to use BuddySocials.");
  let email: unknown;
  try {
    const server = await authorizationServer(issuer);
    // The token must have been issued for this server, not for another app in the same WorkOS environment.
    const { payload } = await jwtVerify(token, server.keys, { issuer, audience: resourceUrl() });
    email = payload["email"];
    if (typeof email !== "string" && server.userinfo) {
      // AuthKit access tokens carry the user ID; the email comes from the userinfo endpoint.
      const info = await fetch(server.userinfo, { headers: { authorization: `Bearer ${token}` } });
      const profile = info.ok ? ((await info.json()) as { email?: unknown; email_verified?: unknown }) : null;
      if (profile?.email_verified === false) return unauthorized("Verify your email address first.");
      email = profile?.email;
    }
  } catch {
    return unauthorized("The sign-in has expired. Sign in again.");
  }
  if (typeof email !== "string" || !email) return unauthorized("This sign-in has no email address.");
  const allowed = (process.env.OWNER_EMAILS ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(email.toLowerCase())) return json({ error: "This account cannot open BuddySocials." }, 403);
  const owner: string | null = await ctx.runQuery(internal.profiles.ownerByEmail, { email });
  if (owner === null) return json({ error: "Open the BuddySocials app and sign in once with this email, then try again." }, 403);
  return owner;
}

/** What each platform does differently when a post goes out, for whoever is choosing where to post. */
const PLATFORM_NOTES =
  "Use platform_text to tailor copy per platform (e.g. <=280 chars for x, longer for linkedin/instagram/youtube). " +
  "Instagram needs an image or a video (JPEG images). YouTube takes one MP4 video; set title (or first line of text) and youtube_visibility (public, unlisted, or private; default unlisted). " +
  "TikTok takes one MP4 video and sends it to the TikTok app's inbox, where the caption and privacy are set before posting.";

const accountIds = { type: "array", items: { type: "string" }, description: "Account IDs from list_accounts." };
const mediaIds = {
  type: "array",
  items: { type: "string" },
  description:
    "Images or one video to attach, as media IDs from add_media_from_url or create_media_upload. Up to 4 images, or 1 video on its own. On an existing draft this replaces its attachments; omit it to leave them as they are.",
};

const coverId = {
  type: ["string", "null"],
  description:
    "A JPEG up to 2 MB to show before the video plays, as a media ID. It becomes the YouTube thumbnail and the Instagram Reel cover; TikTok's cover is chosen in the TikTok app. Null takes the cover off; omit it to leave it as it is. Setting it on a draft already on YouTube changes that video's thumbnail.",
};

const titleProp = {
  type: ["string", "null"],
  description: "Optional working title and YouTube video title (up to 100 chars for YouTube). Null clears it; omit to leave unchanged.",
};

const platformTextProp = {
  type: ["object", "null"],
  additionalProperties: { type: "string" },
  description:
    "Optional per-platform copy overrides keyed by platform name (x, linkedin, instagram, tiktok, youtube). Platforms omitted fall back to text. Null clears all overrides.",
};

const youtubeVisibilityProp = {
  type: ["string", "null"],
  enum: ["public", "unlisted", "private", null],
  description: "YouTube upload visibility (default unlisted). Null resets to default.",
};

const scheduledForProp = {
  type: ["string", "number", "null"],
  description: "Optional future ISO-8601 timestamp (e.g. '2026-11-23T15:00:00Z') or Unix ms to auto-publish this draft. Null cancels a schedule.",
};

const TOOLS = [
  {
    name: "list_accounts",
    description: "The connected social accounts, with the ID to post to, whether posting works, and any issues (such as reconnect needed).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_drafts",
    description: "Saved drafts, newest first: title, core text, per-platform overrides, schedule, target accounts, anything stopping a publish, and delivery state on each platform.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_draft",
    description: "Returns full details of one draft by draft_id.",
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"], additionalProperties: false },
  },
  {
    name: "save_draft",
    description: `Creates a draft, or updates one when draft_id is given. Optionally schedules it with scheduled_for. Nothing is posted immediately. ${PLATFORM_NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        title: titleProp,
        text: { type: "string" },
        platform_text: platformTextProp,
        youtube_visibility: youtubeVisibilityProp,
        account_ids: accountIds,
        media_ids: mediaIds,
        cover_id: coverId,
        scheduled_for: scheduledForProp,
        draft_id: { type: "string", description: "Omit to create a new draft." },
      },
      required: ["text", "account_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_draft",
    description: "Deletes a draft (and cancels any pending schedule). Posts already published stay on their platforms.",
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"], additionalProperties: false },
  },
  {
    name: "schedule_draft",
    description: "Schedules a saved draft to publish automatically at a future time, or cancels its schedule when scheduled_for is null.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        scheduled_for: scheduledForProp,
      },
      required: ["draft_id", "scheduled_for"],
      additionalProperties: false,
    },
  },
  {
    name: "publish_draft",
    description: `Posts a saved draft to every target account it hasn't reached yet (or only account_ids when supplied). This is public and cannot be undone here. ${PLATFORM_NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        account_ids: { ...accountIds, description: "Optional subset of target account IDs to publish or retry." },
      },
      required: ["draft_id"],
      additionalProperties: false,
    },
  },
  {
    name: "publish_post",
    description: `Posts immediately to the given accounts. This is public and cannot be undone here. Use save_draft to keep it for later or schedule_draft to publish later. ${PLATFORM_NOTES}`,
    inputSchema: {
      type: "object",
      properties: {
        title: titleProp,
        text: { type: "string" },
        platform_text: platformTextProp,
        youtube_visibility: youtubeVisibilityProp,
        account_ids: accountIds,
        media_ids: mediaIds,
        cover_id: coverId,
      },
      required: ["text", "account_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "update_youtube_video",
    description: "Changes an already-uploaded YouTube video's visibility (public, unlisted, private), title, or description.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "YouTube account ID from list_accounts." },
        video_id: { type: "string", description: "YouTube video ID (platformPostId from list_drafts or list_posts)." },
        visibility: { type: "string", enum: ["public", "unlisted", "private"] },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["account_id", "video_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_posts",
    description: "Lists recent published posts with views, likes, comments, shares, and text so you can match the creator's style and see what performs well.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["youtube", "instagram", "tiktok", "x", "linkedin"] },
        limit: { type: "number", description: "1 to 50 (default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_comments",
    description: "Lists recent audience comments across posts (defaults to open/unreplied comments).",
    inputSchema: {
      type: "object",
      properties: {
        open_only: { type: "boolean", description: "Default true." },
        platform: { type: "string", enum: ["youtube", "instagram", "tiktok", "x", "linkedin"] },
        limit: { type: "number", description: "1 to 50 (default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_overview",
    description: "Returns daily performance counters across platforms for the last N days (default 7).",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "1 to 90 (default 7)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_media_from_url",
    description:
      "Fetches an image or video from a public https link and stores it. Returns a media_id to pass as media_ids to save_draft or publish_post. Images up to 20 MB; videos up to 200 MB, MP4. Instagram takes JPEG images.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "A public https link to the file itself." }, filename: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "create_media_upload",
    description:
      "For a file on your own machine: returns a one-hour upload_url. POST the file's raw bytes to it with the file's Content-Type header (image/jpeg, image/png, video/mp4). The JSON answer has storageId; pass that as a media_id in media_ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("text must be a string.");
  return value;
}

function optionalTitle(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("title must be a string or null.");
  return value;
}

function optionalPlatformText(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("platform_text must be an object mapping platform names to text.");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isPlatform(key)) throw new Error(`Unknown platform in platform_text: ${key}.`);
    if (typeof entry !== "string") throw new Error(`platform_text.${key} must be a string.`);
    result[key] = entry;
  }
  return result;
}

function optionalYoutubeVisibility(value: unknown): YoutubeVisibility | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !(YOUTUBE_VISIBILITIES as readonly string[]).includes(value)) {
    throw new Error("youtube_visibility must be public, unlisted, or private.");
  }
  return value as YoutubeVisibility;
}

function optionalPlatform(value: unknown): Platform | undefined {
  if (value === undefined) return undefined;
  if (!isPlatform(value)) throw new Error("platform must be youtube, instagram, tiktok, x, or linkedin.");
  return value;
}

function parseTimestamp(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error("scheduled_for must be a valid ISO-8601 timestamp or Unix milliseconds.");
    return parsed;
  }
  throw new Error("scheduled_for must be an ISO-8601 timestamp, Unix milliseconds, or null.");
}

function ids(value: unknown): Id<"accounts">[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("account_ids must be a list of account IDs.");
  return value as Id<"accounts">[];
}

/** Registers each named upload for this owner and returns the IDs, or undefined when none were given. */
async function media(ctx: ActionCtx, owner: string, value: unknown): Promise<Id<"_storage">[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("media_ids must be a list of media IDs.");
  for (const storageId of value as Id<"_storage">[]) {
    try {
      await ctx.runMutation(internal.media.attachInternal, { owner, storageId });
    } catch (error) {
      // An ID that was never an upload fails before it reaches the server's own wording.
      throw new Error(String(error).includes("Uncaught Error: ") ? readable(error) : `${storageId} is not a media ID from add_media_from_url or create_media_upload.`);
    }
  }
  return value as Id<"_storage">[];
}

/** Registers the cover upload for this owner. Undefined leaves a draft's cover alone; null takes it off. */
async function cover(ctx: ActionCtx, owner: string, value: unknown): Promise<{ cover?: Id<"_storage"> | null }> {
  if (value === undefined) return {};
  if (value === null) return { cover: null };
  const [storageId] = (await media(ctx, owner, [value])) ?? [];
  return storageId ? { cover: storageId } : {};
}

function draftId(value: unknown): Id<"drafts"> {
  if (typeof value !== "string" || !value) throw new Error("draft_id is required.");
  return value as Id<"drafts">;
}

async function callTool(ctx: ActionCtx, owner: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_accounts":
      return await ctx.runQuery(internal.drafts.accountsInternal, { owner });
    case "list_drafts":
      return await ctx.runQuery(internal.drafts.listInternal, { owner });
    case "get_draft": {
      const found = await ctx.runQuery(internal.drafts.getInternal, { owner, draftId: draftId(args["draft_id"]) });
      if (found === null) throw new Error("Draft not found.");
      return found;
    }
    case "save_draft": {
      const attached = await media(ctx, owner, args["media_ids"]);
      const title = optionalTitle(args["title"]);
      const platformText = optionalPlatformText(args["platform_text"]);
      const youtubeVisibility = optionalYoutubeVisibility(args["youtube_visibility"]);
      const scheduledFor = parseTimestamp(args["scheduled_for"]);
      const id = await ctx.runMutation(internal.drafts.saveInternal, {
        owner,
        ...(title !== undefined ? { title } : {}),
        text: text(args["text"]),
        ...(platformText !== undefined ? { platformText } : {}),
        ...(youtubeVisibility !== undefined ? { youtubeVisibility } : {}),
        accountIds: ids(args["account_ids"]),
        ...(attached ? { mediaIds: attached } : {}),
        ...(await cover(ctx, owner, args["cover_id"])),
        ...(args["draft_id"] !== undefined ? { draftId: draftId(args["draft_id"]) } : {}),
      });
      if (scheduledFor === null) {
        await ctx.runMutation(internal.drafts.cancelScheduleInternal, { owner, draftId: id });
      } else if (scheduledFor !== undefined) {
        await ctx.runMutation(internal.drafts.scheduleInternal, { owner, draftId: id, at: scheduledFor });
      }
      return { draft_id: id, ...(scheduledFor !== undefined ? { scheduled_for: scheduledFor } : {}) };
    }
    case "delete_draft":
      await ctx.runMutation(internal.drafts.removeInternal, { owner, draftId: draftId(args["draft_id"]) });
      return { deleted: true };
    case "schedule_draft": {
      const id = draftId(args["draft_id"]);
      const at = parseTimestamp(args["scheduled_for"]);
      if (at === undefined) throw new Error("scheduled_for is required (ISO-8601 timestamp, Unix ms, or null to cancel).");
      if (at === null) {
        await ctx.runMutation(internal.drafts.cancelScheduleInternal, { owner, draftId: id });
        return { draft_id: id, scheduled_for: null };
      }
      await ctx.runMutation(internal.drafts.scheduleInternal, { owner, draftId: id, at });
      return { draft_id: id, scheduled_for: at, scheduled_iso: new Date(at).toISOString() };
    }
    case "publish_draft": {
      const only = args["account_ids"] !== undefined ? ids(args["account_ids"]) : undefined;
      const queued = await ctx.runMutation(internal.drafts.publishInternal, {
        owner,
        draftId: draftId(args["draft_id"]),
        ...(only ? { accountIds: only } : {}),
      });
      return { queued, note: "Publishing runs in the background. Call list_drafts or get_draft to see the result on each platform." };
    }
    case "publish_post": {
      const attached = await media(ctx, owner, args["media_ids"]);
      const title = optionalTitle(args["title"]);
      const platformText = optionalPlatformText(args["platform_text"]);
      const youtubeVisibility = optionalYoutubeVisibility(args["youtube_visibility"]);
      const id = await ctx.runMutation(internal.drafts.saveInternal, {
        owner,
        ...(title !== undefined ? { title } : {}),
        text: text(args["text"]),
        ...(platformText !== undefined ? { platformText } : {}),
        ...(youtubeVisibility !== undefined ? { youtubeVisibility } : {}),
        accountIds: ids(args["account_ids"]),
        ...(attached ? { mediaIds: attached } : {}),
        ...(await cover(ctx, owner, args["cover_id"])),
      });
      const queued = await ctx.runMutation(internal.drafts.publishInternal, { owner, draftId: id });
      return { draft_id: id, queued, note: "Publishing runs in the background. Call list_drafts or get_draft to see the result on each platform." };
    }
    case "update_youtube_video": {
      if (typeof args["account_id"] !== "string" || !args["account_id"]) throw new Error("account_id is required.");
      if (typeof args["video_id"] !== "string" || !args["video_id"]) throw new Error("video_id is required.");
      const accounts = await ctx.runQuery(internal.drafts.accountsInternal, { owner });
      const owned = accounts.find((entry) => entry.accountId === args["account_id"] && entry.platform === "youtube");
      if (!owned) throw new Error("YouTube account not found.");
      const visibility = optionalYoutubeVisibility(args["visibility"]);
      const error = await ctx.runAction(internal.publish.updateYouTube, {
        accountId: args["account_id"] as Id<"accounts">,
        videoId: args["video_id"],
        ...(visibility ? { visibility } : {}),
        ...(typeof args["title"] === "string" ? { title: args["title"] } : {}),
        ...(typeof args["description"] === "string" ? { description: args["description"] } : {}),
      });
      if (error !== null) throw new Error(error);
      return { updated: true, video_id: args["video_id"] };
    }
    case "list_posts": {
      const platform = optionalPlatform(args["platform"]);
      const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
      return await ctx.runQuery(internal.dashboard.recentPostsInternal, {
        owner,
        ...(platform ? { platform } : {}),
        limit,
      });
    }
    case "list_comments": {
      const platform = optionalPlatform(args["platform"]);
      const open = args["open_only"] === undefined ? true : Boolean(args["open_only"]);
      const limit = typeof args["limit"] === "number" ? args["limit"] : 25;
      return await ctx.runQuery(internal.comments.listInternal, {
        owner,
        open,
        ...(platform ? { platform } : {}),
        limit,
      });
    }
    case "get_overview": {
      const days = typeof args["days"] === "number" ? args["days"] : 7;
      const today = new Date().toISOString().slice(0, 10);
      return await ctx.runQuery(internal.dashboard.overviewInternal, { owner, today, days });
    }
    case "add_media_from_url": {
      if (typeof args["url"] !== "string") throw new Error("url is required.");
      const stored = await ctx.runAction(internal.mediaImport.fromUrl, {
        owner,
        url: args["url"],
        ...(typeof args["filename"] === "string" ? { filename: args["filename"] } : {}),
      });
      return { media_id: stored.storageId, kind: stored.kind, mime_type: stored.mimeType, bytes: stored.byteSize };
    }
    case "create_media_upload":
      return {
        upload_url: await ctx.runMutation(internal.media.uploadUrlInternal, {}),
        how: "POST the file's raw bytes to upload_url with its Content-Type header. The JSON answer has storageId; pass it in media_ids.",
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Convex prefixes thrown errors with where they came from; only the sentence is useful to a caller. */
function readable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n").find((entry) => entry.includes("Uncaught Error: ")) ?? message.split("\n")[0] ?? "";
  return line.replace(/^.*Uncaught Error: /, "").trim() || "Something went wrong.";
}

type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

async function answer(ctx: ActionCtx, owner: string, message: RpcRequest): Promise<unknown | null> {
  const id = message.id;
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message: text } });
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(-32600, "Invalid request.");
  // Notifications have no id and get no answer.
  if (id === undefined) return null;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize": {
      const asked = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "buddysocials", version: "1.1.0" },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = typeof params["name"] === "string" ? params["name"] : "";
      try {
        const result = await callTool(ctx, owner, name, (params["arguments"] ?? {}) as Record<string, unknown>);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: readable(error) }], isError: true } };
      }
    }
    default:
      return fail(-32601, "Method not found.");
  }
}

export const post = httpAction(async (ctx, request) => {
  const owner = await ownerFor(ctx, request);
  if (owner instanceof Response) return owner;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400);
  }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((message) => answer(ctx, owner, message as RpcRequest)))).filter((entry) => entry !== null);
    return answers.length > 0 ? json(answers) : new Response(null, { status: 202, headers: cors });
  }
  const single = await answer(ctx, owner, body as RpcRequest);
  return single === null ? new Response(null, { status: 202, headers: cors }) : json(single);
});

/** Stateless: there is no stream to open, which the spec lets a server say with 405. */
export const noStream = httpAction(async () => new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", ...cors } }));
