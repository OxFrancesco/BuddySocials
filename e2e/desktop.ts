/**
 * End-to-end check of the desktop app against the dev backend.
 *
 * 1. Starts the app without a window (`--fetch`), which begins a real OAuth sign-in.
 * 2. Signs the dev user in through Clerk in a headless browser, using a one-time ticket
 *    from the Clerk CLI, and lets Clerk redirect to the app's loopback address.
 * 3. Waits for the app to load every dashboard query, then renders each screen to a PNG
 *    from that data.
 *
 * Run: bun e2e/desktop.ts            (needs `cargo build` in desktop/ and the Clerk CLI)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "e2e/artifacts/desktop");
const bin = join(root, "desktop/target/debug/buddysocials");
const fixture = join(out, "dashboard.json");
mkdirSync(out, { recursive: true });

function clerk(args: string[]): unknown {
  const run = spawnSync("clerk", args, { cwd: root, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`clerk ${args[0]} failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

// A fresh sign-in every run: the point is to exercise the whole flow.
rmSync(join(homedir(), "Library/Application Support/BuddySocials/dev-session.json"), { force: true });

const app = spawn(bin, ["--fetch", fixture], { cwd: root });
let log = "";
app.stdout.on("data", (chunk) => (log += chunk));
app.stderr.on("data", (chunk) => (log += chunk));
const exited = new Promise<number>((resolve) => app.on("exit", (code) => resolve(code ?? 1)));

async function waitFor(pattern: RegExp, seconds: number): Promise<RegExpMatchArray> {
  for (let i = 0; i < seconds * 4; i++) {
    const match = log.match(pattern);
    if (match) return match;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${pattern}\n${log.replace(/code_challenge=[^&\s]+/g, "code_challenge=…")}`);
}

try {
  const authorizeUrl = (await waitFor(/^OPEN (\S+)$/m, 30))[1]!;
  const users = clerk(["api", "/users"]) as { id: string }[] | { data: { id: string }[] };
  const userId = (Array.isArray(users) ? users : users.data)[0]!.id;
  const ticket = clerk(["api", "/sign_in_tokens", "-X", "POST", "-d", JSON.stringify({ user_id: userId, expires_in_seconds: 120 }), "--yes"]) as { url: string };

  const { chromium } = await import(join(homedir(), ".bun/install/global/node_modules/playwright-core/index.mjs"));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(ticket.url);
  // The ticket signs the browser in and lands on the account portal.
  await page.waitForURL((url: URL) => !url.searchParams.has("__clerk_ticket") && !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
  await page.goto(authorizeUrl);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/callback/, { timeout: 30_000 });
  await page.screenshot({ path: join(out, "signed-in-browser.png") });
  const said = (await page.innerText("body")).trim();
  await browser.close();
  if (!said.startsWith("You're signed in")) throw new Error(`callback page said: ${said}`);

  const fetched = await waitFor(/^FETCHED (\d+) queries$/m, 60);
  if ((await exited) !== 0) throw new Error("the app exited with an error");
  console.log(`signed in over OAuth and loaded ${fetched[1]} live queries`);

  const scenes = ["home", "posts", "inbox", "goals", "accounts", "signed-out"];
  for (const scene of scenes) {
    const args = ["--snap", join(out, `${scene}.png`), "--scale", "2", "--size", "1180x760"];
    if (scene !== "home") args.push("--scene", scene);
    const run = spawnSync(bin, args, { cwd: root, encoding: "utf8", env: { ...process.env, BUDDYSOCIALS_FIXTURE: fixture } });
    if (run.status !== 0) throw new Error(`snapshot ${scene} failed: ${run.stderr}`);
  }
  spawnSync(bin, ["--tree", join(out, "home-tree.json")], { cwd: root, env: { ...process.env, BUDDYSOCIALS_FIXTURE: fixture } });
  console.log(`screens written to ${out}`);
} finally {
  app.kill();
}
