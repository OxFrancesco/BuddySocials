/**
 * Records the demo video footage: one clip per scene, paced for watching.
 * Usage: bun e2e/record-demo.ts [scene...]   scenes: home customise post inbox goals
 */
import { join } from "node:path";
import { ARTIFACTS, Recorder, adb, center, drag, dump, reveal, screenSize, sleep, swipe, tap, tapAt, tapRevealed, type, waitFor } from "./adb";

const PACKAGE = "com.francescooddo.buddysocials";
const wanted = process.argv.slice(2);
const [width, height] = await screenSize();

async function slowScroll(fromY: number, toY: number, ms = 900) {
  await swipe([width / 2, height * fromY], [width / 2, height * toY], ms);
}

async function firstMatching(pattern: RegExp): Promise<[number, number]> {
  for (let i = 0; i < 40; i++) {
    const node = (await dump()).find((candidate) => pattern.test(candidate.id.replace(/^.*:id\//, "")));
    if (node) return center(node);
    await sleep(500);
  }
  throw new Error(`Nothing matches ${pattern}`);
}

async function record(name: string, run: () => Promise<void>) {
  if (wanted.length > 0 && !wanted.includes(name)) return;
  console.log(`▸ ${name}`);
  const recorder = new Recorder();
  await recorder.begin();
  await sleep(600);
  try {
    await run();
    await sleep(800);
  } finally {
    await recorder.stop();
    const [file] = await recorder.pull();
    if (file) {
      const target = join(ARTIFACTS, `scene-${name}.mp4`);
      await Bun.write(target, Bun.file(file));
      console.log(`  ${target}`);
    }
  }
}

async function freshHome() {
  await adb("shell", "am", "force-stop", PACKAGE);
  await adb("shell", "am", "start", "-n", `${PACKAGE}/.MainActivity`);
  await waitFor({ id: "widget-views" }, 45_000);
  await sleep(1500);
}

await freshHome();

await record("home", async () => {
  await sleep(2200);
  await slowScroll(0.75, 0.35, 1200);
  await sleep(1600);
  await slowScroll(0.75, 0.35, 1200);
  await sleep(1600);
  await slowScroll(0.75, 0.35, 1200);
  await sleep(1800);
  for (let i = 0; i < 4; i++) await swipe([width / 2, height * 0.3], [width / 2, height * 0.85], 300);
  await sleep(800);
});

await record("customise", async () => {
  await sleep(1200);
  for (let attempt = 0; attempt < 3; attempt++) {
    await tap({ id: "edit-home" });
    if (await waitFor({ id: "resize-views" }, 4000).then(() => true).catch(() => false)) break;
  }
  await sleep(1000);
  await tap({ id: "resize-views" });
  await sleep(1600);
  await tapRevealed({ id: "edit-trend" });
  await waitFor({ id: "size-l" }, 15_000);
  await sleep(1400);
  await tapRevealed({ id: "metric-likes" });
  await sleep(900);
  await tapRevealed({ id: "range-28" });
  await sleep(1600);
  await tap({ id: "widget-done" });
  await sleep(1400);
  await tap({ id: "add-widget" });
  await waitFor({ id: "add-metric" }, 15_000);
  await sleep(1600);
  await slowScroll(0.75, 0.35, 900);
  await sleep(900);
  await tapRevealed({ id: "add-goals" }, 16);
  await sleep(1800);
  for (let i = 0; i < 4; i++) await swipe([width / 2, height * 0.3], [width / 2, height * 0.85], 250);
  await sleep(600);
  const views = await reveal({ id: "widget-views" });
  const [x, y] = center(views);
  await drag([x, y], [x, Math.min(height * 0.78, y + height * 0.3)], 500);
  await sleep(1400);
  await tap({ id: "done-editing" });
  await sleep(1600);
});

await record("post", async () => {
  await tap({ id: "tab-posts" });
  await sleep(1600);
  await tap({ id: "posts-filter-youtube" });
  await sleep(1400);
  const [x, y] = await firstMatching(/^post-/);
  await tapAt(x, y);
  await sleep(2400);
  await slowScroll(0.75, 0.4, 1000);
  await sleep(1600);
  await tap({ id: "post-back" }).catch(async () => adb("shell", "input", "keyevent", "KEYCODE_BACK"));
  await sleep(800);
});

await record("inbox", async () => {
  await tap({ id: "tab-inbox" });
  await sleep(1800);
  const [x, y] = await firstMatching(/^comment-/);
  await tapAt(x, y);
  await waitFor({ id: "reply-input" });
  await sleep(900);
  await type("Plex Mono. Same as the site");
  await sleep(1200);
  await tap({ id: "send-reply" });
  await sleep(2200);
  await tap({ id: "inbox-state-all" });
  await sleep(2400);
});

await record("goals", async () => {
  await tap({ id: "tab-goals" });
  await sleep(2200);
  await tap({ id: "add-goal" });
  await waitFor({ id: "goal-target" });
  await sleep(900);
  await tap({ id: "goal-target" });
  await type("1200");
  await adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(700);
  await tap({ id: "goal-metric-likes" });
  await sleep(700);
  await tap({ id: "goal-when-week" });
  await sleep(900);
  await tap({ id: "save-goal" });
  await sleep(4200);
  await tap({ id: "celebration" }).catch(() => undefined);
  await sleep(2200);
});
