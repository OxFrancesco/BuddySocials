"use node";

import {
  SocialError,
  defineAdapter,
  type CapabilityManifest,
  type JsonObject,
  type MetricValue,
  type SocialAdapter,
  type SocialErrorCode,
} from "@opencoredev/social-sdk";
import type { PlatformCredential } from "./client";

/**
 * Facebook Pages, hand-rolled on the Graph API: the Social SDK has no Facebook adapter.
 *
 * Sign-in is Facebook Login with the app's FACEBOOK_APP_ID / FACEBOOK_APP_SECRET. The code becomes a
 * short-lived user token, which is swapped for a long-lived one; /me/accounts then lists the Pages
 * the person manages, each with its own Page token. A Page token taken from a long-lived user token
 * has no expiry, so every Page is stored as its own account holding only its Page token.
 */

/** One Graph API version for every Facebook call. */
export const GRAPH_VERSION = "v27.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
/** Video uploads go to Meta's video host. */
const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VERSION}`;
const SOURCE = `facebook:${GRAPH_VERSION}`;

/**
 * List the Pages, read their posts, insights and comments, reply to comments, and post.
 * Everything beyond pages_show_list needs Meta's App Review before people outside the app's roles can grant it.
 */
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  "pages_manage_engagement",
  "read_insights",
];

/** The permission that lets the app post as the Page. */
export const FACEBOOK_POSTING_SCOPE = "pages_manage_posts";

/** Page tasks that allow creating posts. */
const POSTING_TASKS = new Set(["CREATE_CONTENT", "MANAGE"]);

export function facebookApp(): { appId: string; appSecret: string } | null {
  const appId = process.env.FACEBOOK_APP_ID?.trim();
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim();
  return appId && appSecret ? { appId, appSecret } : null;
}

function requireApp() {
  const app = facebookApp();
  if (app === null) throw new Error("Facebook is not set up on the server yet.");
  return app;
}

function scopes(): string[] {
  const override = process.env.FACEBOOK_SCOPES;
  return override ? override.split(/[\s,]+/).filter(Boolean) : SCOPES;
}

/**
 * The Facebook Login dialog. A "Facebook Login for Business" configuration (FACEBOOK_LOGIN_CONFIG_ID)
 * replaces the scope list when set. `another` asks Facebook to show the login again and re-ask for
 * permissions declined last time.
 */
export function authorizationUrl(state: string, redirectUri: string, { another = false }: { another?: boolean } = {}): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", requireApp().appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configId = process.env.FACEBOOK_LOGIN_CONFIG_ID?.trim();
  if (configId) url.searchParams.set("config_id", configId);
  else url.searchParams.set("scope", scopes().join(","));
  url.searchParams.set("auth_type", another ? "reauthenticate,rerequest" : "rerequest");
  return url.toString();
}

type GraphError = { message?: string; type?: string; code?: number; error_subcode?: number };

/** What Meta's error codes mean: https://developers.facebook.com/docs/graph-api/guides/error-handling */
function socialCode(status: number, error: GraphError | undefined): SocialErrorCode {
  const code = error?.code;
  if (code === 190 || code === 102 || status === 401) return "reconnect_required";
  if (code === 10 || (code !== undefined && code >= 200 && code < 300) || status === 403) return "missing_permission";
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80001 || status === 429) return "rate_limited";
  if (code === 100 && error?.error_subcode === 33) return "not_found";
  if (code === 368) return "upstream_failure";
  if (code === 100) return "invalid_input";
  return "upstream_failure";
}

async function graph(
  url: string,
  operation: string,
  { token, method = "GET", body }: { token: string; method?: "GET" | "POST"; body?: JsonObject },
): Promise<JsonObject> {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json().catch(() => ({}))) as JsonObject & { error?: GraphError };
  if (response.ok && data.error === undefined) return data;
  const error = data.error;
  const code = socialCode(response.status, error);
  throw new SocialError({
    code,
    operation,
    message: error?.message ? `Facebook: ${error.message}` : `Facebook answered HTTP ${response.status}.`,
    upstreamStatus: response.status,
    ...(error?.code !== undefined ? { upstreamCode: String(error.code) } : {}),
    ...(code === "reconnect_required" ? { retryDisposition: { kind: "after-reconnect" } } : {}),
  });
}

function query(path: string, params: Record<string, string | number>): string {
  const url = new URL(`${GRAPH}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

/** Graph's `paging.next` links stay on the Graph host; anything else would send the token elsewhere. */
function nextLink(page: JsonObject): string | undefined {
  const next = (page["paging"] as JsonObject | undefined)?.["next"];
  if (typeof next !== "string") return undefined;
  const url = new URL(next);
  url.searchParams.delete("access_token");
  return url.protocol === "https:" && url.hostname === "graph.facebook.com" ? url.toString() : undefined;
}

async function tokenRequest(params: Record<string, string>): Promise<{ accessToken: string; expiresIn?: number }> {
  const app = requireApp();
  const url = new URL(`${GRAPH}/oauth/access_token`);
  for (const [key, value] of Object.entries({ ...params, client_id: app.appId, client_secret: app.appSecret })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  const data = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown; error?: GraphError };
  if (!response.ok || typeof data.access_token !== "string") {
    throw new Error(`Facebook did not issue a token: ${data.error?.message ?? response.status}`);
  }
  return { accessToken: data.access_token, ...(typeof data.expires_in === "number" ? { expiresIn: data.expires_in } : {}) };
}

/** Exchanges the callback's code for a long-lived user token. */
export async function exchangeCode(callbackUrl: string, redirectUri: string): Promise<string> {
  const params = new URL(callbackUrl).searchParams;
  const error = params.get("error");
  if (error) throw new Error(params.get("error_description") ?? params.get("error_reason") ?? error);
  const code = params.get("code");
  if (!code) throw new Error("Facebook sent no authorization code.");
  const short = await tokenRequest({ code, redirect_uri: redirectUri });
  const long = await tokenRequest({ grant_type: "fb_exchange_token", fb_exchange_token: short.accessToken });
  return long.accessToken;
}

export type FacebookPage = { id: string; name: string; handle: string; credential: PlatformCredential };

/** The permissions the person granted, which Pages inherit. */
async function grantedScopes(userToken: string): Promise<string[]> {
  const result = await graph(query("/me/permissions", {}), "accounts.read", { token: userToken }).catch(() => ({}) as JsonObject);
  const rows = Array.isArray(result["data"]) ? (result["data"] as JsonObject[]) : [];
  return rows.flatMap((row) => (row["status"] === "granted" && typeof row["permission"] === "string" ? [row["permission"]] : []));
}

/** Every Page the person may post to, each with its own non-expiring Page token. */
export async function administeredPages(userToken: string): Promise<FacebookPage[]> {
  const granted = await grantedScopes(userToken);
  const pages: FacebookPage[] = [];
  let next: string | undefined = query("/me/accounts", { fields: "id,name,username,access_token,tasks", limit: 100 });
  for (let round = 0; next && round < 10; round++) {
    const page: JsonObject = await graph(next, "accounts.read", { token: userToken });
    for (const row of Array.isArray(page["data"]) ? (page["data"] as JsonObject[]) : []) {
      const id = row["id"];
      const token = row["access_token"];
      if (typeof id !== "string" || typeof token !== "string") continue;
      const tasks = Array.isArray(row["tasks"]) ? (row["tasks"] as unknown[]) : null;
      // Without a task list (older Pages experience) the Page token itself decides what is allowed.
      if (tasks !== null && !tasks.some((task) => typeof task === "string" && POSTING_TASKS.has(task))) continue;
      const name = typeof row["name"] === "string" && row["name"] ? row["name"] : `Facebook Page ${id}`;
      const handle = typeof row["username"] === "string" && row["username"] ? row["username"] : name;
      pages.push({ id, name, handle, credential: { accessToken: token, ...(granted.length > 0 ? { scopes: granted } : {}) } });
    }
    next = nextLink(page);
  }
  return pages;
}

// ---------------------------------------------------------------- reading

function metric(name: string, value: unknown): MetricValue[] {
  return typeof value === "number" && Number.isFinite(value)
    ? [{ name, value, unit: "count", period: "lifetime", fetchedAt: new Date().toISOString(), freshness: "unknown", source: SOURCE } as MetricValue]
    : [];
}

const POST_FIELDS = "id,message,created_time,permalink_url,full_picture,status_type";
/** Counters every Page post carries, without insights. */
const COUNT_FIELDS = "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)";
/** Post insights that replaced impressions in v25: views, unique viewers, clicks. */
const INSIGHTS = ["post_media_view", "post_total_media_view_unique", "post_clicks"];
const INSIGHT_FIELD = `insights.metric(${INSIGHTS.join(",")})`;

/** Splits a post row into the record extractPost reads and its counters. */
function splitRow(row: JsonObject): { record: JsonObject; metrics: MetricValue[] } {
  const { shares, reactions, comments, insights, ...record } = row;
  const total = (edge: unknown) => ((edge as JsonObject | undefined)?.["summary"] as JsonObject | undefined)?.["total_count"];
  const values: MetricValue[] = [
    ...metric("reactions", total(reactions)),
    ...metric("comments", total(comments)),
    // A post nobody shared has no `shares` field at all.
    ...metric("shares", (shares as JsonObject | undefined)?.["count"] ?? (reactions !== undefined ? 0 : undefined)),
  ];
  const data = (insights as JsonObject | undefined)?.["data"];
  for (const entry of Array.isArray(data) ? (data as JsonObject[]) : []) {
    const first = Array.isArray(entry["values"]) ? (entry["values"] as JsonObject[])[0] : undefined;
    values.push(...metric(String(entry["name"]), first?.["value"]));
  }
  return { record, metrics: values };
}

/**
 * The Page's own posts with their counters, one request per page of up to 100. Insights need
 * read_insights and fail on some post types, so a refused request is read again without them.
 */
export async function facebookPosts(pageId: string, token: string, limit: number): Promise<{ records: JsonObject[]; metrics: Map<string, MetricValue[]> }> {
  async function read(fields: string) {
    const records: JsonObject[] = [];
    const metrics = new Map<string, MetricValue[]>();
    let next: string | undefined = query(`/${encodeURIComponent(pageId)}/published_posts`, { fields, limit: Math.min(limit, 100) });
    while (next && records.length < limit) {
      const page: JsonObject = await graph(next, "posts.list", { token });
      for (const row of Array.isArray(page["data"]) ? (page["data"] as JsonObject[]) : []) {
        const { record, metrics: values } = splitRow(row);
        records.push(record);
        metrics.set(String(record["id"]), values);
      }
      next = nextLink(page);
    }
    return { records: records.slice(0, limit), metrics };
  }
  try {
    return await read(`${POST_FIELDS},${COUNT_FIELDS},${INSIGHT_FIELD}`);
  } catch (error) {
    if (error instanceof SocialError && error.code === "reconnect_required") throw error;
    return await read(`${POST_FIELDS},${COUNT_FIELDS}`);
  }
}

async function postMetrics(postId: string, token: string): Promise<MetricValue[]> {
  const row = await graph(query(`/${encodeURIComponent(postId)}`, { fields: `id,${COUNT_FIELDS}` }), "analytics.post.read", { token });
  const { metrics } = splitRow(row);
  const insights = await graph(query(`/${encodeURIComponent(postId)}/insights`, { metric: INSIGHTS.join(",") }), "analytics.post.read", { token }).catch(
    () => null,
  );
  if (insights !== null) metrics.push(...splitRow({ insights }).metrics);
  return metrics;
}

const CAPABILITIES: CapabilityManifest = {
  schemaVersion: 1,
  backend: "facebook",
  apiRevision: GRAPH_VERSION,
  runtime: ["node"],
  capabilities: [
    { operation: "accounts.read", platform: "facebook", availability: "available" },
    { operation: "posts.list", platform: "facebook", availability: "available" },
    { operation: "posts.read", platform: "facebook", availability: "available" },
    { operation: "comments.read", platform: "facebook", availability: "available" },
    { operation: "comments.write", platform: "facebook", availability: "available" },
    { operation: "analytics.read", platform: "facebook", availability: "available" },
    { operation: "analytics.account.read", platform: "facebook", availability: "available" },
  ],
};

/** An SDK-shaped adapter for one Page, so sync and replies run the same path as the other platforms. Posting is in publishToPage. */
export function facebookAdapter(pageId: string, token: string): SocialAdapter<never> {
  return defineAdapter<never, SocialAdapter<never>>({
    id: "facebook",
    capabilities: CAPABILITIES,
    accounts: {
      async list() {
        return { items: [] };
      },
      async get(ref) {
        const page = await graph(query(`/${encodeURIComponent(pageId)}`, { fields: "id,name,username" }), "accounts.read", { token });
        const name = typeof page["name"] === "string" ? page["name"] : pageId;
        return { ref, displayName: name, handle: typeof page["username"] === "string" ? page["username"] : name, status: "connected" };
      },
    },
    posts: {
      async list(_account, input) {
        const url = input.cursor ?? query(`/${encodeURIComponent(pageId)}/published_posts`, { fields: POST_FIELDS, limit: Math.min(input.limit ?? 25, 100) });
        const page = await graph(url, "posts.list", { token });
        const next = nextLink(page);
        return { items: Array.isArray(page["data"]) ? (page["data"] as JsonObject[]) : [], ...(next ? { nextCursor: next } : {}) };
      },
      async get(ref) {
        return await graph(query(`/${encodeURIComponent(ref.postId)}`, { fields: POST_FIELDS }), "posts.read", { token });
      },
      prepareTarget() {
        return [];
      },
      async publishTarget() {
        throw new SocialError({ code: "unsupported_capability", operation: "posts.publish", message: "Facebook posts go through publishToPage." });
      },
    },
    comments: {
      async list(post, input) {
        const url =
          input.cursor ??
          query(`/${encodeURIComponent(post.postId)}/comments`, {
            filter: "stream",
            order: "reverse_chronological",
            fields: "id,message,created_time,like_count,from{id,name},parent{id}",
            limit: Math.min(input.limit ?? 25, 100),
          });
        const page = await graph(url, "comments.read", { token });
        const items = (Array.isArray(page["data"]) ? (page["data"] as JsonObject[]) : []).map((row): JsonObject => {
          const from = (row["from"] ?? {}) as JsonObject;
          const parent = (row["parent"] ?? {}) as JsonObject;
          return {
            id: String(row["id"]),
            text: typeof row["message"] === "string" ? row["message"] : "",
            ...(typeof row["created_time"] === "string" ? { createdAt: row["created_time"] } : {}),
            // Meta leaves out who wrote a comment unless that person shared it with the app.
            ...(typeof from["name"] === "string" ? { authorName: from["name"] } : {}),
            ...(typeof from["id"] === "string" ? { author_id: from["id"] } : {}),
            ...(typeof parent["id"] === "string" ? { parentId: parent["id"] } : {}),
            ...(typeof row["like_count"] === "number" ? { likeCount: row["like_count"] } : {}),
          };
        });
        const next = nextLink(page);
        return { items, ...(next ? { nextCursor: next } : {}) };
      },
      async reply(comment, content) {
        const result = await graph(`${GRAPH}/${encodeURIComponent(comment.commentId)}/comments`, "comments.write", {
          token,
          method: "POST",
          body: { message: content.text },
        });
        return { ...comment, commentId: String(result["id"] ?? comment.commentId) };
      },
    },
    analytics: {
      async getPostMetrics(post) {
        return await postMetrics(post.postId, token);
      },
      async getAccountMetrics() {
        const page = await graph(query(`/${encodeURIComponent(pageId)}`, { fields: "followers_count,fan_count" }), "analytics.account.read", { token });
        return metric("followers_count", page["followers_count"] ?? page["fan_count"]);
      },
    },
  });
}

// ---------------------------------------------------------------- posting

export type FacebookPostInput = {
  text: string;
  /** Public links Facebook fetches each image from. */
  images: string[];
  video?: { url: string; title?: string };
};

export type FacebookPostResult = { postId: string; permalink: string };

/** The first web link in the text, shared as the post's link preview when there is no media. */
function firstLink(text: string): string | undefined {
  return /https?:\/\/[^\s<>"']+/i.exec(text)?.[0]?.replace(/[.,;:!?)\]]+$/, "");
}

/** Posts text, a link, up to ten images, or one video to the Page. */
export async function publishToPage(pageId: string, token: string, input: FacebookPostInput): Promise<FacebookPostResult> {
  const page = encodeURIComponent(pageId);
  if (input.video) {
    // Facebook fetches the file itself and keeps processing it after answering.
    const result = await graph(`${GRAPH_VIDEO}/${page}/videos`, "posts.publish", {
      token,
      method: "POST",
      body: { file_url: input.video.url, description: input.text, ...(input.video.title ? { title: input.video.title } : {}) },
    });
    const id = String(result["id"] ?? "");
    if (!id) throw new Error("Facebook took the video but gave no ID. Check the Page before publishing again.");
    return { postId: id, permalink: `https://www.facebook.com/${pageId}/videos/${id}` };
  }
  if (input.images.length === 1) {
    const result = await graph(`${GRAPH}/${page}/photos`, "posts.publish", {
      token,
      method: "POST",
      body: { url: input.images[0]!, ...(input.text ? { message: input.text } : {}) },
    });
    const id = String(result["post_id"] ?? result["id"] ?? "");
    return { postId: id, permalink: `https://www.facebook.com/${id}` };
  }
  // Several photos are each uploaded unpublished, then one post carries them all.
  const attached: { media_fbid: string }[] = [];
  for (const url of input.images) {
    const photo = await graph(`${GRAPH}/${page}/photos`, "posts.publish", { token, method: "POST", body: { url, published: false } });
    attached.push({ media_fbid: String(photo["id"]) });
  }
  const link = attached.length === 0 ? firstLink(input.text) : undefined;
  const result = await graph(`${GRAPH}/${page}/feed`, "posts.publish", {
    token,
    method: "POST",
    body: {
      ...(input.text ? { message: input.text } : {}),
      ...(link ? { link } : {}),
      ...(attached.length > 0 ? { attached_media: attached } : {}),
    },
  });
  const id = String(result["id"] ?? "");
  if (!id) throw new Error("Facebook gave no answer about the post. Check the Page before publishing again.");
  return { postId: id, permalink: `https://www.facebook.com/${id}` };
}
