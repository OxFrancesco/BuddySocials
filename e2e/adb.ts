/**
 * A small adb driver for end-to-end runs on a real device: find views in the
 * UI hierarchy by test ID, text or accessibility label, tap them, type, take
 * screenshots and record the screen.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SERIAL = process.env.ANDROID_SERIAL ?? "R3GL708X7KJ";
export const ARTIFACTS = join(import.meta.dir, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

type Node = { id: string; text: string; desc: string; pkg: string; bounds: [number, number, number, number]; clickable: boolean };

export async function adb(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["adb", "-s", SERIAL, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`adb ${args.join(" ")} failed: ${err || out}`);
  return out;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(value: string) {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export async function dump(): Promise<Node[]> {
  let xml = "";
  for (let attempt = 0; attempt < 4 && !xml.includes("<hierarchy"); attempt++) {
    await adb("shell", "uiautomator", "dump", "/sdcard/bs-ui.xml").catch(() => "");
    xml = await adb("shell", "cat", "/sdcard/bs-ui.xml").catch(() => "");
    if (!xml.includes("<hierarchy")) await sleep(400);
  }
  const nodes: Node[] = [];
  for (const match of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attrs = match[1]!;
    const get = (name: string) => decode(attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "");
    const b = get("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    nodes.push({
      id: get("resource-id"),
      text: get("text"),
      desc: get("content-desc"),
      pkg: get("package"),
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
      clickable: get("clickable") === "true",
    });
  }
  return nodes;
}

export type Selector = { id?: string; text?: string | RegExp; desc?: string | RegExp };

function matches(node: Node, selector: Selector) {
  const test = (value: string, expected: string | RegExp) =>
    typeof expected === "string" ? value === expected : expected.test(value);
  if (selector.id && !(node.id === selector.id || node.id.endsWith(`:id/${selector.id}`))) return false;
  if (selector.text && !test(node.text, selector.text)) return false;
  if (selector.desc && !test(node.desc, selector.desc)) return false;
  const [x1, y1, x2, y2] = node.bounds;
  return x2 > x1 && y2 > y1;
}

export async function find(selector: Selector): Promise<Node | undefined> {
  return (await dump()).find((node) => matches(node, selector));
}

export async function waitFor(selector: Selector, timeout = 20_000): Promise<Node> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const node = await find(selector);
    if (node) return node;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(selector, (_, v) => (v instanceof RegExp ? v.source : v))}`);
}

export function center(node: Node): [number, number] {
  const [x1, y1, x2, y2] = node.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

export async function tapAt(x: number, y: number) {
  await adb("shell", "input", "tap", String(x), String(y));
}

export async function tap(selector: Selector, timeout?: number) {
  const node = await waitFor(selector, timeout);
  const [x, y] = center(node);
  await tapAt(x, y);
  await sleep(450);
  return node;
}

export async function type(text: string) {
  // `input text` needs spaces as %s and shell metacharacters escaped.
  const escaped = text.replace(/([\\"'`$&|;<>()])/g, "\\$1").replace(/ /g, "%s");
  await adb("shell", "input", "text", escaped);
}

/** Long-press, then move: what a finger does to pick up a sortable item. */
export async function drag(from: [number, number], to: [number, number], holdMs = 450) {
  await adb("shell", "input", "motionevent", "DOWN", String(from[0]), String(from[1]));
  await sleep(holdMs);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from[0] + ((to[0] - from[0]) * i) / steps);
    const y = Math.round(from[1] + ((to[1] - from[1]) * i) / steps);
    await adb("shell", "input", "motionevent", "MOVE", String(x), String(y));
    await sleep(40);
  }
  await sleep(250);
  await adb("shell", "input", "motionevent", "UP", String(to[0]), String(to[1]));
  await sleep(600);
}

export async function swipe(from: [number, number], to: [number, number], ms = 350) {
  await adb("shell", "input", "swipe", String(from[0]), String(from[1]), String(to[0]), String(to[1]), String(ms));
  await sleep(500);
}

/** The Fold has two panels; capture whichever one is on. */
async function activeDisplayId(): Promise<string> {
  const out = await adb("shell", "dumpsys", "display");
  for (const line of out.split("\n")) {
    if (!line.includes("mBaseDisplayInfo=") || !line.includes("state ON")) continue;
    const id = line.match(/uniqueId "local:(\d+)"/)?.[1];
    if (id) return id;
  }
  throw new Error("No display is on");
}

export async function screenshot(name: string) {
  const display = await activeDisplayId();
  await adb("shell", "screencap", "-d", display, "-p", "/sdcard/bs-shot.png");
  await adb("pull", "/sdcard/bs-shot.png", join(ARTIFACTS, `${name}.png`));
  console.log(`screenshot ${name}.png`);
}

export async function folded(): Promise<boolean> {
  return (await adb("shell", "cmd", "device_state", "state")).includes("CLOSED");
}

export async function screenSize(): Promise<[number, number]> {
  const out = await adb("shell", "wm", "size");
  const override = out.match(/Override size: (\d+)x(\d+)/) ?? out.match(/Physical size: (\d+)x(\d+)/);
  return [Number(override![1]), Number(override![2])];
}

/** screenrecord stops at 180s, so long runs record in segments. */
export class Recorder {
  private segment = 0;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private files: string[] = [];
  display: string | null = null;

  async begin() {
    this.display = await activeDisplayId();
    this.start();
  }

  start() {
    const file = `/sdcard/bs-rec-${this.segment++}.mp4`;
    this.files.push(file);
    this.proc = Bun.spawn(["adb", "-s", SERIAL, "shell", "screenrecord", "--display-id", this.display ?? "0", "--bit-rate", "8000000", "--time-limit", "175", file], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  async rotate() {
    await this.stop();
    this.start();
  }

  async stop() {
    if (!this.proc) return;
    await adb("shell", "pkill", "-INT", "screenrecord").catch(() => "");
    await this.proc.exited;
    this.proc = null;
    await sleep(1200);
  }

  async pull(): Promise<string[]> {
    const local: string[] = [];
    for (const [index, file] of this.files.entries()) {
      const target = join(ARTIFACTS, `recording-${index}.mp4`);
      await adb("pull", file, target);
      await adb("shell", "rm", file).catch(() => "");
      local.push(target);
    }
    return local;
  }
}

/** Scrolls the main list until the view is visible above the tab bar. */
export async function reveal(selector: Selector, maxSwipes = 6): Promise<Node> {
  const [width, height] = await screenSize();
  for (let attempt = 0; attempt <= maxSwipes; attempt++) {
    const node = await find(selector);
    if (node && (node.bounds[1] + node.bounds[3]) / 2 < height * 0.9 && (node.bounds[1] + node.bounds[3]) / 2 > height * 0.12) return node;
    const direction = node && node.bounds[1] <= height * 0.1 ? -1 : 1;
    await swipe([width / 2, height * (direction > 0 ? 0.7 : 0.35)], [width / 2, height * (direction > 0 ? 0.4 : 0.65)], 300);
  }
  throw new Error(`Could not reveal ${JSON.stringify(selector)}`);
}

export async function tapRevealed(selector: Selector, maxSwipes?: number) {
  const node = await reveal(selector, maxSwipes);
  const [x, y] = center(node);
  await tapAt(x, y);
  await sleep(450);
}
