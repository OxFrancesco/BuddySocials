/**
 * Finds every BuddySocials widget across home screen pages and saves a
 * cropped capture of each (nothing else from the home screen is kept).
 * Usage: bun e2e/capture-all-widgets.ts <prefix>
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS, adb, dump, screenSize, screenshot, sleep } from "./adb";

const prefix = process.argv[2] ?? "widget";
const names = ["Views", "Inbox", "Pulse", "Platforms", "Goals", "Latest post"];
const [width, height] = await screenSize();
const done = new Set<string>();

async function captureVisible() {
  const nodes = await dump();
  for (const node of nodes) {
    if (!names.includes(node.desc) || done.has(node.desc)) continue;
    const slug = node.desc.toLowerCase().replace(/\s+/g, "-");
    await screenshot(`${prefix}-raw`);
    const raw = join(ARTIFACTS, `${prefix}-raw.png`);
    const [x1, y1, x2, y2] = node.bounds;
    Bun.spawnSync(["sips", "-c", String(y2 - y1), String(x2 - x1), "--cropOffset", String(y1), String(x1), raw, "--out", join(ARTIFACTS, `${prefix}-${slug}.png`)], { stdout: "ignore" });
    await unlink(raw);
    done.add(node.desc);
    console.log(`${prefix}-${slug}.png ${x2 - x1}x${y2 - y1}`);
  }
}

for (const direction of [1, -1]) {
  await adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(1500);
  for (let page = 0; page < 6 && done.size < names.length; page++) {
    await captureVisible();
    const [from, to] = direction > 0 ? [0.85, 0.15] : [0.15, 0.85];
    await adb("shell", "input", "swipe", String(width * from), String(height * 0.5), String(width * to), String(height * 0.5), "300");
    await sleep(1500);
  }
}
await adb("shell", "input", "keyevent", "KEYCODE_HOME");
console.log(`missing: ${names.filter((name) => !done.has(name)).join(", ") || "none"}`);
