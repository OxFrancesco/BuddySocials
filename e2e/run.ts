/**
 * End-to-end run on the connected Fold: sign in with Google, load demo data,
 * customise home (resize, configure, add, reorder), open a post, reply to a
 * comment, check accounts. Screenshots and a screen recording land in
 * e2e/artifacts. Usage: bun e2e/run.ts [--skip-sign-in]
 */
import { ARTIFACTS, Recorder, adb, center, drag, dump, find, reveal, screenSize, screenshot, sleep, swipe, tap, tapRevealed, type, waitFor } from "./adb";

const PACKAGE = "com.francescooddo.buddysocials";
const skipSignIn = process.argv.includes("--skip-sign-in");
const GOOGLE_ACCOUNT = process.env.E2E_GOOGLE_ACCOUNT ?? "oddofrancesco000@gmail.com";

function step(name: string) {
  console.log(`\n▸ ${name}`);
}

async function launch() {
  await adb("shell", "am", "force-stop", PACKAGE);
  if (process.argv.includes("--dev")) {
    // Debug builds load the bundle from Metro over USB.
    await adb("reverse", "tcp:8081", "tcp:8081").catch(() => "");
    await adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "buddysocials://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081", PACKAGE);
  } else {
    await adb("shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1");
  }
  await sleep(6000);
}

async function signIn() {
  step("Sign in with Google");
  await screenshot("01-sign-in");
  await tap({ id: "google-sign-in" });
  // Chrome custom tab with Google's account chooser.
  const account = await waitFor({ text: GOOGLE_ACCOUNT }, 30_000);
  const [x, y] = center(account);
  await adb("shell", "input", "tap", String(x), String(y));
  await sleep(2500);
  const proceed = await find({ text: /^(Continue|Continua|Allow|Consenti)$/ });
  if (proceed) {
    const [cx, cy] = center(proceed);
    await adb("shell", "input", "tap", String(cx), String(cy));
  }
}

async function main() {
  const recorder = new Recorder();
  await recorder.begin();
  const [width, height] = await screenSize();
  try {
    await launch();
    if (!skipSignIn) {
      const signInButton = await find({ id: "google-sign-in" });
      if (signInButton) await signIn();
    }

    step("Home");
    const demo = await find({ id: "load-demo" });
    if (demo) {
      await tap({ id: "load-demo" });
      await waitFor({ id: "widget-views" }, 60_000);
      await sleep(6000);
    }
    await waitFor({ id: "widget-views" }, 30_000);
    await sleep(2500);
    await screenshot("02-home");
    await swipe([width / 2, height * 0.75], [width / 2, height * 0.3]);
    await sleep(1200);
    await screenshot("03-home-scrolled");
    await swipe([width / 2, height * 0.3], [width / 2, height * 0.85]);
    await swipe([width / 2, height * 0.3], [width / 2, height * 0.85]);

    step("Customise home");
    await tap({ id: "edit-home" });
    await sleep(1200);
    await screenshot("04-edit-mode");
    await tap({ id: "resize-views" });
    await sleep(1500);
    await screenshot("05-resized");
    await tapRevealed({ id: "edit-trend" });
    await waitFor({ id: "size-l" }, 15_000);
    await sleep(1800);
    await screenshot("06-widget-editor");
    await tapRevealed({ id: "metric-comments" });
    await tapRevealed({ id: "range-28" });
    await sleep(1800);
    await screenshot("07-widget-edited");
    await tap({ id: "widget-done" });
    await sleep(1500);

    await reveal({ id: "add-widget" }).catch(() => undefined);
    await tap({ id: "add-widget" });
    await waitFor({ id: "add-metric" }, 15_000);
    await sleep(2500);
    await screenshot("08-add-widget");
    await tapRevealed({ id: "add-platform" }, 16);
    await sleep(2500);

    // Reorder: back to the top, pick up the views widget and drop it lower.
    for (let i = 0; i < 4; i++) await swipe([width / 2, height * 0.3], [width / 2, height * 0.8], 250);
    const first = await reveal({ id: "widget-views" });
    const [fx, fy] = center(first);
    await drag([fx, fy], [fx, Math.min(height * 0.8, fy + height * 0.3)]);
    await sleep(1200);
    await screenshot("09-reordered");
    await tap({ id: "done-editing" });
    await sleep(1500);
    await swipe([width / 2, height * 0.3], [width / 2, height * 0.85]);
    await screenshot("10-home-customised");

    await recorder.rotate();

    step("Posts");
    await tap({ id: "tab-posts" });
    await sleep(2000);
    await screenshot("11-posts");
    await tap({ id: "posts-filter-youtube" });
    await sleep(1500);
    await screenshot("12-posts-youtube");
    const firstPost = await firstMatching(/^post-/);
    await adb("shell", "input", "tap", String(firstPost[0]), String(firstPost[1]));
    await sleep(2500);
    await screenshot("13-post-detail");
    await swipe([width / 2, height * 0.8], [width / 2, height * 0.25]);
    await sleep(800);
    await screenshot("14-post-comments");
    await tap({ id: "post-back" }).catch(async () => adb("shell", "input", "keyevent", "KEYCODE_BACK"));

    step("Inbox and reply");
    await tap({ id: "tab-inbox" });
    await sleep(2000);
    await screenshot("15-inbox");
    const comment = await firstMatching(/^comment-/);
    await adb("shell", "input", "tap", String(comment[0]), String(comment[1]));
    await waitFor({ id: "reply-input" });
    await sleep(600);
    await type("Thanks! Repo link is in the description");
    await sleep(600);
    await screenshot("16-reply-typed");
    await tap({ id: "send-reply" });
    await sleep(2500);
    await tap({ id: "inbox-state-all" });
    await sleep(2000);
    await screenshot("17-replied");

    step("Accounts");
    await tap({ id: "tab-accounts" });
    await sleep(1500);
    await screenshot("18-accounts");

    await tap({ id: "tab-index" });
    await sleep(1500);
  } finally {
    await recorder.stop();
    const files = await recorder.pull();
    console.log(`\nArtifacts in ${ARTIFACTS}\n${files.join("\n")}`);
  }
}

/** Center of the first view whose test ID matches. */
async function firstMatching(pattern: RegExp): Promise<[number, number]> {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const node = (await dump()).find((candidate) => pattern.test(candidate.id.replace(/^.*:id\//, "")));
    if (node) return center(node);
    await sleep(500);
  }
  throw new Error(`Nothing matches ${pattern}`);
}

await main();
