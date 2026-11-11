import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

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
    if ("error" in result) return back({ error: result.error });
    return back({ connected: result.platform, handle: result.handle, ...(result.existing ? { existing: "1" } : {}) });
  }),
});

export default http;
