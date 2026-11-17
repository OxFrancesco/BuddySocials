import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
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
http.route({
  path: "/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const back = (params: Record<string, string>) =>
      new Response(null, {
        status: 302,
        headers: { location: `buddysocials://accounts?${new URLSearchParams(params).toString()}` },
      });
    const state = url.searchParams.get("state");
    if (url.searchParams.get("error") || !state) return back({ error: "Sign-in was cancelled." });
    const result = await ctx.runAction(internal.connect.complete, { state, callbackUrl: request.url });
    if (result.desktop) {
      // The desktop app sees the new account through its live query; the browser tab only needs to say so.
      return page("error" in result ? result.error : `${result.handle} is connected. You can close this tab and go back to BuddySocials.`);
    }
    if ("error" in result) return back({ error: result.error });
    return back({ connected: result.platform, handle: result.handle, ...(result.existing ? { existing: "1" } : {}) });
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

/** The MCP server: one stateless endpoint, signed in through WorkOS AuthKit. */
http.route({ path: "/mcp", method: "POST", handler: mcp.post });
http.route({ path: "/mcp", method: "GET", handler: mcp.noStream });
http.route({ path: "/mcp", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: mcp.protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: mcp.protectedResource });

export default http;
