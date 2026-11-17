import { createRemoteJWKSet, jwtVerify } from "jose";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";

/**
 * A stateless MCP server over HTTP: every request carries a WorkOS AuthKit access
 * token and gets one JSON answer, so there are no sessions to keep. It can list
 * accounts and drafts, save and delete drafts, and publish.
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
  "Instagram needs an image or a video (JPEG images). YouTube takes one MP4 video, uploaded unlisted with the text's first line as its title. " +
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

const TOOLS = [
  {
    name: "list_accounts",
    description: "The connected social accounts, with the ID to post to and whether posting works for each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_drafts",
    description: "Saved drafts, newest first: text, target accounts, anything stopping a publish, and what happened on each platform.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_draft",
    description: "Creates a draft, or updates one when draft_id is given. Nothing is posted.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        account_ids: accountIds,
        media_ids: mediaIds,
        cover_id: coverId,
        draft_id: { type: "string", description: "Omit to create a new draft." },
      },
      required: ["text", "account_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_draft",
    description: "Deletes a draft. Posts already published stay on their platforms.",
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"], additionalProperties: false },
  },
  {
    name: "publish_draft",
    description: `Posts a saved draft to every target account it hasn't reached yet. This is public and cannot be undone here. ${PLATFORM_NOTES}`,
    inputSchema: { type: "object", properties: { draft_id: { type: "string" } }, required: ["draft_id"], additionalProperties: false },
  },
  {
    name: "publish_post",
    description: `Posts text to the given accounts right away. This is public and cannot be undone here. Use save_draft to keep it for later. ${PLATFORM_NOTES}`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, account_ids: accountIds, media_ids: mediaIds, cover_id: coverId },
      required: ["text", "account_ids"],
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
    case "save_draft": {
      const attached = await media(ctx, owner, args["media_ids"]);
      const id = await ctx.runMutation(internal.drafts.saveInternal, {
        owner,
        text: text(args["text"]),
        accountIds: ids(args["account_ids"]),
        ...(attached ? { mediaIds: attached } : {}),
        ...(await cover(ctx, owner, args["cover_id"])),
        ...(args["draft_id"] !== undefined ? { draftId: draftId(args["draft_id"]) } : {}),
      });
      return { draft_id: id };
    }
    case "delete_draft":
      await ctx.runMutation(internal.drafts.removeInternal, { owner, draftId: draftId(args["draft_id"]) });
      return { deleted: true };
    case "publish_draft": {
      const queued = await ctx.runMutation(internal.drafts.publishInternal, { owner, draftId: draftId(args["draft_id"]) });
      return { queued, note: "Publishing runs in the background. Call list_drafts to see the result on each platform." };
    }
    case "publish_post": {
      const attached = await media(ctx, owner, args["media_ids"]);
      const id = await ctx.runMutation(internal.drafts.saveInternal, {
        owner,
        text: text(args["text"]),
        accountIds: ids(args["account_ids"]),
        ...(attached ? { mediaIds: attached } : {}),
        ...(await cover(ctx, owner, args["cover_id"])),
      });
      const queued = await ctx.runMutation(internal.drafts.publishInternal, { owner, draftId: id });
      return { draft_id: id, queued, note: "Publishing runs in the background. Call list_drafts to see the result on each platform." };
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
          serverInfo: { name: "buddysocials", version: "1.0.0" },
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
