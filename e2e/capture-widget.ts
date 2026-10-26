/**
 * Screenshots only the BuddySocials home screen widgets, cropped to their
 * bounds so nothing else on the home screen is captured.
 * Usage: bun e2e/capture-widget.ts <name> [Views|Inbox|Pulse]
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS, dump, screenshot } from "./adb";

const name = process.argv[2] ?? "widget";
const label = process.argv[3];
const nodes = await dump();
const hosts = nodes.filter((node) => node.id.endsWith("rn_widget_clickable_container") || (label !== undefined && node.desc === label));
const target = label ? nodes.find((node) => node.desc === label) : hosts[0];
if (!target) throw new Error("No BuddySocials widget on screen");
await screenshot(`${name}-raw`);
const raw = join(ARTIFACTS, `${name}-raw.png`);
const [x1, y1, x2, y2] = target.bounds;
Bun.spawnSync(["sips", "-c", String(y2 - y1), String(x2 - x1), "--cropOffset", String(y1), String(x1), raw, "--out", join(ARTIFACTS, `${name}.png`)], { stdout: "ignore" });
await unlink(raw);
console.log(`${name}.png ${x2 - x1}x${y2 - y1}`);
