import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { friendlyConnectError } from "./lib/connectErrors";
import type { Platform } from "../shared/platforms";
import { verifyMetaRequest } from "./lib/signedRequest";
import * as mcp from "./mcp";

const http = httpRouter();

function page(message: string): Response {
  const text = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BuddySocials</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 ui-monospace,Menlo,monospace"><p style="max-width:32ch;padding:24px;border:2px solid #292929">${text}</p>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Android home screen widgets poll this with their read-only token. */
http.route({
  path: "/widget-snapshot",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!/^[0-9a-f]{64}$/.test(token)) return new Response("Unauthorized", { status: 401 });
    const snapshot = await ctx.runQuery(internal.homeWidgets.snapshotForToken, { token, now: Date.now() });
    if (snapshot === null) return new Response("Unauthorized", { status: 401 });
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }),
});

/** Every platform redirects here after the consent screen, then back into the app. */
const PLATFORM_NAME: Record<Platform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  x: "X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Asks the person to confirm which BuddySocials account the platform account goes into before the
 * code is exchanged. Without it, someone could start a sign-in on their own BuddySocials, send the
 * link to a victim, and receive the victim's social account in their dashboard.
 */
function confirmPage(callbackUrl: string, platform: Platform, ownerLabel: string): Response {
  const name = PLATFORM_NAME[platform];
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect ${name}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 ui-monospace,Menlo,monospace">
<form method="post" action="/oauth/callback" style="max-width:36ch;padding:24px;border:2px solid #292929;display:grid;gap:16px">
<p style="margin:0">Connect your ${name} account to the BuddySocials account <b>${escapeHtml(ownerLabel)}</b>?</p>
<p style="margin:0;color:#aaa;font-size:13px">If that isn't you, don't continue: someone else sent you this link.</p>
<input type="hidden" name="callback" value="${escapeHtml(callbackUrl)}">
<button style="font:inherit;padding:12px;background:#e05a4f;color:#000;border:0;cursor:pointer">Connect</button>
</form>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
  });
}

async function finishConnect(ctx: ActionCtx, state: string, callbackUrl: string): Promise<Response> {
  const result = await ctx.runAction(internal.connect.complete, { state, callbackUrl });
  if (result.desktop) {
    // The desktop app sees the new account through its live query; the browser tab only needs to say so.
    return page("error" in result ? result.error : `${result.handle} is connected. You can close this tab and go back to BuddySocials.`);
  }
  if ("error" in result) return back({ error: result.error });
  return back({ connected: result.platform, handle: result.handle, ...(result.existing ? { existing: "1" } : {}) });
}

function back(params: Record<string, string>): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `buddysocials://accounts?${new URLSearchParams(params).toString()}` },
  });
}

http.route({
  path: "/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const attempt = state ? await ctx.runQuery(internal.connectStore.peekAttempt, { state, now: Date.now() }) : null;
    const failed = url.searchParams.get("error");
    if (failed || !state) {
      const detail = [failed, url.searchParams.get("error_reason"), url.searchParams.get("error_description")].filter(Boolean).join(" ");
      const message = attempt ? friendlyConnectError(attempt.platform, detail || "cancel") : "Sign-in was cancelled.";
      return attempt?.desktop ? page(message) : back({ error: message });
    }
    if (attempt === null) return back({ error: "That sign-in link expired. Try connecting again." });
    // Sign-ins started from the Convex CLI have no browser user to confirm with.
    if (attempt.ownerLabel === null) return await finishConnect(ctx, state, request.url);
    return confirmPage(request.url, attempt.platform, attempt.ownerLabel);
  }),
});

http.route({
  path: "/oauth/callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let callback: URL;
    try {
      const form = new URLSearchParams(await request.text());
      callback = new URL(form.get("callback") ?? "");
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const self = new URL(request.url);
    const state = callback.searchParams.get("state");
    if (callback.origin !== self.origin || callback.pathname !== "/oauth/callback" || !state) {
      return new Response("Bad request", { status: 400 });
    }
    return await finishConnect(ctx, state, callback.toString());
  }),
});

/** The desktop app asks this which build is newest for its platform. Nothing here is private. */
http.route({
  path: "/desktop/latest",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const platform = new URL(request.url).searchParams.get("platform") ?? "";
    if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(platform)) return new Response("Bad request", { status: 400 });
    const latest = await ctx.runQuery(internal.desktopReleases.latest, { platform });
    return new Response(JSON.stringify(latest), {
      status: latest === null ? 404 : 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }),
});

/** Reads Meta's form-encoded `signed_request` and checks it against the Instagram and Facebook app secrets. */
async function metaRequest(request: Request) {
  let signed = "";
  try {
    const form = new URLSearchParams(await request.text());
    signed = form.get("signed_request") ?? "";
  } catch {
    return null;
  }
  if (signed === "") return null;
  return await verifyMetaRequest(signed, [
    { platform: "instagram" as const, secret: process.env.INSTAGRAM_CLIENT_SECRET },
    { platform: "facebook" as const, secret: process.env.FACEBOOK_APP_SECRET },
  ]);
}

/** Meta's data deletion callback. Answers with where the person can check progress. */
http.route({
  path: "/meta/data-deletion",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const verified = await metaRequest(request);
    if (verified === null) return new Response("Invalid signed_request", { status: 400 });
    const code = await ctx.runMutation(internal.compliance.metaDeletion, { source: verified.platform, userId: verified.userId });
    const url = `${process.env.CONVEX_SITE_URL}/meta/data-deletion/status?code=${code}`;
    return new Response(JSON.stringify({ url, confirmation_code: code }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }),
});

http.route({
  path: "/meta/data-deletion/status",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const code = new URL(request.url).searchParams.get("code") ?? "";
    if (!/^[0-9a-f]{24}$/.test(code)) return page("That confirmation code is not valid.");
    const status = await ctx.runQuery(internal.compliance.deletionStatus, { code });
    if (status === null) return page(`No deletion request has the code ${code}.`);
    const when = new Date(status.doneAt ?? status.requestedAt).toISOString().slice(0, 10);
    if (status.state === "done") {
      return page(
        status.accountsFound === 0
          ? `Request ${code}: BuddySocials held no data for this account. Nothing was left to delete (${when}).`
          : `Request ${code}: deleted on ${when}. The connected account, its sign-in tokens and its synced posts, stats and comments are gone.`,
      );
    }
    return page(`Request ${code}: received on ${when}. Deletion is in progress and usually finishes within minutes.`);
  }),
});

/** Meta's deauthorize callback: the person removed the app from their Instagram or Facebook settings. */
http.route({
  path: "/meta/deauthorize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const verified = await metaRequest(request);
    if (verified === null) return new Response("Invalid signed_request", { status: 400 });
    await ctx.runMutation(internal.compliance.metaDeauthorize, { source: verified.platform, userId: verified.userId });
    return new Response(null, { status: 200 });
  }),
});

/** The MCP server: one stateless endpoint, signed in through WorkOS AuthKit. */
http.route({ path: "/mcp", method: "POST", handler: mcp.post });
http.route({ path: "/mcp", method: "GET", handler: mcp.noStream });
http.route({ path: "/mcp", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: mcp.protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: mcp.protectedResource });

export default http;
