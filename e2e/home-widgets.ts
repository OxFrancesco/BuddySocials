/**
 * Adds the BuddySocials widgets to the One UI home screen and screenshots
 * them. Usage: bun e2e/home-widgets.ts [Views Inbox Pulse]
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS, adb, center, dump, find, screenSize, screenshot, sleep, swipe, tapAt, type Selector } from "./adb";

const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["Views", "Inbox", "Pulse"];

async function tapNode(selector: Selector, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const node = await find(selector);
    if (node) {
      const [x, y] = center(node);
      await tapAt(x, y);
      await sleep(1200);
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function openWidgetPicker() {
  await adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  const [width, height] = await screenSize();
  // Long-press an empty spot near the top of the home screen.
  await adb("shell", "input", "swipe", String(width / 2), String(Math.round(height * 0.3)), String(width / 2), String(Math.round(height * 0.3)), "1200");
  await sleep(1500);
  if (!(await tapNode({ text: /^Widgets$/ }))) throw new Error("No Widgets button after long-press");
  await sleep(1000);
  // One UI lists apps alphabetically; search is faster when it exists.
  const search = await find({ text: /^Search/ });
  if (search) {
    const [x, y] = center(search);
    await tapAt(x, y);
    await sleep(800);
    await adb("shell", "input", "text", "BuddySocials");
    await sleep(1500);
  }
  for (let i = 0; i < 8 && !(await find({ text: /BuddySocials/ })); i++) await swipe([width / 2, height * 0.75], [width / 2, height * 0.35]);
  if (!(await tapNode({ text: /BuddySocials/ }))) throw new Error("BuddySocials not in widget list");
}

async function addWidget(label: string) {
  await openWidgetPicker();
  await sleep(1000);
  if (!(await tapNode({ text: label }))) throw new Error(`Widget ${label} not offered`);
  // One UI shows an "Add" button under the selected widget preview.
  await tapNode({ text: /^Add$/ }, 5_000);
  await sleep(2500);
  // The widget task handler renders asynchronously; give it a moment.
  await sleep(4000);
}

for (const label of wanted) {
  console.log(`adding ${label}`);
  await addWidget(label);
}
await adb("shell", "input", "keyevent", "KEYCODE_HOME");
await sleep(3000);
// Capture only our widgets: crop the screenshot to the views BuddySocials draws.
await screenshot("20-home-raw");
const ours = (await dump()).filter((node) => node.pkg === "com.francescooddo.buddysocials");
const raw = join(ARTIFACTS, "20-home-raw.png");
if (ours.length > 0) {
  const x1 = Math.min(...ours.map((n) => n.bounds[0]));
  const y1 = Math.min(...ours.map((n) => n.bounds[1]));
  const x2 = Math.max(...ours.map((n) => n.bounds[2]));
  const y2 = Math.max(...ours.map((n) => n.bounds[3]));
  const out = join(ARTIFACTS, "20-home-screen-widgets.png");
  Bun.spawnSync(["sips", "-c", String(y2 - y1), String(x2 - x1), "--cropOffset", String(y1), String(x1), raw, "--out", out]);
  console.log(`cropped to ${x2 - x1}x${y2 - y1}`);
} else {
  console.log("no BuddySocials widget views found on screen");
}
await unlink(raw);
