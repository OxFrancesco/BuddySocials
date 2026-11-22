/**
 * Checks the MCP endpoint's protocol and tools against the dev backend, without posting anything.
 *
 * The endpoint accepts tokens from whichever sign-in service WORKOS_AUTHKIT_DOMAIN names. This
 * check points it at the dev Clerk instance for the length of the run and uses the desktop app's
 * session as the token, so it proves everything except the WorkOS sign-in itself. It restores the
 * setting when it ends.
 *
 * Run: bun e2e/mcp.ts     (after `bun e2e/desktop.ts`, which signs the desktop app in)
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const site = "https://perfect-vole-798.convex.site";
const clerkDomain = "above-werewolf-7240.clerk.accounts.dev";

function convexEnv(args: string[]): string {
  const run = spawnSync("bunx", ["convex", "env", ...args], { cwd: root, encoding: "utf8" });
  return run.stdout.trim();
}

// Refresh the desktop session and record the signed-in email, then read its token.
const fetched = spawnSync(join(root, "desktop/target/debug/buddysocials"), ["--fetch", join(root, "e2e/artifacts/desktop/dashboard.json")], { cwd: root, encoding: "utf8" });
if (fetched.status !== 0) throw new Error(`could not refresh the desktop session: ${fetched.stderr}`);
const session = JSON.parse(readFileSync(join(homedir(), "Library/Application Support/BuddySocials/dev-session.json"), "utf8")) as { id_token: string };

let id = 0;
async function rpc(method: string, params?: unknown, token: string | null = session.id_token) {
  const response = await fetch(`${site}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, challenge: response.headers.get("www-authenticate"), body: (await response.json().catch(() => null)) as any };
}
async function tool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const text = body.result.content[0].text as string;
  return { error: body.result.isError as boolean, value: body.result.isError ? text : JSON.parse(text) };
}
function check(condition: unknown, what: string) {
  if (!condition) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

const before = convexEnv(["get", "WORKOS_AUTHKIT_DOMAIN"]);
convexEnv(["set", "WORKOS_AUTHKIT_DOMAIN", clerkDomain]);
await Bun.sleep(3000);
try {
  const metadata = (await (await fetch(`${site}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
  check(metadata.resource === `${site}/mcp` && metadata.authorization_servers[0] === `https://${clerkDomain}`, "resource metadata names the endpoint and the sign-in service");

  const anonymous = await rpc("tools/list", undefined, null);
  check(anonymous.status === 401 && anonymous.challenge?.includes("resource_metadata="), "no token: 401 with a pointer to the sign-in metadata");
  const forged = await rpc("tools/list", undefined, `${session.id_token.slice(0, -6)}AAAAAA`);
  check(forged.status === 401, "a token with a bad signature is refused");

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  check(init.body.result.protocolVersion === "2025-06-18" && init.body.result.capabilities.tools, "initialize answers with the tools capability");
  const listed = await rpc("tools/list");
  const names = listed.body.result.tools.map((entry: { name: string }) => entry.name);
  check(
    [
      "list_accounts",
      "list_drafts",
      "get_draft",
      "save_draft",
      "delete_draft",
      "schedule_draft",
      "publish_draft",
      "publish_post",
      "update_youtube_video",
      "list_posts",
      "list_comments",
      "get_overview",
    ].every((name) => names.includes(name)),
    "all Studio and publishing tools are listed",
  );

  const accounts = await tool("list_accounts");
  check(!accounts.error && accounts.value.length > 0, `list_accounts returns the owner's ${accounts.value.length} accounts`);
  const target = accounts.value.find((account: { platform: string }) => account.platform === "linkedin") ?? accounts.value[0];

  const posts = await tool("list_posts", { limit: 5 });
  check(!posts.error && Array.isArray(posts.value), "list_posts returns recent published posts");
  const overview = await tool("get_overview", { days: 7 });
  check(!overview.error && Array.isArray(overview.value.days), "get_overview returns daily metrics");

  const marker = `MCP check ${Date.now()}`;
  const saved = await tool("save_draft", {
    title: "MCP Check Title",
    text: marker,
    platform_text: { [target.platform]: `${marker} tailored` },
    youtube_visibility: "public",
    account_ids: [target.accountId],
  });
  check(!saved.error && typeof saved.value.draft_id === "string", "save_draft creates a draft with title & platform_text");
  try {
    const updated = await tool("save_draft", { text: `${marker} (edited)`, account_ids: [target.accountId], draft_id: saved.value.draft_id });
    check(!updated.error && updated.value.draft_id === saved.value.draft_id, "save_draft with draft_id updates the same draft");
    const got = await tool("get_draft", { draft_id: saved.value.draft_id });
    check(!got.error && got.value.title === "MCP Check Title" && got.value.text === `${marker} (edited)`, "get_draft returns the saved draft");
    const drafts = await tool("list_drafts");
    const mine = drafts.value.find((draft: { _id: string }) => draft._id === saved.value.draft_id);
    check(mine?.text === `${marker} (edited)` && mine.status === "draft" && mine.targets[0].accountId === target.accountId, "list_drafts shows it, unpublished, with its target");
    const stranger = await tool("save_draft", { text: "x", account_ids: ["not-an-account"] });
    check(stranger.error, "an unknown account ID is refused with a readable error");
  } finally {
    const removed = await tool("delete_draft", { draft_id: saved.value.draft_id });
    check(!removed.error, "delete_draft removes it");
  }
  const after = await tool("list_drafts");
  check(!after.value.some((draft: { _id: string }) => draft._id === saved.value.draft_id), "the draft is gone");
  console.log("publish_draft and publish_post were not called: they post publicly.");
} finally {
  if (before && !/not found|error/i.test(before)) convexEnv(["set", "WORKOS_AUTHKIT_DOMAIN", before]);
  else convexEnv(["remove", "WORKOS_AUTHKIT_DOMAIN"]);
}
